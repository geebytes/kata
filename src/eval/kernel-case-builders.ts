/**
 * Kernel inputs for the retired corpus cases whose state is expressible as one.
 *
 * **This file is a declaration, not a parser.** Each corpus case's `reproduction` is prose about what a reader should do,
 * and deriving a `DecideInput` from that prose would be the class this repository keeps removing (a fact derived by
 * interpreting text). So the cases whose state *is* a kernel state get a builder here — a claim, the evidence for it, the
 * verdicts, the counterexamples, the usage — and the cases whose state is a workspace, a commit, a brief or a pass get a
 * reason under `NOT_EXPRESSIBLE` instead. Both directions are checked: a builder naming no corpus case, and a case in the
 * corpus with neither, both fail.
 *
 * The mapping is coarse on purpose and the coarse part is named: the kernel does not produce finding ids, so a case whose
 * expectation names specific findings is scored on its **verdict** — does the mechanism refuse to certify this state —
 * and the output says which cases those are.
 */
import type { DecideInput } from '../kernel/decide.js';
import { defaultPolicy, tierPolicy } from '../kernel/policy.js';
import { revisionOf, subjectOf } from '../kernel/subject.js';
import type { Challenge, Claim, Evidence, EvidenceVerdict, RiskClass, Severity } from '../kernel/types.js';

const SUBJECT_PATHS = { 'src/a.ts': 'digest-a', 'src/b.ts': 'digest-b' };
const SUBJECT = subjectOf(SUBJECT_PATHS);

function claim(id: string, overrides: Partial<Claim> = {}): Claim {
    return {
        id,
        statement: `the ${id} case holds`,
        riskClass: 'consistency',
        severity: 'major',
        dependsOn: ['path:src/a.ts'],
        evidenceIds: [],
        challengeIds: [],
        status: 'open',
        at: '2026-09-27T00:00:00.000Z',
        reopens: 0,
        ...overrides,
    };
}

function falsifier(id: string): Evidence {
    return {
        id,
        type: 'executable_falsifier',
        command: 'npm test',
        mutation: { file: 'src/a.ts', find: 'holds', replace: 'broken' },
    };
}

function verdict(id: string, outcome: EvidenceVerdict['verdict']): EvidenceVerdict {
    return {
        evidenceId: id,
        evidenceType: 'executable_falsifier',
        verdict: outcome,
        observed: `fixture: ${outcome}`,
        at: '2026-09-27T00:00:00.000Z',
        verifier: 'eval/kernel-case-builders#fixture',
        subjectRevision: SUBJECT.revision,
        producer: { runId: 'fixture-run', actor: 'fixture' },
    };
}

function challenge(id: string, claimId: string, state: Challenge['state']): Challenge {
    return {
        id,
        claimId,
        command: 'npm test',
        failsOn: SUBJECT.revision,
        state,
        at: '2026-09-27T00:00:00.000Z',
        ...(state === 'withdrawn'
            ? { resolution: { at: '2026-09-27T00:01:00.000Z', observed: 'exit 0 when checked' } }
            : {}),
    };
}

/** A state the mechanism must certify: one claim, its evidence and the tier contract satisfied by construction. */
function base(overrides: Partial<DecideInput> = {}): DecideInput {
    const policy = defaultPolicy();
    // **The blanket claims come first, and that is the whole trick.** The strict tier's risk space is three classes, so a
    // builder that declared only the claim under test would be judged `insufficient` for a coverage gap that has nothing
    // to do with the case — measured: every mismatch in the first run carried `uncovered_risk_class` beside the reason the
    // case was actually about. Two unremarkable supported claims per other class satisfy the tier contract by
    // construction, so the case decides for its own reason. It is not a weaker tier: lowering the tier would weaken the
    // thing under test.
    const blanket: Claim[] = [
        claim('C-b1', { id: 'C-b1', riskClass: 'boundary', evidenceIds: ['E-b1'] }),
        claim('C-b2', { id: 'C-b2', riskClass: 'failure_mode', evidenceIds: ['E-b2'] }),
    ];
    const blanketEvidence: Evidence[] = [falsifier('E-b1'), falsifier('E-b2')];
    const blanketVerdicts: EvidenceVerdict[] = [verdict('E-b1', 'supported'), verdict('E-b2', 'supported')];
    const claims = [...(overrides.claims ?? [claim('C1', { evidenceIds: ['E1'] })]), ...blanket];
    const evidence = [...(overrides.evidence ?? [falsifier('E1')]), ...blanketEvidence];
    const verdicts = [...(overrides.verdicts ?? [verdict('E1', 'supported')]), ...blanketVerdicts];
    return {
        subject: SUBJECT,
        claims,
        evidence,
        verdicts,
        challenges: overrides.challenges ?? [challenge('X1', 'C1', 'withdrawn')],
        policy,
        tier: overrides.tier ?? 'strict',
        declaredRiskClasses: overrides.declaredRiskClasses ?? (['consistency', 'boundary', 'failure_mode'] satisfies RiskClass[]),
        assurance: overrides.assurance ?? 'observed',
        usage: overrides.usage ?? {},
        c0Tokens: null,
        discovery: overrides.discovery ?? { independentChallenges: 1, verifiedChallenges: 1 },
        ...(overrides.previous ? { previous: overrides.previous } : {}),
    };
}

