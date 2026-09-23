import { writeAdversarialRecord, issueAdversarialBrief, type AdversarialNode } from '../../src/quality/adversarial.js';
import { readTask } from '../../src/core/task.js';

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
        hypotheses?: Array<{ id: string; claim: string; targets: string[]; method: 'mutation' | 'source-read' | 'sealed-evidence' | 'permitted-test' | 'deterministic-analysis'; outcome: 'refuted' | 'confirmed' | 'ruled_out' | 'abandoned' | 'inconclusive'; observation?: { kind: 'source' | 'evidence' | 'test' | 'analysis'; ref: string; observed: string } }>;
        attempts?: Array<{ hypothesis: string; method: string; outcome: 'refuted' | 'confirmed' | 'inconclusive'; evidence?: string }>;
        findings?: Array<{ id: string; taskId: string; severity: 'blocking' | 'major' | 'minor' | 'nit'; message: string; path?: string }>;
        executedInFreshContext?: boolean;
        briefSha256?: string;
    } = {},
): Promise<void> {
    // Issued, not merely rendered: the gate binds the record to a brief kata handed out, so a fixture that only
    // rendered one would be testing a path the CLI cannot produce any more.
    const brief = await issueAdversarialBrief(root, taskId, node);
    // R2: a recorded pass must carry a judgement basis, or the gate refuses it (it used to skip every conjunct instead).
    // The fixture covers what the task declares — the criteria and the revision's own changed paths — which is the honest
    // minimum for a pass that looked at the change, and it is stated as hypotheses rather than as a coverage declaration
    // because a declaration the caller fills in is the shape §3.1.2 exists to refuse.
    const task = await readTask(root, taskId).catch(() => null);
    const criteria = (task?.acceptance ?? []).map((item) => item.id).filter((id): id is string => Boolean(id));
    // What the pass speaks for: the criteria it answers and the change surface it claims to have looked at. The surface
    // comes from the sealed change record when there is one — that is the artefact the gate now demands coverage of, so a
    // fixture that targeted only the declared owned paths would be asserting coverage the gate cannot verify (R3).
    const { readChangeRecord } = await import('../../src/quality/change-record.js');
    const sealed = await readChangeRecord(root, taskId).catch(() => null);
    const declaredPaths = brief.ir?.scope
        ? (brief.ir.scope.kind === 'delta' ? brief.ir.scope.changedPaths : brief.ir.scope.paths)
        : [];
    // `??` is wrong here: an empty array is not null, so a record that reported no changed paths silently discarded the
    // declared ones. Measured (DIAG sealed= 0 declared= 1 targets= 1 ["AC-1"]) — the pass then claimed no path at all.
    const surfacePaths = sealed?.changedPaths?.length ? sealed.changedPaths : declaredPaths;
    const targets = [...new Set([...criteria, ...surfacePaths])];
    // R8: an observation must cite something openable at this revision. This fixture used `kind: 'analysis'` with a
    // made-up ref, which the (then citation-free) analysis rule accepted — the very defect R8 closed. It now cites a path
    // the fixture really created and the revision contains, which is what the claim below actually rests on.
    const instruments = (task?.acceptanceMatrix?.rows ?? [])
        .flatMap((row) => (row.evidence ?? []).map((item) => item.command))
        .filter((command): command is string => Boolean(command));
    const observationPath = [...new Set([...(sealed?.changedPaths ?? []), ...declaredPaths])].find((path) => !path.endsWith('/'));
    const observation = observationPath
        ? { kind: 'source' as const, ref: observationPath, observed: 'the assertion exercises the declared behaviour' }
        : { kind: 'analysis' as const, ref: instruments[0] ?? '', observed: 'the declared check reports the behaviour' };
    const defaultHypotheses = [{
        id: 'h-fixture',
        claim: 'the acceptance criterion is only satisfied by the shape of the test, not by the behaviour',
        targets,
        method: 'source-read' as const,
        outcome: 'refuted' as const,
        observation,
    }];
    await writeAdversarialRecord(root, taskId, {
        node,
        status: 'recorded',
        revisionId: brief.revisionId ?? '',
        createdAt: new Date().toISOString(),
        executedInFreshContext: options.executedInFreshContext ?? true,
        contextNote: 'Fixture ran the brief in a subagent with no prior conversation.',
        briefSha256: options.briefSha256 ?? brief.sha256,
        executedBy: 'fixture-adversary',
        hypotheses: options.hypotheses ?? defaultHypotheses,
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
