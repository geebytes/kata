import { readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { hashContent } from '../core/hash.js';
import { adversarialReviewPath, evidenceDir } from '../core/layout.js';
import { readValidatedOptional, validate } from '../core/schema.js';
import type { EvidenceEnvelope } from './evidence.js';

/**
 * The independent adversarial pass.
 *
 * Verify and review ask the same author's context whether the change is sound, which is the weakest possible way to
 * ask: the context that produced the implementation shares its assumptions, its blind spots and its evidence
 * interpretation. This mechanism makes each of those two nodes answer to a *different* context: kata renders a
 * self-contained brief, the host runs it in a clean-context subagent, and the structured result comes back bound to the
 * sealed revision and to the brief it was given.
 *
 * What kata can and cannot do here is worth being precise about. Kata is a CLI: it cannot start a subagent itself, and
 * it cannot inspect the host's session. So it does three things it can be held to — it renders the brief, it validates
 * the recorded result against the revision and the brief hash, and it refuses to let the node pass without one (or
 * without an explicit, recorded waiver). That the pass really ran in a fresh context is attested by the executing agent
 * (`executedInFreshContext`, `contextNote`), exactly as `--confirm-host-model` is.
 */

export const adversarialNodes = ['verify', 'review'] as const;
export type AdversarialNode = (typeof adversarialNodes)[number];

export interface AdversarialAttempt {
    hypothesis: string;
    method: string;
    outcome: 'refuted' | 'confirmed' | 'inconclusive';
    evidence?: string;
}

export interface AdversarialFinding {
    id: string;
    taskId: string;
    acceptanceId?: string;
    severity: 'blocking' | 'major' | 'minor' | 'nit';
    message: string;
    path?: string;
    /**
     * What has been decided about this finding (F1): `open` when omitted.
     *
     * Held on the record that reported the finding, which is why `writeAdversarialRecord` carries a decision forward when
     * a later pass replaces that record — otherwise the next pass resurrects every deferral, which is exactly what
     * happened the first time this was used.
     */
    disposition?: 'open' | 'fixed' | 'deferred' | 'accepted';
    dispositionReason?: string;
    dispositionBy?: string;
    dispositionAt?: string;
}

export interface AdversarialRecord {
    node: AdversarialNode;
    status: 'recorded' | 'waived';
    revisionId: string;
    /**
     * The sealed revision's content identity, stamped by kata when the pass is recorded.
     *
     * `revisionId` alone made a re-seal of the same content expire the pass: sealing again issues a new id (the id is
     * derived from the manifest hash *and* the check ids), so the conclusion had to be paid for twice even though the
     * artefact had not changed. The manifest hash is what the review is actually about.
     */
    manifestHash?: string;
    createdAt: string;
    executedInFreshContext?: boolean;
    contextNote?: string;
    briefSha256?: string;
    verdict?: 'no_defect_found' | 'defects_found' | 'inconclusive';
    executedBy?: string;
    attempts?: AdversarialAttempt[];
    findings?: AdversarialFinding[];
    /**
     * How many of this pass's findings the previous repair caused or left uncovered (design §F3).
     *
     * Recorded by the reviewer, because only the reviewer knows whether a defect is new or a consequence of the last
     * change — and recorded at all so that "fix one, grow two" is a number in the record rather than an impression.
     */
    findingOrigins?: { causedByPreviousRepair: number; note?: string };
    /**
     * What this pass covered: everything, or everything with only the changed paths re-derived (design §F2.3). A delta
     * scope is *verified* by the gate against the recorded digests, never taken on trust.
     */
    scope?: { kind: 'full' | 'delta'; from?: string; changedPaths?: string[] };
    /** For a delta pass: the manifest hash whose change surface it measured. */
    baseManifestHash?: string;
    /**
     * How long the pass took, reported by whoever ran it.
     *
     * The design's §11 admitted the saving had never been measured. It cannot be measured from outside — the pass is an
     * agent's wall clock — so the record carries it, and `status` compares a delta pass against the full pass it
     * narrowed. A self-reported number is still a number, and the design's whole premise is that it was invisible.
     */
    elapsedMs?: number;
    /**
     * How many tool calls the pass made, reported by the executor.
     *
     * The design measured the cost of a pass as two terms — running things, and the reviewer's own turn loop — and found
     * the turn loop dominant (5–12 of the ~16 median minutes). `elapsedMs` alone cannot show which term moved; this is the
     * first half of the second term to become visible in the record.
     */
    toolUses?: number;
    /** How this round was framed (M2): `verify` (the author's claims) or `cold` (no claims). */
    mode?: 'verify' | 'cold';
    waivedReason?: string;
    waivedBy?: string;
}

export interface AdversarialBriefInput {
    taskId: string;
    node: AdversarialNode;
    revisionId: string | null;
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
    /**
     * Where to start reading (M4): the changed paths and their collaborators from the acceptance matrix.
     *
     * Every pass spends its first 10–20 reads orienting itself. The brief already knows the changed paths from F2 and the
     * matrix knows which files implement the same acceptance criteria, so the orientation can be handed over instead of
     * rediscovered. It is framed as a **starting set, not a boundary** — the sentence that gives it says so.
     */
    readingSet?: Array<{ path: string; why: string }>;
    reviewFindings?: Array<{ severity?: string; message?: string }>;
    /**
     * The change surface since a previous pass (F2 of the finding-lifecycle design): when present, the brief asks the
     * reviewer to re-derive only the conclusions that touch these paths, and states why that is sufficient — the paths
     * are the *complete* difference between the two revisions, checked mechanically by the gate.
     */
    delta?: {
        from: string;
        changedPaths: string[];
        added: string[];
        modified: string[];
        removed: string[];
        attempts?: Array<{ hypothesis?: string; method?: string; outcome?: string }>;
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
}

/**
 * The brief the adversarial reviewer receives. It is self-contained on purpose: a clean context has none of the
 * author's conversation, so everything the attempt needs — the claims, the recorded evidence, the paths under review,
 * and the exact result shape — is in the text.
 */
export function renderAdversarialBrief(input: AdversarialBriefInput): string {
    const mode = input.mode ?? 'verify';
    const claims = input.acceptance.length > 0
        ? input.acceptance.map((criterion) => `- ${criterion.id ?? '(no id)'}: ${criterion.statement ?? ''}`).join('\n')
        : '- (this task declares no acceptance criteria)';

    const evidence = input.evidence.length > 0
        ? input.evidence
            .map((item) => `- ${item.id} | kind=${item.kind} | exit=${item.exitCode} | command=${item.command}${item.checkId ? ` | check=${item.checkId}` : ''}`)
            .join('\n')
        : '- (no evidence has been recorded for this revision)';

    const declared = new Set((input.declaredChecks ?? []).map((check) => check.name));
    const sealedEvidence = input.evidence.length > 0
        ? input.evidence
            .map((item) => {
                const where = (input.evidencePaths ?? []).find((entry) => entry.id === item.id)?.path;
                const worthReading = item.checkId && declared.has(item.checkId);
                return `- ${item.checkId ?? item.id} | exit=${item.exitCode} | ${item.command}${where ? ` | read: ${where}` : ''}${worthReading ? ' | **this is a project-declared check: read its result, do not re-run it**' : ''}`;
            })
            .join('\n')
        : '- (nothing is sealed yet, so there is nothing to read)';

    const findings = (input.reviewFindings ?? []).length > 0
        ? (input.reviewFindings ?? []).map((finding) => `- ${finding.severity ?? 'unknown'}: ${finding.message ?? ''}`).join('\n')
        : '- (none recorded yet)';

    const decided = (input.knownFindings ?? []).filter((finding) => finding.disposition !== 'open');
    const known = decided.length > 0
        ? decided
            .map((finding) => `- ${finding.severity} ${finding.id} [${finding.disposition}${finding.dispositionReason ? `: ${finding.dispositionReason}` : ''}${finding.dispositionBy ? ` by ${finding.dispositionBy}` : ''}] (${finding.source}): ${finding.message}`)
            .join('\n')
        : '- (nothing has been dispositioned for this task)';

    const readingSet = (input.readingSet ?? []).length > 0
        ? (input.readingSet ?? []).map((entry) => `- ${entry.path} — ${entry.why}`).join('\n')
        : '- (the brief cannot name a starting set for this task; explore freely)';

    const deltaSection = input.delta
        ? `## This is a delta pass

Sealed revision ${input.revisionId ?? '(none)'} differs from ${input.delta.from} only in the paths listed below — that is
the **complete** difference, and the gate verifies the claim before accepting this pass. Everything else was reviewed by an
earlier pass and has not changed since.

Added:
${input.delta.added.length > 0 ? input.delta.added.map((path) => `- ${path}`).join('\n') : '- (none)'}

Modified:
${input.delta.modified.length > 0 ? input.delta.modified.map((path) => `- ${path}`).join('\n') : '- (none)'}

Removed:
${input.delta.removed.length > 0 ? input.delta.removed.map((path) => `- ${path}`).join('\n') : '- (none)'}

What to re-derive:

- For every claim that touches one of those paths, form and run a falsification attempt as usual;
- for a claim whose earlier conclusion rests on a path that **has changed**, re-check whether the conclusion still holds
  — the code it rested on is not the code it was derived from;
- a claim that was refuted earlier, on paths that did **not** change, does not need to be re-proved. If you have a reason
  to doubt it anyway, say so — that is a finding, and it is welcome.

Earlier attempts, for reference rather than re-execution:
${(input.delta.attempts ?? []).length > 0
    ? (input.delta.attempts ?? []).map((attempt) => `- ${attempt.hypothesis ?? '(no hypothesis)'} → ${attempt.outcome ?? '(no outcome)'} (${attempt.method ?? 'no method'})`).join('\n')
    : '- (none recorded)'}

Earlier findings and what was decided about them:
${(input.delta.findings ?? []).length > 0
    ? (input.delta.findings ?? []).map((finding) => `- ${finding.severity} ${finding.id} [${finding.disposition}]: ${finding.message}`).join('\n')
    : '- (none recorded)'}

`
        : '';

    return `# Independent adversarial review — ${input.node} node

You are an independent adversarial reviewer. **You have no prior context.** Everything you are allowed to assume is in
this brief; do not continue anyone else's reasoning, and do not trust the claims in it — the point of this pass is that
you try to break them.

Task: ${input.taskId}
Node under review: ${input.node}
Round framing: ${mode}${input.modeReason ? ` — ${input.modeReason}` : ''}
Sealed revision: ${input.revisionId ?? '(none sealed yet)'}
Paths under review: ${input.ownedPaths.length > 0 ? input.ownedPaths.join(', ') : '(none declared)'}

## The claims under test

${mode === 'cold'
    ? `**This is a cold round: no author claims are given.** Nobody has framed the search for you — decide what to attack from
the acceptance criteria, the change, the sealed evidence and the previous pass's attempts below. The author's framing is
deliberately withheld, because a reviewer asked to check someone's claims checks only those claims.`
    : claims}

## Evidence the author recorded

${evidence}

## Sealed evidence you may read instead of re-running

The gate already ran these against **this** revision, and their envelopes are on disk — read them rather than paying for
them twice:

${sealedEvidence}

**Do not re-run a check whose sealed evidence already covers this revision** — the full suite above all. A green suite
result is schedule-dependent luck; the sealed one is bound to the revision you are reviewing, and re-running it costs
minutes of your own turns while proving nothing the gate has not already recorded.

*Exception, narrow and explicit:* when this round's focus **is** suite-global behaviour (order dependence, worker
isolation, a claim about the suite as a whole), say so and run it once. If you believe the sealed evidence is wrong, say
so and show why — that is a finding, not a reason to re-run it.

*What this costs, stated rather than hidden:* you can no longer independently falsify "the whole suite is green" by
running it. You may inspect it, and the gate re-runs it at seal time on this revision — but a global claim's independence
drops from *re-derived* to *inspected*, and that is the trade.

## Where to start reading

A starting set, **not a boundary** — reading beyond it is expected whenever a claim reaches further than these paths:

${readingSet}

## Writing as you go

You do **not** have to hold everything until the end. A pass that dies mid-run keeps whatever it already wrote:

- record a batch of work as you finish it — one line per **batch**, in the same invocation that ran the check:
  \`\`\`bash
  kata-cli adversarial note --change <task-id> --node ${input.node} --from-file <line.json>
  \`\`\`
  (\`{"hypothesis": "…", "method": "…", "outcome": "refuted|confirmed|inconclusive"}\`)
- report a finding the moment you confirm it, rather than in the final file:
  \`\`\`bash
  kata-cli adversarial finding add --change <task-id> --node ${input.node} --from-file <finding.json>
  \`\`\`
- \`record\` at the end seals the verdict and the revision binding. It is the conclusion, not the container.

**Batching rule, and it matters more than the feature:** one append per *batch of work*, never one per hypothesis. Every
separate invocation is a full turn of yours, and the turn loop is what this pass mostly costs — writing a line after every
thought would eat far more than a crashed pass ever loses.

## Pacing yourself

Independent commands belong in **one** invocation: run them together and read the outputs together. Every separate
invocation is a full turn of yours, and the turn loop — not the CPU — is what a pass mostly costs.

## Findings recorded so far

${findings}

## Already known, already decided — do not re-report these

${known}

If you believe one of those decisions is wrong, say so as a finding **against the decision**, with your reasoning: a
decision can be wrong, but re-reporting it as a new discovery wastes the pass and hides the fact that it was decided.

${deltaSection}## What to do

For each claim above, and for the change as a whole:

1. Read the actual repository — the implementation, its tests and the recorded evidence — rather than this brief.
${mode === 'cold' ? '2. Decide what to attack first. There is no claim list: form your own hypothesis about where this change is wrong, then falsify it.' : '2. Form at least one **falsification attempt per claim**: a specific way the claim could be false (a missing edge case,'}
   a test that passes for the wrong reason, an assertion that does not exercise the claim, an unhandled input, a
   regression outside the declared paths, a claim that only holds because the evidence is stale).
3. Run the attempt: execute the test, read the code path, construct the counterexample. Report what actually happened,
   not what you expect.
4. Report a finding for every defect you confirmed, with severity. A finding that says "looks fine" is not a finding.

## Rules

- You may read anything. You may write only new files needed for a counterexample's execution, and you must say so.
- Judge the claims against the repository and the recorded evidence, not against the author's summary of them.
- If you cannot falsify a claim, say \`refuted\` for that attempt — that is a real result, and the honest one.
- Do not report style preferences as defects. Severity: \`blocking\` (the claim is false), \`major\` (the claim holds only
  in narrower conditions than stated), \`minor\`, \`nit\`.

## Required result

Return exactly one JSON object, and nothing else:

\`\`\`json
{
  "node": "${input.node}",
  "status": "recorded",
  "revisionId": "${input.revisionId ?? ''}",
  "executedInFreshContext": true,
  "contextNote": "<how this pass ran in a context that did not author the change>",
  "briefSha256": "<the hash reported by the brief command>",
  "verdict": "no_defect_found | defects_found | inconclusive",
  "attempts": [
    { "hypothesis": "<what you tried to show was false>", "method": "<what you did>", "outcome": "refuted | confirmed | inconclusive", "evidence": "<the observed result>" }
  ],
  "findings": [
    { "id": "<stable id>", "taskId": "${input.taskId}", "severity": "blocking | major | minor | nit", "message": "<the defect and how you confirmed it>", "path": "<file>" }
  ],
  "createdAt": "<ISO timestamp>"
}
\`\`\`

Record it with:

\`\`\`bash
kata-cli adversarial record --change ${input.taskId} --node ${input.node} --from-file <path to the JSON>
\`\`\`
`;
}