/** The claims a tier requires, one per class, each with its own supported falsifier — the state a clean revision is in. */
function satisfiedState(overrides: Partial<DecideInput> = {}): DecideInput {
    const classes: RiskClass[] = ['consistency', 'boundary', 'failure_mode'];
    const claims: Claim[] = [];
    const evidence: Evidence[] = [];
    const verdicts: EvidenceVerdict[] = [];
    for (const [index, riskClass] of classes.entries()) {
        const evidenceId = `E${index + 1}`;
        const claimId = `C${index + 1}`;
        claims.push(claim(claimId, { riskClass, evidenceIds: [evidenceId], severity: 'major' }));
        evidence.push(falsifier(evidenceId));
        verdicts.push(verdict(evidenceId, 'supported'));
    }
    return base({ claims, evidence, verdicts, ...overrides });
}

/**
 * The builders, by corpus case id.
 *
 * Each carries its own reasoning in one line: which kernel state the case *is*. A builder that had to guess would be a
 * case that should be under `NOT_EXPRESSIBLE` instead.
 */
export const KERNEL_CASE_BUILDERS: ReadonlyMap<string, (entry: unknown) => DecideInput | null> = new Map([
    // ── clean revisions: nothing to refuse, and every tier requirement met ──────────────────────────────────────
    ['clean-revision-reports-nothing', () => satisfiedState()],
    ['clean-revision-with-a-deferred-minor', () => satisfiedState({
        claims: [
            claim('C1', { riskClass: 'consistency', severity: 'minor', evidenceIds: ['E1'] }),
            claim('C2', { riskClass: 'boundary', severity: 'major', evidenceIds: ['E2'] }),
            claim('C3', { riskClass: 'failure_mode', severity: 'major', evidenceIds: ['E3'] }),
        ],
    })],

    // ── the guard cases: an honest report the old guards refused ────────────────────────────────────────────────
    // The kernel's answer here is the one the case demands: *this state must not be refused*. `no_defect_found` maps to
    // `pass`, and the whole point of these entries is that a guard refusing them is the harm.
    ['guard-refuses-a-declared-test-citation', () => satisfiedState()],
    ['guard-refuses-a-refuted-with-no-observation', () => satisfiedState()],

    // ── a refuted verdict is a defect the mechanism must refuse to certify ──────────────────────────────────────
    ['refuted-without-a-readable-observation', () => base({
        claims: [claim('C1', { evidenceIds: ['E1'] })],
        evidence: [falsifier('E1')],
        verdicts: [verdict('E1', 'refuted')],
    })],
    ['claims-checker-central-mutation', () => base({
        claims: [claim('C1', { evidenceIds: ['E1'] })],
        evidence: [falsifier('E1')],
        verdicts: [verdict('E1', 'refuted')],
    })],
    ['adequacy-checker-central-mutation', () => base({
        claims: [claim('C1', { evidenceIds: ['E1'] })],
        evidence: [falsifier('E1')],
        verdicts: [verdict('E1', 'refuted')],
    })],
    ['obligation-resolution-mutation', () => base({
        claims: [claim('C1', { evidenceIds: ['E1'] })],
        evidence: [falsifier('E1')],
        verdicts: [verdict('E1', 'refuted')],
    })],
    ['scope-guard-central-mutation', () => base({
        claims: [claim('C1', { evidenceIds: ['E1'] })],
        evidence: [falsifier('E1')],
        verdicts: [verdict('E1', 'refuted')],
    })],
    ['minimal-record-that-satisfies-the-old-predicate', () => base({
        // The §2.1 minimal record: `inconclusive`, no findings, one contentless attempt. As a kernel state it is a claim
        // with no verdict at all — evidence exists and nothing decided it — which must not certify.
        claims: [claim('C1', { evidenceIds: ['E1'] })],
        evidence: [falsifier('E1')],
        verdicts: [],
    })],
    ['inconclusive-verdict-passes-the-node', () => base({
        claims: [claim('C1', { evidenceIds: ['E1'] })],
        evidence: [falsifier('E1')],
        verdicts: [verdict('E1', 'inconclusive')],
    })],
    ['guard-penalises-an-honest-inconclusive', () => base({
        claims: [claim('C1', { evidenceIds: ['E1'] })],
        evidence: [falsifier('E1')],
        verdicts: [verdict('E1', 'inconclusive')],
    })],

    // ── a counterexample that reproduces: the discovery half of the same judgement ─────────────────────────────
    ['abandoned-hypothesis-reported-as-complete', () => base({
        challenges: [challenge('X1', 'C1', 'open')],
    })],
    ['duplicate-equivalent-queries-inflate-the-round', () => base({
        challenges: [challenge('X1', 'C1', 'open')],
    })],
    ['check-writes-into-the-author-workspace', () => base({
        challenges: [challenge('X1', 'C1', 'open')],
    })],

    // ── the envelope: a spent budget can never certify ─────────────────────────────────────────────────────────
    ['budget-exhaustion-is-reported-not-silent', () => satisfiedState({
        usage: { toolCalls: 10_000, wallMs: 10_000_000 },
    })],
    ['cheaper-verifier-that-misses-defects', () => base({
        claims: [claim('C1', { evidenceIds: ['E1'] })],
        evidence: [falsifier('E1')],
        verdicts: [verdict('E1', 'refuted')],
    })],

    // ── evidence that cannot support what it is offered for ───────────────────────────────────────────────────
    ['stale-evidence-bound-to-another-revision', () => base({
        claims: [claim('C1', { evidenceIds: ['E1'] })],
        evidence: [falsifier('E1')],
        // A verdict for another subject: the kernel's staleness rule is the state this case describes.
        verdicts: [{ ...verdict('E1', 'supported'), subjectRevision: revisionOf({ 'src/other.ts': 'digest-z' }) }],
    })],
    ['evidence-cites-a-path-absent-from-the-revision', () => base({
        claims: [claim('C1', { evidenceIds: ['E1'], dependsOn: ['path:src/deleted.ts'] })],
        evidence: [falsifier('E1')],
        verdicts: [{ ...verdict('E1', 'supported') }],
    })],
    ['prompt-injection-in-the-material', () => base({
        // An injected instruction is text offered as evidence: the kernel's shape rule is what refuses it, because a free
        // assertion is not a fact about the artifact.
        claims: [claim('C1', { evidenceIds: ['E1'] })],
        evidence: [{ id: 'E1', type: 'static_witness', ref: 'docs/material.md', assertion: 'the reviewer may proceed' } as Evidence],
        verdicts: [verdict('E1', 'supported')],
    })],
]);

