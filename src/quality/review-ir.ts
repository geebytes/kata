/**
 * The review IR and the candidate freeze: the identity a verdict binds to.
 *
 * Extracted from `adversarial.ts` when the round-shaped route was deleted, because this part **outlives** that route. The
 * freeze identity covers content the declared manifest cannot see (a change committed outside the declaration), and the
 * gates that still decide whether a change may be archived read it (`distill-gates`), as does the user-choice gate and the
 * review-approval binding in the orchestrator. Deleting the route that produced records must not delete the ability to
 * tell which candidate a judgment was about.
 *
 * The budget constants moved with the freeze because the freeze hashes the executor boundary, which is derived from the
 * budget: two modules sharing one default and one derivation is the shape this repository keeps removing.
 */
import { hashContent } from '../core/hash.js';
import { defaultPolicy } from '../kernel/policy.js';
import { requiredCapabilitiesForNode, type ExecutionNode } from './review-execution.js';
import { freezeCandidate, type CandidateFreeze } from './recertification.js';
import type { EvidenceEnvelope } from './evidence.js';
import type { TaskRecord } from '../core/task.js';
import type { TaskRevision } from '../workflow/revision.js';

/** The node an independent pass certifies. Defined here because the freeze identity is per node. */
export type AdversarialNode = 'verify' | 'review';
/** Why the gate refused a record; the vocabulary is shared with the reader that words it. */
export type AdversarialGateReason = string;

/**
 * One acceptance criterion as the gate knows it, with the checks that answer it (§1.3.4 item 1).
 *
 * `asserts` is the load-bearing field: the reviewer's most valuable question is whether the evidence actually tests the
 * criterion, and that cannot be answered from a check id alone — it needs what the assertion is claiming to prove.
 */
export interface AcceptanceContractEntry {
    id: string;
    statement: string;
    checks: Array<{ id: string; command: string; selector?: string; asserts: string }>;
}