export function adversarialBriefSha256(brief: string): string {
    return hashContent(brief);
}

export async function readAdversarialRecord(root: string, taskId: string, node: AdversarialNode): Promise<AdversarialRecord | null> {
    return readValidatedOptional<AdversarialRecord>('adversarial-review', adversarialReviewPath(root, taskId, node));
}

/**
 * The revision binding stamped onto a pass: which revision it answered, and what that revision's content is.
 *
 * Kata stamps both — `revisionId` from the caller, `manifestHash` from the sealed revision — because a verdict is about
 * content, and the id alone changes on a re-seal of unchanged content.
 */
async function currentRevisionManifest(root: string, taskId: string): Promise<{ revisionId: string; manifestHash: string }> {
    const { readCurrentTaskRevision } = await import('../workflow/revision.js');
    const revision = await readCurrentTaskRevision(root, taskId).catch(() => null);
    return {
        revisionId: revision?.id ?? 'unsealed',
        manifestHash: revision?.manifestHash ?? '',
    };
}

/**
 * Records one finding on the node's record as it is confirmed (K2).
 *
 * The proposal's §11: a pass has exactly one write point — the record at the end — so a crash leaves nothing. Findings are
 * the part of a pass's work that is worth keeping even when the verdict never arrives, so they land one at a time; `record`
 * then only has to seal the verdict and the revision binding.
 *
 * A record that does not exist yet is created as a draft: `status: 'recorded'` with no verdict, and the gate refuses it
 * exactly as it refuses a missing pass (no verdict is no conclusion). That keeps "partial" from ever reading as "passed".
 */
