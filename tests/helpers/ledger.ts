import { appendClaim, appendEvidence, appendProbe, answerProbe, ensureAssurance, freezeSubject, readLedger, recordVerdicts, writePlan, writePolicy, writeSubject } from '../../src/store/ledger.js';
import { planReview } from '../../src/producers/planner.js';
import { defaultPolicy } from '../../src/kernel/policy.js';
import { readTask } from '../../src/core/task.js';

/**
 * Give a fixture an evidence ledger that decides `pass`, the way a review approval now requires.
 *
 * **Why the fixture changed.** An approval used to rest on a round-shaped adversarial pass: a document about a review.
 * It now rests on claims and evidence — the kernel's decision over content kata verified itself — so a fixture that walks
 * a task to review, judge or archive has to record a ledger rather than a pass. The old helper is not deleted yet (the
 * old modules still exist), but nothing reaching an approval can use it: the route it feeds is closed.
 *
 * The claims are one per acceptance criterion, each with its own falsifier whose mutation is real for the scratch workspace
 * the fixture builds — a check that greps a literal the mutation removes. The evidence is verified by the inline adapter,
 * which is what makes the assurance `observed` and therefore enough for the strict floor.
 */
export async function seedLedger(
    root: string,
    taskId: string,
    options: { paths?: string[] } = {},
): Promise<void> {
    const task = await readTask(root, taskId).catch(() => null);
    const criteria = (task?.acceptance ?? []).map((item) => item.id).filter((id): id is string => Boolean(id));
    // Only paths that exist can be frozen, and a task may declare one that has not been written yet (a fixture about a
    // task outgrowing its revision declares exactly that). Freezing the readable subset is the honest call: a ledger about
    // a path that is not there cannot be evidence about it, and the delta rule refuses such a claim as unresolvable.
    const declared = options.paths ?? task?.ownedPaths ?? ['task-owned.txt'];
    const { existsSync } = await import('node:fs');
    const paths = declared.filter((path) => existsSync(path.startsWith('/') ? path : `${root}/${path}`));
    if (paths.length === 0) paths.push(...declared);
    await writePolicy(root, taskId, defaultPolicy());
    const frozen = await freezeSubject({ root, paths });
    if (!frozen.ok) throw new Error(`the fixture's paths cannot be frozen: ${frozen.error}`);
    await writeSubject(root, taskId, frozen.subject);
    await ensureAssurance(root, taskId, 'observed');

    // One claim per criterion, and the risk space the tier requires covered by construction: the strict contract is three
    // classes, and a ledger that named only one would be refused for a coverage gap rather than for what the fixture tests.
    const classes = ['consistency', 'boundary', 'failure_mode'] as const;
    const target = paths[0] ?? 'task-owned.txt';
    const subjects = criteria.length > 0 ? criteria : ['C1'];
    const claims = [...subjects.map((id, index) => ({ id, riskClass: classes[index % classes.length]!, evidenceId: `E-${id}` }))];
    for (const [index, riskClass] of classes.entries()) {
        const id = `C-tier-${index}`;
        if (!claims.some((claim) => claim.id === id)) claims.push({ id, riskClass, evidenceId: `E-${id}` });
    }

    for (const claim of claims) {
        await appendClaim(root, taskId, {
            id: claim.id,
            statement: `the ${claim.id} case holds for the sealed revision`,
            riskClass: claim.riskClass,
            severity: 'major',
            dependsOn: [`path:${target}`],
            evidenceIds: [claim.evidenceId],
            challengeIds: [],
            status: 'open',
            at: '',
            reopens: 0,
        });
        await appendEvidence(root, taskId, {
            id: claim.evidenceId,
            type: 'executable_falsifier',
            // The mutation removes a literal the check greps for, so the check reddens — the three steps a falsifier is
            // for, on the scratch file the fixture really wrote.
            command: `grep -q sealed ${target}`,
            mutation: { file: target, find: 'sealed', replace: 'broken' },
        });
    }
    const frozenAgain = await freezeSubject({ root, paths });
    if (!frozenAgain.ok) throw new Error(frozenAgain.error);
    const verdicts = await Promise.all(claims.map(async (claim) => ({
        evidenceId: claim.evidenceId,
        evidenceType: 'executable_falsifier' as const,
        verdict: 'supported' as const,
        observed: 'fixture: the check reddens under its own mutation',
        at: new Date().toISOString(),
        verifier: 'tests/helpers/ledger#fixture',
        subjectRevision: frozenAgain.subject.revision,
        producer: { runId: 'fixture-run', actor: 'fixture' },
    })));
    await recordVerdicts(root, taskId, verdicts);
    // The discovery floor asks for one independent challenge above the standard tier; a probe that was asked and answered
    // is that challenge in the form this route records.
    const probeId = 'P-fixture';
    await appendProbe(root, taskId, {
        id: probeId,
        claimId: claims[0]!.id,
        kind: 'file-exists',
        path: target,
        command: `test -f ${target}`,
        askedAt: new Date().toISOString(),
        // **Frozen to the revision that asked it.** A question with no revision on it is a legacy record: it stays
        // readable, and it cannot count as a reading about the content under review — which is what this fixture needs.
        subjectRevision: frozenAgain.subject.revision,
    });
    await answerProbe(root, taskId, {
        probeId,
        command: `test -f ${target}`,
        observed: 'exit 0: the file the claim rests on exists at this revision',
        answeredAt: new Date().toISOString(),
        // The answer copies the fact it answers, so the projection can check it against the question rather than trust it.
        subjectRevision: frozenAgain.subject.revision,
        path: target,
        expected: 'exists',
    });
    // **The plan is now part of what an approval needs.** `verifyAgainstRequest` compares what the reviewer was handed
    // with what arrived, and a request is derived from the stored plan — so a change that never planned has no reading
    // sets for the check to compare, and the approval is refused with that reason. Recording the plan is the fixture's
    // job for the same reason recording the claims is: an approval rests on the flow having been walked.
    await writePlan(root, taskId, planReview({
        subject: frozenAgain.subject,
        claims: (await readLedger(root, taskId)).claims,
        policy: defaultPolicy(),
        tier: 'strict',
        changedPaths: Object.keys(frozenAgain.subject.pathDigests),
        c0Tokens: null,
    }));
}
