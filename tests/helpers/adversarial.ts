import { writeAdversarialRecord, issueAdversarialBrief, type AdversarialNode } from '../../src/quality/adversarial.js';

/**
 * Records an independent adversarial pass for a node, the way the workflow now requires.
 *
 * Verify and review refuse to conclude without one, so every end-to-end fixture that walks a task to review, judge or
 * archive has to record one. The fixture fills the brief hash from the same renderer the gate checks against, and
 * attests a fresh context — which is what the real pass does too.
 */
export async function recordAdversarialPass(
    root: string,
    taskId: string,
    node: AdversarialNode,
    options: {
        attempts?: Array<{ hypothesis: string; method: string; outcome: 'refuted' | 'confirmed' | 'inconclusive'; evidence?: string }>;
        findings?: Array<{ id: string; taskId: string; severity: 'blocking' | 'major' | 'minor' | 'nit'; message: string; path?: string }>;
        verdict?: 'no_defect_found' | 'defects_found' | 'inconclusive';
        executedInFreshContext?: boolean;
        briefSha256?: string;
    } = {},
): Promise<void> {
    // Issued, not merely rendered: the gate binds the record to a brief kata handed out, so a fixture that only
    // rendered one would be testing a path the CLI cannot produce any more.
    const brief = await issueAdversarialBrief(root, taskId, node);
    await writeAdversarialRecord(root, taskId, {
        node,
        status: 'recorded',
        revisionId: brief.revisionId ?? '',
        createdAt: new Date().toISOString(),
        executedInFreshContext: options.executedInFreshContext ?? true,
        contextNote: 'Fixture ran the brief in a subagent with no prior conversation.',
        briefSha256: options.briefSha256 ?? brief.sha256,
        verdict: options.verdict ?? 'no_defect_found',
        executedBy: 'fixture-adversary',
        attempts: options.attempts ?? [{
            hypothesis: 'The acceptance criterion is only satisfied by the shape of the test, not by the behaviour.',
            method: 'Read the test and the implementation it exercises.',
            outcome: 'refuted',
            evidence: 'The assertion exercises the declared behaviour.',
        }],
        findings: options.findings ?? [],
    });
}

/** Records both nodes' passes — the shape most end-to-end fixtures want. */
export async function recordAdversarialPasses(root: string, taskId: string): Promise<void> {
    await recordAdversarialPass(root, taskId, 'verify');
    await recordAdversarialPass(root, taskId, 'review');
}