export async function addAdversarialFinding(
    root: string,
    taskId: string,
    node: AdversarialNode,
    finding: Record<string, unknown>,
): Promise<AdversarialFinding> {
    const candidate = {
        ...finding,
        taskId: (finding.taskId as string | undefined) ?? taskId,
    } as AdversarialFinding;
    if (!candidate.id) candidate.id = `finding-${randomUUID()}`;

    const existing = await readAdversarialRecord(root, taskId, node).catch(() => null);
    const revisionId = existing?.revisionId ?? (await currentRevisionManifest(root, taskId)).revisionId ?? 'unsealed';
    const draft: AdversarialRecord = existing ?? {
        node,
        status: 'recorded',
        revisionId,
        createdAt: new Date().toISOString(),
        attempts: [],
        findings: [],
        scope: { kind: 'full' },
    };
    const findings = [...(draft.findings ?? []).filter((entry) => entry.id !== candidate.id), candidate];
    await writeAdversarialRecord(root, taskId, { ...draft, findings });
    return candidate;
}

export async function writeAdversarialRecord(root: string, taskId: string, record: AdversarialRecord): Promise<AdversarialRecord> {
    const validated = validate<AdversarialRecord>('adversarial-review', record);
    const path = adversarialReviewPath(root, taskId, record.node);
    // The previous pass is snapshotted before it is replaced, so the comparison the design asked for (what did a delta
    // pass save against the full pass it narrowed?) has both sides. Without this the number is unrecoverable the moment
    // the record is overwritten — which is exactly why §11 could not be answered.
    try {
        const previous = JSON.parse(await readFile(path, 'utf8')) as {
            scope?: { kind?: string };
            elapsedMs?: number;
            createdAt?: string;
            findings?: Array<Record<string, unknown>>;
        };
        // D1: the dispositions live on this record, so replacing it resurrected every deferred finding and left its id
        // with nothing to defer. A decision is carried forward onto the finding of the same id when the new record does
        // not state one itself.
        const decided = new Map<string, Record<string, unknown>>();
        for (const finding of previous.findings ?? []) {
            if (finding.disposition && finding.disposition !== 'open') {
                decided.set(String(finding.id), {
                    disposition: finding.disposition,
                    ...(finding.dispositionReason ? { dispositionReason: finding.dispositionReason } : {}),
                    ...(finding.dispositionBy ? { dispositionBy: finding.dispositionBy } : {}),
                    ...(finding.dispositionAt ? { dispositionAt: finding.dispositionAt } : {}),
                });
            }
        }
        if (decided.size > 0) {
            for (const finding of record.findings ?? []) {
                if (finding.disposition && finding.disposition !== 'open') continue;
                const carried = decided.get(finding.id);
                if (carried) Object.assign(finding, carried);
            }
        }
        if (previous.elapsedMs || previous.scope?.kind === 'full') {
            const { mkdir } = await import('node:fs/promises');
            const { join } = await import('node:path');
            const directory = join(root, '.kata/tasks', taskId, 'passes');
            await mkdir(directory, { recursive: true });
            const stamp = previous.createdAt?.replace(/[:.]/g, '-') ?? `pass-${Date.now()}`;
            await writeFile(join(directory, `${record.node}-${stamp}.json`), `${JSON.stringify(previous, null, 2)}\n`, 'utf8');
        }
    } catch {
        // No previous record, or an unreadable one: nothing to snapshot, and replacing the record is still correct.
    }
    await writeFile(path, `${JSON.stringify(validated, null, 2)}\n`, 'utf8');
    return validated;
}