export interface AdversarialBriefInput {
    taskId: string;
    node: AdversarialNode;
    revisionId: string | null;
    /**
     * What a previous round read, addressed by content — the ledger's **live** half only. A fact whose hash no longer matches
     * is not offered, because it describes a version of the file that no longer exists; the changed paths are named instead,
     * so "read before, changed since" is visible rather than silent.
     */
    deliveredFacts?: Array<{ path: string; sha256: string; note: string }>;
    deliveredFactsChanged?: string[];
    acceptance: Array<{ id?: string; statement?: string }>;
    evidence: EvidenceEnvelope[];
    ownedPaths: string[];
    /**
     * Where each piece of sealed evidence lives on disk, so the reviewer can *read* it (M1).
     *
     * Without this the reviewer re-derives what the gate already recorded: logs sit in `.kata/evidence/*.json` and were
     * never pointed at, so a pass would spend minutes re-running a check whose green result is already sealed against this
     * very revision.
     */
    evidencePaths?: Array<{ id: string; checkId?: string; path: string }>;
    /** The task's real checks from config, so the brief can name what must not be re-run. */
    declaredChecks?: Array<{ id: string; name: string }>;
    /**
    /**
     * The acceptance contract as data (§1.3.4 item 1): each criterion with the checks that answer it, the selector each
     * check runs, and what the assertion actually asserts.
     *
     * This is deliberately **present in a cold round**, unlike the author's claims. A cold round withholds the author's
     * *interpretation*; the criteria, checks and assertions are the gate's own contract, and a reviewer that has to
     * reconstruct them from the diff pays orientation cost on every round while asking a weaker question ("what does this
     * code do" instead of "does this evidence test this criterion"). Inspection methodology withholds framing, not
     * requirements — a Fagan reviewer without the checklist is not independent, only uninformed.
     */
    acceptanceContract?: AcceptanceContractEntry[];
    /**
     * Criteria this narrowed round does **not** re-check, named rather than silently omitted (§7.3).
     *
     * A targeted round carries only the impacted criteria; without this list a reader cannot distinguish "carried over
     * from a prior certification" from "forgotten". The distinction is the whole safety argument for narrowing.
     */
    carriedOverCriterionIds?: string[];
    /**
     * How this round is framed (M2): `verify` lists the author's claims and requires the whole delta to be walked;
     * `cold` lists **none**, and asks the reviewer to decide what to attack.
     *
     * Deploy-time decision, recorded here rather than in a design note: **the platform rotates the default, and refuses
     * to rotate into `cold` while the task has an open `blocking`/`major` finding** — rotation must never make a round
     * blinder to a known defect it has not yet repaired. A `cold` round is otherwise slower and less predictable on
     * purpose, because the largest defect of the measured session was in a file the author had not mentioned.
     */
    mode?: 'verify' | 'cold';
    /** Why this mode was chosen, written into the brief so the rotation is never silent. */
    modeReason?: string;
    /** Why this round has the scope it has (C4), rendered into the brief so an unexamined area is never read as verified. */
    scopeReason?: string;
    /**
     * Where to start reading (M4): the changed paths and their collaborators from the acceptance matrix.
     *
     * Every pass spends its first 10–20 reads orienting itself. The brief already knows the changed paths from F2 and the
     * matrix knows which files implement the same acceptance criteria, so the orientation can be handed over instead of
     * rediscovered. It is framed as a **starting set, not a boundary** — the sentence that gives it says so.
     */
    readingSet?: Array<{ path: string; why: string; lines?: number | null }>;
    reviewFindings?: Array<{ severity?: string; message?: string }>;
    /**
     * The change surface since a previous pass (F2 of the finding-lifecycle design): when present, the brief asks the
     * reviewer to re-derive only the conclusions that touch these paths, and states why that is sufficient — the paths
     * are the *complete* difference between the two revisions, checked mechanically by the gate.
     */
    delta?: {
        from: string;
        /**
         * When the base revision was sealed. AC-5's second half: the sealed evidence a brief offers is only worth reading
         * if it was produced **after** the base — measured (`wcc3-f7`), the envelopes offered to a delta round were written
         * before the delta existed, so they described a revision the round is not about.
         */
        sinceAt?: string;
        changedPaths: string[];
        added: string[];
        modified: string[];
        removed: string[];
        attempts?: Array<{ hypothesis?: string; method?: string; outcome?: string; toolUses?: number }>;
        /**
         * How many prior attempts the delta withheld because their hypothesis touched no changed path.
         *
         * **Counted rather than dropped silently**, because a shortened list reads as "this is all" — the same discipline as
         * telemetry that reports what it could not measure rather than zero.
         */
        attemptsWithheld?: number;
        /** How many prior findings the delta withheld because their path did not change. Counted, never dropped silently. */
        findingsWithheld?: number;
        findings?: Array<{ id: string; severity: string; message: string; disposition: string }>;
    };
    /**
     * Findings that already have a disposition, from every record the task keeps.
     *
     * The design's I2: a review that is honestly reported is not the same as one with an empty findings list, and a
     * reviewer that cannot see what was already decided re-reports it as new — a whole review round spent on a decision
     * somebody already made.
     */
    knownFindings?: Array<{ id: string; severity: string; message: string; disposition: string; dispositionReason?: string; dispositionBy?: string; source: string }>;
    /**
     * Prior findings grouped by class, with each class's count and disposition.
     *
     * Cheap, and it does not lower the falsification bar. A reviewer who re-derives a class an earlier round already
     * named and a repair already addressed spends the pass on the wrong question — three consecutive rounds of one
     * measured change landed on the same record-accuracy class that way, each paying the full cost to find something
     * already fixed. A reviewer who still believes a repaired class is open reports it as a finding *against the
     * decision*, which is the rule the dispositions already follow.
     */
    findingHistory?: Array<{ class: string; severity: string; id: string; message: string; disposition: string }>;
    /** An optional explanation of how `class` was determined, printed with the table so the grouping is auditable. */
    findingHistoryNote?: string;
    /**
     * How many open findings the delta withheld from the class history because their path did not change.
     *
     * **Counted rather than dropped silently**: a shortened list reads as a complete one, which is the discipline the attempts
     * and delta-findings filters already follow — this one did not, and was the only filter on this line that did not say what
     * it did.
     */
    findingHistoryWithheld?: number;
}

/** The review input as data, compiled from the same source as the text (§3.3). */
export interface ReviewIr {
    node: AdversarialBriefInput['node'];
    revisionId: string | null;
    criteria: Array<{ id: string; statement: string }>;
    scope: { kind: 'full'; paths: string[] } | { kind: 'delta'; from: string; changedPaths: string[] };
    /**
     * Criteria a narrowed round does **not** re-check, carried over from the prior certification.
     *
     * On the IR because it is a fact about the remit, not prose: an executor reading this input must be able to tell
     * "deliberately not re-checked" from "missing", and a receipt binds to the IR hash — so the carried-over set has to
     * be inside the thing it binds to.
     */
    carriedOverCriterionIds: string[];
    acceptanceContract: AcceptanceContractEntry[];
    declaredChecks: Array<{ id: string; name: string }>;
    evidenceIds: string[];
    budget: ReviewBudget;
    resultSchemaVersion: number;
    /** Content-addressed over everything above, so a receipt can bind to *this* input. */
    hash: string;
}

