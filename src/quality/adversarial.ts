import { readFile, writeFile } from 'node:fs/promises';
import { hashContent } from '../core/hash.js';
import { adversarialReviewPath } from '../core/layout.js';
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
    reviewFindings?: Array<{ severity?: string; message?: string }>;
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
    const claims = input.acceptance.length > 0
        ? input.acceptance.map((criterion) => `- ${criterion.id ?? '(no id)'}: ${criterion.statement ?? ''}`).join('\n')
        : '- (this task declares no acceptance criteria)';

    const evidence = input.evidence.length > 0
        ? input.evidence
            .map((item) => `- ${item.id} | kind=${item.kind} | exit=${item.exitCode} | command=${item.command}${item.checkId ? ` | check=${item.checkId}` : ''}`)
            .join('\n')
        : '- (no evidence has been recorded for this revision)';

    const findings = (input.reviewFindings ?? []).length > 0
        ? (input.reviewFindings ?? []).map((finding) => `- ${finding.severity ?? 'unknown'}: ${finding.message ?? ''}`).join('\n')
        : '- (none recorded yet)';

    const decided = (input.knownFindings ?? []).filter((finding) => finding.disposition !== 'open');
    const known = decided.length > 0
        ? decided
            .map((finding) => `- ${finding.severity} ${finding.id} [${finding.disposition}${finding.dispositionReason ? `: ${finding.dispositionReason}` : ''}${finding.dispositionBy ? ` by ${finding.dispositionBy}` : ''}] (${finding.source}): ${finding.message}`)
            .join('\n')
        : '- (nothing has been dispositioned for this task)';

    return `# Independent adversarial review — ${input.node} node

You are an independent adversarial reviewer. **You have no prior context.** Everything you are allowed to assume is in
this brief; do not continue anyone else's reasoning, and do not trust the claims in it — the point of this pass is that
you try to break them.

Task: ${input.taskId}
Node under review: ${input.node}
Sealed revision: ${input.revisionId ?? '(none sealed yet)'}
Paths under review: ${input.ownedPaths.length > 0 ? input.ownedPaths.join(', ') : '(none declared)'}

## The claims under test

${claims}

## Evidence the author recorded

${evidence}

## Findings recorded so far

${findings}

## Already known, already decided — do not re-report these

${known}

If you believe one of those decisions is wrong, say so as a finding **against the decision**, with your reasoning: a
decision can be wrong, but re-reporting it as a new discovery wastes the pass and hides the fact that it was decided.

## What to do

For each claim above, and for the change as a whole:

1. Read the actual repository — the implementation, its tests and the recorded evidence — rather than this brief.
2. Form at least one **falsification attempt per claim**: a specific way the claim could be false (a missing edge case,
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

export async function writeAdversarialRecord(root: string, taskId: string, record: AdversarialRecord): Promise<AdversarialRecord> {
    const validated = validate<AdversarialRecord>('adversarial-review', record);
    await writeFile(adversarialReviewPath(root, taskId, record.node), `${JSON.stringify(validated, null, 2)}\n`, 'utf8');
    return validated;
}

export type AdversarialGateReason =
    | 'missing'
    | 'no_revision'
    | 'stale_revision'
    | 'not_fresh_context'
    | 'brief_mismatch'
    | 'waived';

export interface AdversarialGateResult {
    satisfied: boolean;
    reason?: AdversarialGateReason;
    record?: AdversarialRecord;
    /** Findings the node must resolve, when the pass confirmed defects. */
    findings: AdversarialFinding[];
}

/**
 * Whether a node may conclude.
 *
 * A recorded pass has to be about *this* revision, has to attest a fresh context, and has to have been run against the
 * brief kata renders now — a pass against an older brief was answering a different question. A waiver satisfies the
 * gate explicitly and is reported as such rather than hidden.
 */
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
): Promise<{ node: AdversarialNode; revisionId: string | null; text: string; sha256: string }> {
    const { readTask } = await import('../core/task.js');
    const { readRecordedEvidence } = await import('./evidence.js');
    const { readCurrentTaskRevision } = await import('../workflow/revision.js');
    const { readReview } = await import('../workflow/review-read.js');

    const task = await readTask(root, taskId);
    const revision = await readCurrentTaskRevision(root, taskId);
    const evidence = await readRecordedEvidence(root, taskId).catch(() => []);
    const review = await readReview(root, taskId);

    const text = renderAdversarialBrief({
        taskId,
        node,
        revisionId: revision?.id ?? null,
        acceptance: task.acceptance ?? [],
        evidence,
        ownedPaths: revision?.ownedPaths ?? task.ownedPaths ?? [],
        reviewFindings: review.findings,
        knownFindings: (await import('./finding-disposition.js')).deferredFindings(
            await (await import('./finding-disposition.js')).readTrackedFindings(root, taskId),
        ).map(({ id, severity, message, disposition, dispositionReason, dispositionBy, source }) => ({
            id,
            severity,
            message,
            disposition,
            ...(dispositionReason ? { dispositionReason } : {}),
            ...(dispositionBy ? { dispositionBy } : {}),
            source,
        })),
    });
    return { node, revisionId: revision?.id ?? null, text, sha256: adversarialBriefSha256(text) };
}

/** The gate for a node, asked the same way by the workflow and by the CLI's status report. */
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
    return evaluateAdversarialGate(record, {
        node,
        revisionId: brief.revisionId,
        manifestHash: revision?.manifestHash ?? null,
        briefSha256: brief.sha256,
    });
}