export type AdversarialGateReason =
    | 'missing'
    | 'no_revision'
    | 'stale_revision'
    | 'not_fresh_context'
    | 'brief_mismatch'
    | 'waived'
    /** A delta pass whose declared paths do not cover the change it claims to cover. */
    | 'delta_stale'
    /** A delta was asked for against a revision that records no per-path digests. */
    | 'delta_unavailable';

export interface AdversarialGateResult {
    satisfied: boolean;
    reason?: AdversarialGateReason;
    record?: AdversarialRecord;
    /** Findings the node must resolve, when the pass confirmed defects. */
    findings: AdversarialFinding[];
    /** Why a delta pass was refused: what the pass claimed to cover and what actually changed. */
    detail?: string;
    /**
     * What fixing a finding here would cost in re-verification (design §F3).
     *
     * The design's third problem: "fix one, grow two" was invisible because the marginal cost of a repair was never on
     * the same account as the value of the finding. This makes it explicit at the moment a reviewer is choosing what to
     * report and an implementer is choosing what to fix.
     */
    reverificationCost?: { passScope: 'delta' | 'full'; supersedesReceipt: boolean; reason: string };
}

/**
 * Whether a node may conclude.
 *
 * A recorded pass has to be about *this* revision, has to attest a fresh context, and has to have been run against the
 * brief kata renders now — a pass against an older brief was answering a different question. A waiver satisfies the
 * gate explicitly and is reported as such rather than hidden.
 */