/**
 * Compile the immutable review input.
 *
 * The Markdown brief remains the human-readable artifact; this is what an executor is driven by, and it is compiled from
 * the **same** `AdversarialBriefInput` the text is rendered from — so the two cannot disagree, which field-by-field
 * assembly at render time could not guarantee. `hash` addresses the whole object, so a receipt binds to the exact input a
 * pass answered rather than to a revision id that a later re-seal can move.
 */
export function compileReviewIr(input: AdversarialBriefInput): ReviewIr {
    const scopePaths = input.delta
        ? [...new Set([...input.delta.added, ...input.delta.modified, ...input.delta.removed])]
        : [...input.ownedPaths];
    const body = {
        node: input.node,
        revisionId: input.revisionId,
        carriedOverCriterionIds: [...(input.carriedOverCriterionIds ?? [])],
        // §1.3.4 item 1: the criteria and their checks are the gate's contract, so they ride on the IR an executor
        // receives — including in a cold round, where the author's claims are withheld but the requirements are not.
        acceptanceContract: (input.acceptanceContract ?? []).map((entry) => ({
            id: entry.id,
            statement: entry.statement,
            checks: entry.checks.map((check) => ({
                id: check.id,
                command: check.command,
                ...(check.selector ? { selector: check.selector } : {}),
                asserts: check.asserts,
            })),
        })),
        criteria: input.acceptance.map((criterion) => ({ id: criterion.id ?? '', statement: criterion.statement ?? '' })),
        scope: (input.delta
            ? { kind: 'delta' as const, from: input.delta.from, changedPaths: scopePaths }
            : { kind: 'full' as const, paths: scopePaths }),
        declaredChecks: (input.declaredChecks ?? []).map((check) => ({ id: check.id, name: check.name })),
        evidenceIds: input.evidence.map((item) => item.id),
        budget: { ...DEFAULT_REVIEW_BUDGET },
        resultSchemaVersion: 1,
    };
    return { ...body, hash: hashContent(JSON.stringify(body)) };
}

/**
 * The freeze identity the current candidate would be certified under (§7.4), or `undefined` when it cannot be derived.
 *
 * Deriving it here rather than reading a stored hash is what makes the comparison meaningful: the record carries the
 * identity of the candidate it certified, and this is the identity of the candidate in hand. When the task or revision
 * cannot be read the gate falls back to the older binding instead of refusing — an underivable freeze is a gap in the
 * platform's own state, not a contradiction in the pass.
 */
export function currentCandidateFreezeHash(
    task: TaskRecord | null,
    revision: TaskRevision | null,
    node: AdversarialNode,
): string | undefined {
    // `task` and `revision` are the facts the gate already read — re-reading them here would re-derive state the gate
    // deliberately stopped re-deriving. The value returned is *this* candidate's identity; the record's own stored
    // identity is what it is compared against, never returned.
    if (!task) return undefined;
    const ir = compileReviewIr({
        taskId: task.id, node, revisionId: revision?.id ?? null, acceptance: task.acceptance ?? [], evidence: [],
        ownedPaths: revision?.ownedPaths ?? task.ownedPaths ?? [],
    });
    return candidateFreezeForBrief(task, revision, node, ir).hash;
}

/**
 * The freeze identity of the task's current candidate, read from the repository (§7.4).
 *
 * Exposed so a record writer stamps the same identity the gate will later recompute — one derivation, two consumers, so
 * the two cannot disagree about what the pass answered.
 */
export async function candidateFreezeHashFor(root: string, taskId: string, node: AdversarialNode): Promise<string | undefined> {
    const { readTask } = await import('../core/task.js');
    const { readCurrentTaskRevision } = await import('../workflow/revision.js');
    const task = await readTask(root, taskId).catch(() => null);
    if (!task) return undefined;
    const revision = await readCurrentTaskRevision(root, taskId).catch(() => null);
    return currentCandidateFreezeHash(task, revision, node);
}

/**
 * The hard resource envelope for one review round (§3.2.2).
 *
 * Defaults are the ones the design measured against, and they are exported so a caller can raise them for a genuinely
 * larger round — the point is not the numbers, it is that they are numbers. `maxHypotheses` is the semantic bound the
 * brief has always claimed ("aim for at most six attempts"); the other three are the ones that were prose and are now
 * machine-readable, so an executor can enforce them and a reviewer can report truthfully which one it hit.
 */
export interface ReviewBudget {
    maxHypotheses: number;
    maxToolCalls: number;
    maxOutputBytes: number;
    maxWallMs: number;
}

