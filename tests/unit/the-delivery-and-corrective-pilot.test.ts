import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { currentRevisionPath, initLayout, reviewPath } from '../../src/core/layout.js';
import { runCommand } from '../../src/workflow/orchestrator.js';
import { runDependencyCommand } from '../../src/cli/dependency.js';
import { runCorrectiveCommand } from '../../src/cli/corrective.js';
import { runRelationsCommand } from '../../src/cli/relations.js';
import { dependencyIdentityFor, dependencyRefusal, readTaskDependency } from '../../src/workflow/task-dependency.js';
import { readCorrectiveActionStatus } from '../../src/workflow/corrective-action.js';
import { readCompletion, recordIntegration } from '../../src/workflow/completion.js';
import { readChangeMetrics, readClassMetrics } from '../../src/workflow/metrics.js';
import { reviewRoundsPath } from '../../src/quality/repair.js';
import { transition } from '../../src/core/state.js';
import { createTaskRevisionIfChanged } from '../../src/workflow/revision.js';
import { computeDiffHash } from '../../src/quality/evidence.js';

/**
 * **The PDSA pilot the design asks for (§7 step 1, §8), run once against the real entries.**
 *
 * The design's own rule is that a pilot states its predictions *before* it runs and has adopt/reject conditions, so the
 * predictions are written here and asserted below rather than described afterwards:
 *
 * | # | Prediction |
 * |---|---|
 * | P1 | While the corrective action has not returned, **every** governed entry of the delivery slice refuses, and the refusal names the corrective task. |
 * | P2 | Recording the return requires the corrective action's **own** certification: a Judge PASS *and* an approved review bound to its revision. A Judge PASS alone is refused. |
 * | P3 | After the return, `judge` and `archive` stay refused until the delivery slice has **re-certified under the returned dependency** — re-sealing alone is not enough (`revalidated_under_an_older_dependency`). |
 * | P4 | `completion status` never reports a delivered state while the return is unrecorded, and never before the target integration is recorded and checked. |
 * | P5 | The class is **one** open class with the delivery slice as its dependent task, and it is discharged by the corrective action's certification. |
 * | P6 | The mechanism itself requires **one** certification of the corrective action and **one** re-certification of the delivery slice — no extra round for its own sake. **Measured: P6 was wrong in the delivery slice's favour**, so the prediction is kept and the result recorded below rather than rewritten: the slice spends **one** seal, not a refused seal plus a re-seal, because the dependency refuses the first seal *before* it mints anything. |
 *
 * Adopt if all six hold; reject (and name which failed) otherwise. What this pilot cannot measure is wall-clock or token cost
 * in any honest sense: it runs in a fixture, in test time, with its verdicts written by the fixture convention. That is a
 * property of the pilot, not of the mechanism, and the cost reading is `kata-cli metrics` on real changes.
 */
const delivery = 'pilot-delivery';
const corrective = 'pilot-corrective';
const roots: string[] = [];
afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const passingCheck = (root: string) => ({ kind: 'test' as const, command: process.execPath, args: ['-e', 'process.exit(0)'], cwd: root });