/**
 * The delta check, applied before the content check: a pass that says "I re-derived only these paths" is accepted only
 * when those paths **are** the whole difference between the revision it reviewed and the revision it replaces.
 *
 * The gate cannot take the reviewer's word for the scope any more than it takes it for the verdict, so this recomputes
 * the change surface from the recorded digests. A delta whose declared set misses a changed path is `delta_stale` — a
 * refusal, not a narrowed review.
 */
export async function evaluateDeltaScope(
    root: string,
    taskId: string,
    record: AdversarialRecord | null,
    currentRevisionId: string | null,
): Promise<{ ok: true } | { ok: false; reason: 'delta_stale' | 'delta_unavailable'; detail: string }> {
    const scope = (record as AdversarialRecord & { scope?: { kind?: string; from?: string; changedPaths?: string[] } } | null)?.scope;
    if (!scope || scope.kind !== 'delta') return { ok: true };

    const { readTaskRevision, readCurrentTaskRevision } = await import('../workflow/revision.js');
    const { changeSurface, deltaCoversChange } = await import('./revision-delta.js');
    const base = scope.from ? await readTaskRevision(root, taskId, scope.from).catch(() => null) : null;
    if (!base) {
        return { ok: false, reason: 'delta_unavailable', detail: `the base revision '${scope.from ?? '(none)'}' is not recorded for this task` };
    }
    // Measure against the revision under review (the pass's own revision), falling back to what is sealed now.
    const current = (currentRevisionId ? await readTaskRevision(root, taskId, currentRevisionId).catch(() => null) : null)
        ?? await readCurrentTaskRevision(root, taskId);
    if (!current) return { ok: false, reason: 'delta_unavailable', detail: 'no current revision to compare against' };

    const surface = await changeSurface(root, base, current);
    if (surface.status === 'delta_unavailable') return { ok: false, reason: 'delta_unavailable', detail: surface.reason };
    if (surface.status === 'unchanged') return { ok: true };

    const declared = scope.changedPaths ?? [];
    const { covered, missing } = deltaCoversChange(declared, surface);
    if (!covered) {
        return {
            ok: false,
            reason: 'delta_stale',
            detail: `the delta covered ${declared.length} path(s) but ${missing.length} changed path(s) are missing from it: ${missing.join(', ')}`,
        };
    }
    return { ok: true };
}

/**
 * Which inputs a brief is allowed to be derived from (K3, and the rule D2 taught).
 *
 * "Bind the brief as issued" sounds like it needs a stored copy. It does not — it is a **property of the brief's inputs**.
 * The 2026-09-18 defect was that the brief embedded the disposition section *of the pass's own record*, so recording the
 * pass changed the text, and the gate's recomputation rejected the record it had just accepted.
 *
 * Now the brief derives only from state a pass cannot change, which makes re-deriving it an *identity* function. That is
 * exactly what lets a retry continue a partial pass: the same brief, the same `briefSha256`, even though a record was
 * written in between.
 *
 * The list is data so a reviewer of this code can see the whole input surface at once — and so a future addition that
 * brings in something volatile has to be added here, deliberately, next to the rule it would break.
 */
/**
 * Which framing the next round should use (M2), and why.
 *
 * The rule, decided here: **rotate by default**, because a task whose reviews always arrive in the author's framing only
 * ever has the author's blind spots examined. Two limits make the rotation safe rather than blind:
 *
 *   - an open `blocking`/`major` finding forces `verify`: a repair round must check the repair, and rotating into `cold`
 *     would let a known defect go unexamined simply because the coin came up that way;
 *   - the choice and its reason are written into the brief, so the rotation is never something the reader has to guess.
 */
export async function resolveBriefMode(
    root: string,
    taskId: string,
    node: AdversarialNode,
    requested?: 'verify' | 'cold',
): Promise<{ mode: 'verify' | 'cold'; reason: string }> {
    if (requested) return { mode: requested, reason: `requested explicitly (--mode ${requested})` };

    const open = (await import('./finding-disposition.js'))
        .unfixed(await (await import('./finding-disposition.js')).readTrackedFindings(root, taskId))
        .filter((finding) => finding.disposition === 'open' && (finding.severity === 'blocking' || finding.severity === 'major'));
    if (open.length > 0) {
        return { mode: 'verify', reason: `an open ${open[0].severity} finding (${open[0].id}) is unrepaired, so this round checks the repair rather than opening a new search` };
    }

    const previous = await readAdversarialRecord(root, taskId, node).catch(() => null);
    const previousMode = (previous as { mode?: string } | null)?.mode;
    const mode = previousMode === 'cold' ? 'verify' : 'cold';
    return {
        mode,
        reason: previousMode
            ? `the previous ${node} round was ${previousMode}; the task alternates so that not every round is framed by the author`
            : `this task has not run a ${node} round yet, so it opens with the independent framing`,
    };
}