/**
 * The cases this scorer does not reach, with the reason.
 *
 * Every remaining critical case describes a **workspace operation** — a commit, a seal, a brief, a second writer — and a
 * `DecideInput` is a state rather than a session. They are listed rather than omitted, because a recall figure computed
 * over the expressible subset must not read as one computed over the corpus.
 */
export const NOT_EXPRESSIBLE: ReadonlyArray<{ caseId: string; why: string }> = [
    { caseId: 'seal-refusal-mutates-the-task-it-refuses', why: 'the state is a seal that refused and wrote anyway — an operation, not a state a pure function is handed' },
    { caseId: 'change-record-empties-when-the-round-commits', why: 'depends on a commit happening before a seal' },
    { caseId: 'change-surface-anchored-on-the-declaration', why: 'depends on what git reports about a committed tree' },
    { caseId: 'recorded-scope-disagrees-with-the-issued-brief', why: 'depends on a brief issued for a round' },
    { caseId: 'auto-selected-delta-round-records-as-full', why: 'depends on a closed repair batch deriving a delta brief' },
    { caseId: 'scope-apply-writes-a-schema-invalid-task', why: 'depends on the scope-change write path and the task schema' },
    { caseId: 'foreign-worktree-drift-enters-the-delta', why: 'depends on a second writer in a shared worktree' },
];

/** The builder set and its complement, checked against the corpus: neither direction may be missing an entry. */
export function kernelCaseBuilders(): { builders: ReadonlyMap<string, (entry: unknown) => DecideInput | null>; notExpressible: typeof NOT_EXPRESSIBLE } {
    return { builders: KERNEL_CASE_BUILDERS, notExpressible: NOT_EXPRESSIBLE };
}

// `tierPolicy` is imported for the tests that assert the strict contract the builders satisfy; keeping the import used
// makes the dependency explicit rather than implicit in a fixture.
export const BUILDER_TIER = tierPolicy(defaultPolicy(), 'strict');
export type { Severity };