/**
 * What a review pass on this repository has actually cost. Recorded because the envelope's purpose is to stop a runaway
 * round — and a limit **below** the cost of a real round does not stop a runaway, it refuses honest work.
 *
 * The previous values were lifted from the design's illustrative JSON block (`maxToolCalls: 48`, `maxWallMs: 900000`)
 * and never calibrated. Measured consequence (2026-09-22): an independent pass executed honestly under that envelope was
 * killed at the wall limit after 15 minutes having made **70 tool calls** over 32 turns, still working — both limits sat
 * below the round they were bounding, and `budget_exhausted` is a refused verdict, so a strict review was structurally
 * impossible here. Every number below is measured; none is chosen.
 */
export const MEASURED_REVIEW_PASS_COST = {
    /** Slowest independent pass recorded on this repository: 2,627 s (`review-record-integrity`, 2026-09-21). */
    slowestWallMs: 2_627_000,
    /** Most tool calls one recorded pass made: 143. */
    mostToolCalls: 143,
    /**
     * Payload bytes a single tool call returned, measured on a four-step read/grep/find pass (2026-09-22).
     *
     * A **lower** bound: the probe's reads were small files, so a pass reading large sources returns more per call.
     */
    bytesPerToolCall: 5_339,
    /**
     * Payload a whole pass produced, measured on a real independent pass killed at the old wall limit (2026-09-22):
     * 43,128,787 bytes of executor event stream. An **upper** bound on tool output, because the stream also carries
     * streaming text.
     */
    largestPassPayloadBytes: 43_128_787,
};

/**
 * Headroom applied over a measured cost.
 *
 * A limit set *at* the measured value refuses the very next pass of the same size, so a ceiling needs room. The factor
 * is a judgement and is stated as one; the measurements it multiplies are not.
 */
export const REVIEW_HEADROOM = 1.5;

/**
 * The default envelope, derived from `MEASURED_REVIEW_PASS_COST` rather than restated.
 *
 * Two deliberate asymmetries, both stated so they are not read as oversights:
 *
 *  - `maxHypotheses` is **not** a resource limit. It is the semantic bound the brief has always claimed, and a pass that
 *    needs more hypotheses is a pass that should close some, not one that needs a bigger number.
 *  - `maxOutputBytes` is derived from the **upper** bound (a whole pass) while the others use their own measurement.
 *    Where a limit can bind too early the safe side is the larger base, and the smaller per-call measurement is a lower
 *    bound from small reads. Its job is runaway prevention; the wall and call limits bind first.
 */
export const DEFAULT_REVIEW_BUDGET: ReviewBudget = {
    maxHypotheses: 6,
    maxToolCalls: Math.ceil(MEASURED_REVIEW_PASS_COST.mostToolCalls * REVIEW_HEADROOM),
    maxOutputBytes: Math.ceil(MEASURED_REVIEW_PASS_COST.largestPassPayloadBytes * REVIEW_HEADROOM),
    // **The wall clock is read from the policy, not derived a second time** (`the two-budget finding`). This constant and
    // `kernel/policy.budgets.maxWallMs` were two numbers for one fact with no comparison between them, and the two paths
    // used different ones: a ledger's `budget_exhausted` came from the policy while what actually bounded a run was this.
    maxWallMs: defaultPolicy().budgets.maxWallMs,
};

/** Constructs the repository-side half of a formal certification from facts already read to render the brief. */
export function candidateFreezeForBrief(task: TaskRecord, revision: TaskRevision | null, node: AdversarialNode, ir: ReviewIr): CandidateFreeze {
    const rows = task.acceptanceMatrix?.rows ?? [];
    const criterionPaths = Object.fromEntries(rows.map((row) => [row.acceptanceId, [...row.implementationPaths]]));
    const reviewedPaths = rows.length > 0
        ? [...new Set(rows.flatMap((row) => row.implementationPaths))].sort()
        : [...(revision?.ownedPaths ?? task.ownedPaths ?? [])].sort();
    return freezeCandidate({
        contentDigests: { ...(revision?.contentDigests ?? revision?.pathDigests ?? {}) },
        acceptanceHash: hashContent(JSON.stringify({ acceptance: task.acceptance, matrix: task.acceptanceMatrix ?? null })),
        instrumentHash: hashContent(JSON.stringify({
            instruments: task.instruments ?? [],
            rows: rows.map((row) => ({ acceptanceId: row.acceptanceId, testPaths: row.testPaths, evidence: row.evidence })),
        })),
        reviewPolicyHash: hashContent(JSON.stringify({ node, resultSchemaVersion: ir.resultSchemaVersion })),
        executorBoundaryHash: hashContent(JSON.stringify({
            budget: DEFAULT_REVIEW_BUDGET,
            capabilities: requiredCapabilitiesForNode(node as ExecutionNode),
        })),
        reviewIrHash: ir.hash,
        reviewedPaths,
        criterionPaths,
        evidenceByCriterion: Object.fromEntries(rows.map((row) => [row.acceptanceId, hashContent(JSON.stringify(row.evidence))])),
    });
}