export const BRIEF_DURABLE_INPUTS = [
    'task acceptance criteria',
    'the sealed revision and its owned-path digests',
    'recorded evidence envelopes',
    'the review record and its findings (durable)',
    "the project's declared checks",
    'the change surface since a base revision',
] as const;

/** Inputs a brief must never be derived from, because recording a pass rewrites them. */
export const BRIEF_VOLATILE_INPUTS = [
    'the adversarial record of the pass being recorded',
    'the dispositions it stores',
    'anything whose value changes between issuing and recording a pass',
] as const;

export function evaluateAdversarialGate(
    record: AdversarialRecord | null,
    input: { node: AdversarialNode; revisionId: string | null; manifestHash?: string | null; briefSha256: string },
): AdversarialGateResult {
    if (!input.revisionId) return { satisfied: false, reason: 'no_revision', findings: [] };
    if (!record) return { satisfied: false, reason: 'missing', findings: [] };
    // Binding: the same revision, or the same owned-path content under a new id (a re-seal that changed nothing).
    const sameRevision = record.revisionId === input.revisionId;
    const sameContent = Boolean(record.manifestHash) && record.manifestHash === input.manifestHash;
    if (!sameRevision && !sameContent) return { satisfied: false, reason: 'stale_revision', record, findings: [] };
    if (record.status === 'waived') return { satisfied: true, reason: 'waived', record, findings: [] };
    // A short-circuit for the shape the gate requires beyond the schema: a recorded pass needs its attestation, its
    // brief and at least one attempt, or it has not demonstrated anything.
    if (record.executedInFreshContext !== true) return { satisfied: false, reason: 'not_fresh_context', record, findings: [] };
    if (record.briefSha256 !== input.briefSha256) return { satisfied: false, reason: 'brief_mismatch', record, findings: [] };
    if (!record.attempts || record.attempts.length === 0) return { satisfied: false, reason: 'brief_mismatch', record, findings: [] };

    // The pass ran and is binding: confirmed defects travel with it, and the node that receives them must resolve them.
    return { satisfied: true, record, findings: record.findings ?? [] };
}

/** The findings an adversarial pass confirmed that must be resolved before the node passes. */
export function blockingAdversarialFindings(record: AdversarialRecord | null): AdversarialFinding[] {
    if (!record || record.status !== 'recorded') return [];
    return (record.findings ?? []).filter((finding) => finding.severity === 'blocking' || finding.severity === 'major');
}

export function adversarialReasonFor(reason: AdversarialGateReason | undefined): string {
    switch (reason) {
        case 'missing': return 'No independent adversarial pass has been recorded for this revision.';
        case 'no_revision': return 'No revision is sealed yet, so there is nothing to attack independently.';
        case 'stale_revision': return 'The recorded adversarial pass is about a different revision.';
        case 'not_fresh_context': return 'The recorded adversarial pass does not attest a fresh context.';
        case 'brief_mismatch': return 'The recorded adversarial pass answered a different brief.';
        case 'waived': return 'The independent adversarial pass was explicitly waived.';
        case 'delta_stale': return 'The pass is a delta, and the paths it declared do not cover everything that changed since its base revision — widen the range or run a full pass.';
        case 'delta_unavailable': return 'A delta pass was recorded against a revision that has no per-path digests, so the change surface cannot be verified; run a full pass.';
        default: return 'The independent adversarial pass is not satisfied.';
    }
}

/** Reads the brief file the host was asked to feed to its subagent, for callers that recorded one. */
export async function readBriefFile(path: string): Promise<string> {
    return readFile(path, 'utf8');
}

/**
 * The brief for a node, together with the hash the recorded result must carry. Reads the task's acceptance, the sealed
 * revision and the recorded evidence itself, so every caller renders the same brief for the same state.
 */