/** The fixture convention every existing case uses for a verdict: the pilot's subject is the dependency, not how a PASS is made. */
async function writeVerdicts(root: string, taskId: string, revisionId: string, options: { judgeDependencyIdentity?: string } = {}): Promise<void> {
    const revision = JSON.parse(await readFile(join(root, '.kata/tasks', taskId, 'revisions', `${revisionId}.json`), 'utf8')) as { manifestHash: string };
    const diffHash = await computeDiffHash(root);
    await mkdir(join(root, '.kata', 'evidence'), { recursive: true });
    const evidenceId = `evidence-${taskId}`;
    await writeFile(join(root, '.kata/evidence', `${taskId}-pilot.json`), `${JSON.stringify({
        id: evidenceId, taskId, kind: 'test', command: 'npm test', exitCode: 0,
        startedAt: '2026-10-18T00:00:00.000Z', finishedAt: '2026-10-18T00:00:01.000Z',
        diffHash, revisionId,
    })}\n`);
    await writeFile(reviewPath(root, taskId), `${JSON.stringify({
        revisionId, manifestHash: revision.manifestHash, reviewedRevisionId: revisionId,
        recordedAt: '2026-10-18T00:01:00.000Z', reviewEvidence: 'the independent round that accepted this work',
        findings: [], status: 'approved',
        ...(options.judgeDependencyIdentity === undefined ? {} : { dependencyIdentity: options.judgeDependencyIdentity }),
    })}\n`);
    await writeFile(join(root, '.kata/tasks', taskId, 'judge.json'), `${JSON.stringify({
        taskId, result: 'PASS', diffHash, revisionId, manifestHash: revision.manifestHash,
        acceptance: [{ id: 'AC-1', result: 'PASS', evidenceIds: [evidenceId] }], evidenceIds: [evidenceId],
        ...(options.judgeDependencyIdentity === undefined ? {} : { dependencyIdentity: options.judgeDependencyIdentity }),
    })}\n`);
}

async function fixture(): Promise<{ root: string; relationId: string }> {
    const root = await mkdtemp(join(tmpdir(), 'kata-pilot-'));
    roots.push(root);
    await initLayout(root);
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src', 'delivery.ts'), 'export const delivered = true;\n', 'utf8');
    await writeFile(join(root, 'src', 'corrective.ts'), 'export const repaired = true;\n', 'utf8');
    // A real repository, because the delivery record has to be checked against one.
    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync('git', ['-c', 'user.email=pilot@example.test', '-c', 'user.name=pilot', 'commit', '-qm', 'pilot'], { cwd: root });

    await runCommand('open', delivery, root, { title: 'delivery', acceptance: [{ id: 'AC-1', statement: 'x' }], ownedPaths: ['src/delivery.ts'] });
    await runCommand('open', corrective, root, { title: 'corrective', acceptance: [{ id: 'AC-1', statement: 'x' }], ownedPaths: ['src/corrective.ts'] });
    // **Both slice go through `design` first**, which is what a real change does and what makes a build runnable at all: from
    // `intake` a build refuses before doing anything ("Build cannot run from intake").
    await runCommand('design', delivery, root);
    await runCommand('design', corrective, root);

    // P5's setup: the corrective action declares the class, through the CLI as an operator would.
    const obligationPath = 'tmp/obligation.json';
    await mkdir(join(root, 'tmp'), { recursive: true });
    await writeFile(join(root, obligationPath), `${JSON.stringify({
        states: ['the fact is derived here', 'and here'],
        sourceOfTruth: 'theOneDerivation',
        inventory: ['src/quality/review-ladder.ts:41'],
        invariant: 'both readers ask the same predicate',
        repairSurface: ['src/quality/review-ladder.ts'],
        effectivenessTest: 'tests/unit/a-disposition-has-one-vocabulary.test.ts',
        ifRecursAgain: 'rewrite_mechanism',
    }, null, 2)}\n`);
    await runCorrectiveCommand([
        'declare', '--change', corrective, '--source-change', delivery, '--class', 'one-fact-derived-twice',
        '--owner', 'the-owner', '--obligation-file', obligationPath, '--root', root,
    ]);

    // `--root`, because the CLI resolves the workspace from there rather than from a second argument.
    const graph = await runRelationsCommand([
        'add', '--from', `task:${delivery}`, '--to', `task:${corrective}`, '--type', 'blocked_by',
        '--reason', 'the delivery slice rests on this class-level repair', '--root', root,
    ]) as { relation?: { id?: string } };
    // The command answers with the edge it wrote, which is the id the return has to be recorded against.
    const relationId = graph.relation?.id;
    if (typeof relationId !== 'string') throw new Error(`the pilot could not find the edge it just created: ${JSON.stringify(graph).slice(0, 300)}`);
    return { root, relationId };
}