export async function buildAdversarialBrief(
    root: string,
    taskId: string,
    node: AdversarialNode,
    options: { since?: string; mode?: 'verify' | 'cold' } = {},
): Promise<{ node: AdversarialNode; revisionId: string | null; text: string; sha256: string; mode: 'verify' | 'cold'; modeReason: string; delta: { from: string; changedPaths: string[] } | { unavailable: string } | null }> {
    const { readTask } = await import('../core/task.js');
    const { readRecordedEvidence } = await import('./evidence.js');
    const { readCurrentTaskRevision } = await import('../workflow/revision.js');
    const { readReview } = await import('../workflow/review-read.js');

    const task = await readTask(root, taskId);
    const revision = await readCurrentTaskRevision(root, taskId);
    const evidence = await readRecordedEvidence(root, taskId).catch(() => []);
    const review = await readReview(root, taskId);

    // F2: a `--since` brief is a delta brief, and it is only honest when the change surface is knowable. A revision
    // sealed before per-path digests existed yields `delta_unavailable` — the caller is told, never handed a guess.
    let delta: { from: string; changedPaths: string[]; added: string[]; modified: string[]; removed: string[]; attempts?: Array<Record<string, string>>; findings?: Array<{ id: string; severity: string; message: string; disposition: string }> } | undefined;
    let deltaReport: { from: string; changedPaths: string[] } | { unavailable: string } | null = null;
    if (options.since) {
        const { readTaskRevision } = await import('../workflow/revision.js');
        const { changeSurfaceAgainstWorkspace } = await import('./revision-delta.js');
        const base = await readTaskRevision(root, taskId, options.since).catch(() => null)
            ?? await findRevisionByManifest(root, taskId, options.since)
            ?? null;
        if (!base) {
            deltaReport = { unavailable: `no revision matching '${options.since}' was found for task '${taskId}'` };
        } else {
            const surface = await changeSurfaceAgainstWorkspace(root, base);
            if (surface.status === 'delta_unavailable') {
                deltaReport = { unavailable: surface.reason };
            } else if (surface.status === 'unchanged') {
                deltaReport = { from: base.id, changedPaths: [] };
            } else {
                const previous = await readAdversarialRecord(root, taskId, node);
                const { readTrackedFindings } = await import('./finding-disposition.js');
                delta = {
                    from: base.id,
                    changedPaths: surface.changedPaths,
                    added: surface.added,
                    modified: surface.modified,
                    removed: surface.removed,
                    attempts: (previous?.attempts ?? []) as unknown as Array<Record<string, string>>,
                    findings: (await readTrackedFindings(root, taskId)).map(({ id, severity, message, disposition }) => ({ id, severity, message, disposition })),
                };
                deltaReport = { from: base.id, changedPaths: surface.changedPaths };
            }
        }
    }

    const resolvedMode = await resolveBriefMode(root, taskId, node, options.mode);
    const text = renderAdversarialBrief({
        mode: resolvedMode.mode,
        modeReason: resolvedMode.reason,
        ...(delta ? { delta } : {}),
        taskId,
        node,
        revisionId: revision?.id ?? null,
        acceptance: task.acceptance ?? [],
        evidence,
        ownedPaths: revision?.ownedPaths ?? task.ownedPaths ?? [],
        reviewFindings: review.findings,
        knownFindings: decidedReviewFindings(review.findings),
        // M1: point at the envelopes and name the project's own checks, so the reviewer can read rather than re-derive.
        evidencePaths: await evidenceEnvelopePaths(root, taskId, evidence),
        declaredChecks: (await readProjectQualityChecks(root)).map((check) => ({ id: check.name, name: check.name })),
        readingSet: await buildReadingSet(root, taskId, revision),
    });
    return {
        node,
        revisionId: revision?.id ?? null,
        text,
        sha256: adversarialBriefSha256(text),
        // The mode is a property of the brief, not an input to it: recording it on the pass cannot change the text.
        mode: resolvedMode.mode,
        modeReason: resolvedMode.reason,
        delta: deltaReport,
    };
}

/** Resolves a `--since` argument that named a manifest hash rather than a revision id. */
async function findRevisionByManifest(root: string, taskId: string, target: string): Promise<Awaited<ReturnType<typeof import('../workflow/revision.js').readTaskRevision>> | null> {
    const { readdir, readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const { revisionsDir } = await import('../core/layout.js');
    const directory = revisionsDir(root, taskId);
    const files = await readdir(directory).catch(() => [] as string[]);
    for (const file of files.filter((name) => name.endsWith('.json'))) {
        const raw = JSON.parse(await readFile(join(directory, file), 'utf8')) as { manifestHash?: string };
        if (raw.manifestHash) {
            if (raw.manifestHash !== target) continue;
            return await (await import('../workflow/revision.js')).readTaskRevision(root, taskId, file.replace(/\.json$/, ''));
        }
    }
    return null;
}

/**
 * The starting set for a pass (M4): what changed, plus the files the matrix ties to the same acceptance criteria.
 *
 * Derived, not authored — the same principle as F4's check derivation and for the same reason: an author who has to hand
 * a reviewer a reading list will hand over their own framing, and the largest defect of the measured session was in a file
 * the author had not mentioned.
 */
async function buildReadingSet(
    root: string,
    taskId: string,
    revision: { id: string; pathDigests?: Record<string, string>; ownedPaths: string[] } | null,
): Promise<Array<{ path: string; why: string }>> {
    if (!revision?.pathDigests) return [];
    const { changeSurfaceAgainstWorkspace } = await import('./revision-delta.js');
    const surface = await changeSurfaceAgainstWorkspace(root, revision as never);
    // The sealed revision's content *is* the unit under review, so a clean working tree is not "nothing to read": the
    // owned set is the reading set's floor, and the change surface (when there is one) says what moved.
    const moved = surface.status === 'available' ? surface.changedPaths : [];
    const surfaceInfo = surface.status === 'available' ? surface : null;

    const set = new Map<string, string>();
    const owned = Object.keys(revision.pathDigests);
    // Everything that moved comes first: it is where a hypothesis starts.
    for (const path of moved) set.set(path, surfaceInfo?.added.includes(path) ? 'added in this change' : surfaceInfo?.modified.includes(path) ? 'changed in this change' : 'part of this change');
    const changedPaths = moved.length > 0 ? moved : owned;

    // The matrix ties acceptance criteria to implementation and test paths; the collaborators of a changed path are the
    // other files under the same criteria.
    try {
        const { readTask } = await import('../core/task.js');
        const { rowsForChangedPaths } = await import('./relevant-checks.js');
        const task = await readTask(root, taskId);
        const matrix = (task as { acceptanceMatrix?: import('../core/task.js').AcceptanceMatrix }).acceptanceMatrix;
        if (matrix) {
            for (const row of rowsForChangedPaths(matrix, changedPaths)) {
                for (const declared of [...row.implementationPaths, ...row.testPaths]) {
                    if (set.has(declared)) continue;
                    set.set(declared, `implements the same acceptance criterion as this change (${row.acceptanceId})`);
                }
            }
        }
    } catch {
        // A task without a matrix simply gets the changed paths: less help, same instruction.
    }

    // An owned set can be hundreds of files; a reading list of hundreds is not orientation, it is a wall of tokens. The
    // set is bounded and clearly labelled a sample, so it stays an aid rather than a boundary or a cost.
    const MAX_ENTRIES = 40;
    const shaped = [...set.entries()].sort(([a], [b]) => a.localeCompare(b));
    if (shaped.length === 0) {
        return owned.slice(0, MAX_ENTRIES).map((path) => ({
            path,
            why: `owned by this task and part of the sealed revision under review (a sample of ${owned.length})`,
        }));
    }
    return shaped.slice(0, MAX_ENTRIES).map(([path, why]) => ({ path, why }));
}

/** Where each recorded envelope lives, by id — the reading list for M1. */
async function evidenceEnvelopePaths(root: string, taskId: string, evidence: EvidenceEnvelope[]): Promise<Array<{ id: string; checkId?: string; path: string }>> {
    const { readdir } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const directory = evidenceDir(root);
    const files = await readdir(directory).catch(() => [] as string[]);
    const paths: Array<{ id: string; checkId?: string; path: string }> = [];
    for (const item of evidence) {
        // `writeEvidence` names each envelope `${taskId}-${checkId ?? id}.json`, and archived ones are not pointed at.
        const match = files.find((file) => file === `${item.id}.json` || file === `${taskId}-${item.checkId ?? item.id}.json`);
        if (!match) continue;
        paths.push({
            id: item.id,
            ...(item.checkId ? { checkId: item.checkId } : {}),
            path: join(directory, match),
        });
    }
    return paths;
}

/** The checks the project declares, which are the ones a reviewer is most tempted to re-run. */
async function readProjectQualityChecks(root: string): Promise<Array<{ name: string }>> {
    try {
        const { loadConfig } = await import('../core/config.js');
        const configured = await loadConfig(root);
        return (configured.quality?.buildChecks ?? []).map((check: { name?: string; command: string }) => ({ name: check.name ?? check.command }));
    } catch {
        return [];
    }
}

/**
 * The decisions a brief may carry: the review record's findings that are no longer open.
 *
 * A one-line filter over a durable source, on purpose — see the note on `knownFindings` for what happens when a brief
 * carries state that recording a pass rewrites.
 */
function decidedReviewFindings(
    findings: Array<{ id: string; severity: string; message: string; disposition?: string; dispositionReason?: string; dispositionBy?: string }>,
): Array<{ id: string; severity: string; message: string; disposition: string; dispositionReason?: string; dispositionBy?: string; source: string }> {
    return findings
        .filter((finding) => (finding.disposition ?? 'open') !== 'open')
        .map((finding) => ({
            id: finding.id,
            severity: finding.severity,
            message: finding.message,
            disposition: finding.disposition ?? 'open',
            ...(finding.dispositionReason ? { dispositionReason: finding.dispositionReason } : {}),
            ...(finding.dispositionBy ? { dispositionBy: finding.dispositionBy } : {}),
            source: 'review',
        }));
}

/** The gate for a node, asked the same way by the workflow and by the CLI's status report. */
/**
 * What a repair would cost from here (design §F3).
 *
 * The answer is derived, not guessed: if the current seal has per-path digests, a later pass can be a delta over exactly
 * what changed — so the cost is a delta pass, and the receipt survives (it binds to content, `bcfe671`). Without digests
 * there is nothing to measure a change surface against, so the honest answer is a full pass.
 */
export async function reverificationCostFor(root: string, taskId: string): Promise<{
    passScope: 'delta' | 'full';
    supersedesReceipt: boolean;
    reason: string;
}> {
    const { readCurrentTaskRevision } = await import('../workflow/revision.js');
    const revision = await readCurrentTaskRevision(root, taskId).catch(() => null);
    if (!revision) {
        return { passScope: 'full', supersedesReceipt: true, reason: 'no revision is sealed yet, so the first pass is a full one' };
    }
    if (!revision.pathDigests) {
        return {
            passScope: 'full',
            supersedesReceipt: false,
            reason: `revision ${revision.id} records no per-path digests, so a change surface cannot be measured; the next pass is full`,
        };
    }
    return {
        passScope: 'delta',
        supersedesReceipt: false,
        reason: 'owned-path digests are recorded, so the next pass can re-derive only what changed (the receipt binds to content, so it survives)',
    };
}

export async function adversarialGateFor(
    root: string,
    taskId: string,
    node: AdversarialNode,
): Promise<AdversarialGateResult> {
    const { readCurrentTaskRevision } = await import('../workflow/revision.js');
    const [brief, record, revision] = await Promise.all([
        buildAdversarialBrief(root, taskId, node),
        readAdversarialRecord(root, taskId, node),
        readCurrentTaskRevision(root, taskId),
    ]);
    const gate = evaluateAdversarialGate(record, {
        node,
        revisionId: brief.revisionId,
        manifestHash: revision?.manifestHash ?? null,
        briefSha256: brief.sha256,
    });
    if (!gate.satisfied) return gate;

    // A satisfied pass still has to be honest about its scope: a delta that does not cover the change is refused here,
    // before any node treats the pass as a conclusion.
    const scope = await evaluateDeltaScope(root, taskId, gate.record ?? record, brief.revisionId);
    if (!scope.ok) {
        return { satisfied: false, reason: scope.reason, detail: scope.detail, ...(gate.record ? { record: gate.record } : {}), findings: [] };
    }
    return gate;
}