describe('the PDSA pilot: one delivery slice, one corrective action, through the real entries', () => {
    it('refuses the delivery slice while the corrective action is outstanding, and delivers it once the loop closes', async () => {
        const { root, relationId } = await fixture();

        // ── P1: the delivery slice cannot certify anything while the corrective action is outstanding ────────────────────
        const pending = await readTaskDependency(root, delivery);
        expect(pending.state, 'P1: the dependency is pending').toBe('pending');
        for (const entry of ['seal', 'verify', 'review', 'judge', 'archive'] as const) {
            expect(dependencyRefusal(pending, entry), `P1: ${entry} must refuse`).not.toBeNull();
        }
        // The entry **throws** rather than returning a failed result, which is how a refusal leaves the command; the pilot
        // measures that shape here rather than assuming either, because a caller that only inspects `success` would read a
        // thrown refusal as success.
        const blockedSeal = await runCommand('build', delivery, root, { seal: true, checks: [passingCheck(root)] })
            .then(() => 'SEALED', (error: Error) => error.message);
        expect(blockedSeal, 'P1: the real seal refuses').not.toBe('SEALED');
        expect(blockedSeal).toContain(corrective);
        expect(blockedSeal).toContain('not returned');

        // ── P2: the return needs the corrective action's own certification ───────────────────────────────────────────────
        // A Judge PASS alone is refused — the writer asks the same question the gate asks, and "accepted by nobody but its
        // author" is not an acceptance. The pilot measures that by certifying in the wrong order first.
        const sealedCorrective = await createTaskRevisionIfChanged({ root, taskId: corrective, ownedPaths: ['src/corrective.ts'], checkIds: [] });
        await writeFile(join(root, '.kata/tasks', corrective, 'judge.json'), `${JSON.stringify({
            taskId: corrective, result: 'PASS', revisionId: sealedCorrective.revision.id,
            acceptance: [{ id: 'AC-1', result: 'PASS' }],
        })}\n`);
        const premature = await runDependencyCommand(['record', '--change', delivery, '--relation', relationId, '--root', root])
            .then(() => 'RECORDED', (error: Error) => error.message);
        expect(premature, 'P2: a Judge PASS without an approved review must be refused').toContain('no approved independent review');
        expect(premature).toContain('kata-cli review');

        // Now the corrective action's whole certification, and the same write succeeds.
        await writeVerdicts(root, corrective, sealedCorrective.revision.id);
        const recorded = await runDependencyCommand(['record', '--change', delivery, '--relation', relationId, '--root', root]) as { state?: string };
        expect(recorded.state, 'P2: with both verdicts the return records').toBe('ready_to_revalidate');

        // ── P3: the delivery slice must re-certify under the returned dependency ─────────────────────────────────────────
        const returned = await readTaskDependency(root, delivery);
        expect(returned.state).toBe('ready_to_revalidate');
        expect(dependencyRefusal(returned, 'seal'), 'the seal is how it re-certifies').toBeNull();
        expect(dependencyRefusal(returned, 'judge'), 'P3: judge stays closed').not.toBeNull();
        expect(dependencyRefusal(returned, 'archive'), 'P3: archive stays closed').not.toBeNull();

        // Re-sealing alone is not re-certification: with no judge record naming the new dependency identity, the state is the
        // named re-validation state rather than a pass.
        const resealed = await runCommand('build', delivery, root, { seal: true, checks: [passingCheck(root)] });
        expect(resealed.success, `the re-seal runs: ${String(resealed.error ?? '')}`).toBe(true);
        const afterReseal = await readTaskDependency(root, delivery);
        expect(afterReseal.state, 'P3: a re-seal alone does not re-validate').toBe('ready_to_revalidate');
        expect(afterReseal.blockers[0]?.reason).toBe('revalidated_under_an_older_dependency');

        // And the certification that does name the dependency identity closes it.
        const deliveryRevision = JSON.parse(await readFile(currentRevisionPath(root, delivery), 'utf8')).id as string;
        const identity = await dependencyIdentityFor(root, delivery);
        expect(identity).not.toBeNull();
        await writeVerdicts(root, delivery, deliveryRevision, { judgeDependencyIdentity: identity as string });
        const revalidated = await readTaskDependency(root, delivery);
        expect(revalidated.state, 'P3: re-certified under the returned dependency').toBe('revalidated');
        expect(dependencyRefusal(revalidated, 'judge')).toBeNull();
        expect(dependencyRefusal(revalidated, 'archive')).toBeNull();

        // ── P4: the completion record follows the integration, not the certification ─────────────────────────────────────
        const approved = await readCompletion(root, delivery);
        expect(approved.state, 'P4: certified is not delivered').toBe('approved_awaiting_integration');
        expect(approved.road).toContain('kata-cli completion integrate');

        const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
        await recordIntegration({
            root, taskId: delivery, target: 'HEAD', commit, check: { command: process.execPath, args: ['-e', 'process.exit(0)'] },
        });
        const integrated = await readCompletion(root, delivery);
        expect(integrated.state, 'P4: integrated but not archived').not.toBe('delivered_and_archived');
        expect(integrated.reason).toBe('archive_not_reached');

        // **The rest of the ladder is driven through the state machine's own writer**, not by hand-writing a phase: the seal
        // left the slice in `hardVerify`, and the legal forward sequence is review → judge → distill → archive. What the pilot
        // measures is the completion decision and its containment; the verify/judge ladders are other cases' subject (and a
        // pilot that re-implemented them would be measuring itself).
        const actor = { id: 'kata-cli', role: 'distiller' } as const;
        for (const phase of ['review', 'judge', 'distill', 'archive'] as const) {
            await transition(delivery, phase, actor, { root });
        }
        const delivered = await readCompletion(root, delivery);
        expect(delivered.state, 'P4: integrated and archived is the normal Done').toBe('delivered_and_archived');

        // ── P5: one open class, with this delivery slice named as its dependent ─────────────────────────────────────────
        const classStatus = await readCorrectiveActionStatus(root, corrective);
        expect(classStatus.declaration?.classKey, 'P5: the class is the one the round reported').toBe('one-fact-derived-twice');
        expect(classStatus.discharged, 'P5: the corrective certification discharges it').toBe(true);

        // The reading an operator would use, and the same objects the gates built: a state *name*, not a second derivation.
        const metrics = await readChangeMetrics(root, delivery);
        expect(metrics.phase).toBe('archive');
        expect(metrics.completion).toBe('delivered_and_archived');
        expect(metrics.dependency).toBe('revalidated');
        // One revision, which is P6's correction: the blocked seal at the start minted nothing, so the slice never paid for a
        // half-product and then a re-seal — it paid for one seal, made at the moment it was allowed to certify.
        expect(metrics.revisions.count).toBe(1);
        // The class reading is its own view, and it names this change as the dependent one.
        const classes = await readClassMetrics(root);
        const openClass = classes.classes.find((entry) => entry.classKey === 'one-fact-derived-twice');
        expect(openClass, 'P5: the class is readable').toBeDefined();
        expect(openClass?.dependentTasks, 'P5: and it names this change').toEqual([delivery]);
        expect(openClass?.roundsAfterDeclaration, 'P5: the delivery slice opened no round after the declaration').toBe(0);

        // ── P6: one certification for the corrective action, one seal for the delivery slice, no extra round ────────────
        // Counted from the records rather than asserted as prose. The prediction said the delivery slice would spend a
        // refused seal *plus* a re-seal; the measurement says the refusal happens before minting, so it spends one seal. That
        // is the pilot's one wrong prediction, recorded rather than retro-fitted.
        const { readdir } = await import('node:fs/promises');
        expect((await readdir(join(root, '.kata/tasks', corrective, 'revisions'))).length, 'P6: one certification for C').toBe(1);
        expect((await readdir(join(root, '.kata/tasks', delivery, 'revisions'))).length, 'P6: ONE seal for D — the blocked one minted nothing').toBe(1);
        // No review round was opened by the mechanism: the delivery slice's rounds are the ones its own work recorded (none
        // here), and the dependency answer came from records rather than from a round.
        const rounds = await readFile(reviewRoundsPath(root, delivery), 'utf8').catch(() => '');
        expect(rounds.trim(), 'P6: the dependency mechanism opens no round of its own').toBe('');
    });
});
