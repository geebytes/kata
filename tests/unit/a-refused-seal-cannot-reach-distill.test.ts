import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { currentRevisionPath, initLayout, reviewPath, revisionsDir } from '../../src/core/layout.js';
import { runCommand } from '../../src/workflow/orchestrator.js';
import { buildChangeRecord, writeChangeRecord } from '../../src/quality/change-record.js';
import { reviewRoundsPath } from '../../src/quality/repair.js';
import { createTaskRevisionIfChanged } from '../../src/workflow/revision.js';
import { assertDistillGates, evaluateDistillGates } from '../../src/workflow/distill-gates.js';
import { computeDiffHash } from '../../src/quality/evidence.js';

/**
 * **A refused seal leaves an uncertified revision current — and the gates refuse it anyway.**
 *
 * §6.5 asks that "failed seal 不发布半成品"; `#7` of the project assessment measured that the implementation does *not* meet
 * that as written, and this case corrects two things about how that was first reported.
 *
 * **First, the refusal is not specific to the closure-contract gate.** The earlier report named `closure_obligation_unmet`,
 * which was a different change's refusal; measured here, a seal refused by its own **failing check** moves the pointer just
 * the same. The advance is structural: the revision is minted and published at mint time, and a later refusal on any step
 * does not roll it back. **Second, the advance needs a phase a build may run from** — from `intake` the seal refuses before
 * minting anything, so a fixture in that state reports the hazard as absent for a reason unrelated to it.
 *
 * What the measurement could not answer — and what the recommendation to leave it alone was *conditional* on — was whether
 * anything downstream still refuses that revision, or whether the pointer having moved means an uncertified state can reach
 * distill and archive.
 *
 * This case answers it with the real entries, and the answer is that the advance is contained:
 *
 * - a baseline where all three gates are **green** (fresh evidence bound to the revision, a cleared review, a Judge PASS);
 * - a genuine refused seal, which does advance the pointer (the measured fact is asserted, not assumed);
 * - and then the gates refuse, naming the reason — `stale_judgement`, because the Judge's verdict was bound to the revision
 *   the seal *did* certify rather than to the one now current.
 *
 * So the hazard is real but scope-limited: a half-product is published as *current*, and nothing may rest on it. That is the
 * evidence behind leaving `#7` as a recorded gap rather than a repair — and if a later change makes the gates stop refusing,
 * this case is what reddens.
 */
const taskId = 'refused-seal';
const roots: string[] = [];
afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** A change certified for a shape the closure contract can never satisfy: the repair surface it names cannot be checked. */
async function certifiedUnderAnUnmeetableObligation(): Promise<{ root: string; certified: string }> {
    const root = await mkdtemp(join(tmpdir(), 'kata-refused-seal-'));
    roots.push(root);
    await initLayout(root);
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src', 'owned.ts'), 'export const holds = true;\n', 'utf8');
    await runCommand('open', taskId, root, { title: 'refused seal', acceptance: [{ id: 'AC-1', statement: 'x' }], ownedPaths: ['src/owned.ts'] });
    // **`design` first, because a build may not run from `intake`.** Measured: without it the seal refuses with "Build cannot
    // run from intake" *before* minting anything, and a fixture in that state would report the hazard as absent for a reason
    // that has nothing to do with it.
    await runCommand('design', taskId, root);

    const sealed = await createTaskRevisionIfChanged({ root, taskId, ownedPaths: ['src/owned.ts'], checkIds: [] });
    const record = await buildChangeRecord({
        root, taskId, revisionId: sealed.revision.id, ownedPaths: ['src/owned.ts'], evidence: [], claimFailures: [], findings: [],
    });
    const written = await writeChangeRecord(root, taskId, record);
    if (typeof written !== 'string') throw new Error(written.refused.join('; '));

    // Two rounds of one mechanizable class, the later one inside the earlier's repair: the shape that makes the seal's
    // closure contract unavoidable, so the next seal is refused for a reason that has nothing to do with this case.
    await writeFile(reviewRoundsPath(root, taskId), [
        JSON.stringify({
            at: '2026-01-01T00:00:00.000Z', revisionId: sealed.revision.id, manifestHash: sealed.revision.manifestHash,
            blockingIds: ['F-1'], blockingCount: 1, findings: [{ id: 'F-1', severity: 'major', class: 'instrument-unsound', origin: 'original' }],
        }),
        JSON.stringify({
            at: '2026-01-02T00:00:00.000Z', revisionId: sealed.revision.id, manifestHash: sealed.revision.manifestHash,
            blockingIds: ['F-2'], blockingCount: 1, findings: [{ id: 'F-2', severity: 'major', class: 'instrument-unsound', origin: 'repair' }],
        }),
    ].join('\n') + '\n');

    const certified = JSON.parse(await readFile(currentRevisionPath(root, taskId), 'utf8')).id as string;
    const diffHash = await computeDiffHash(root);

    // The three gates, green. The evidence is bound to the certified revision, which is what makes it "fresh" here.
    await mkdir(join(root, '.kata', 'evidence'), { recursive: true });
    await writeFile(join(root, '.kata', 'evidence', `${taskId}-e1.json`), `${JSON.stringify({
        id: 'evidence-1', taskId, kind: 'test', command: 'npm test', exitCode: 0,
        startedAt: '2026-01-04T00:00:00.000Z', finishedAt: '2026-01-04T00:00:01.000Z',
        diffHash, revisionId: certified,
    })}\n`);
    await writeFile(reviewPath(root, taskId), `${JSON.stringify({
        revisionId: certified, manifestHash: sealed.revision.manifestHash, reviewedRevisionId: certified,
        reviewEvidence: 'the independent round this change was approved on', findings: [], status: 'approved',
    })}\n`);
    await writeFile(join(root, '.kata', 'tasks', taskId, 'judge.json'), `${JSON.stringify({
        taskId, result: 'PASS', diffHash, revisionId: certified, manifestHash: sealed.revision.manifestHash,
        acceptance: [{ id: 'AC-1', result: 'PASS', evidenceIds: ['evidence-1'] }], evidenceIds: ['evidence-1'],
    })}\n`);

    return { root, certified };
}

describe('an uncertified current revision cannot reach distill', () => {
    it('is green before the refusal, refuses after it, and says which binding moved', async () => {
        const { root, certified } = await certifiedUnderAnUnmeetableObligation();

        const before = await evaluateDistillGates(root, taskId);
        expect(before.freshEvidence?.evidence.id, 'the baseline must be green, or the case proves nothing').toBe('evidence-1');
        expect(before.review.cleared).toBe(true);
        expect(before.judge.passed).toBe(true);
        await expect(assertDistillGates(root, taskId)).resolves.toBeUndefined();

        // The refusal, from the real entry: the round's own conclusion obliges a closure contract this change cannot
        // satisfy, so the seal fails — after minting its revision and moving the pointer, which is `#7`'s measured fact.
        await writeFile(join(root, 'src', 'owned.ts'), 'export const holds = "changed";\n', 'utf8');
        // A check that genuinely fails, so the refusal is the seal's own evidence step rather than an artificial option.
        const refused = await runCommand('build', taskId, root, {
            seal: true,
            checks: [{ kind: 'test', command: process.execPath, args: ['-e', 'process.exit(1)'], cwd: root }],
        });
        expect(refused.success).toBe(false);
        expect(String(refused.error), 'the refusal this case measures is the seal failing after it minted').toContain('sealing failed');

        const now = JSON.parse(await readFile(currentRevisionPath(root, taskId), 'utf8')).id as string;
        expect(now, 'the pointer advancing is the hazard this case is about, so it is asserted rather than assumed').not.toBe(certified);

        // And nothing may rest on it. The Judge's verdict was bound to the revision the seal certified, so for the revision
        // now current it is stale — the content binding is what catches an uncertified current revision, not the closure gate.
        const after = await evaluateDistillGates(root, taskId);
        expect(after.judge).toMatchObject({ passed: false, reason: 'stale_judgement' });
        expect(after.freshEvidence).toBeNull();

        const refusal = await assertDistillGates(root, taskId).then(() => 'NO REFUSAL', (error: Error) => error.message);
        expect(refusal).not.toBe('NO REFUSAL');
        expect(refusal).toContain('stale_judgement');
        expect(refusal).toContain('no fresh passing test evidence is recorded for the current revision');
    });

    it('leaves the sealed revision it did certify intact, so the refusal costs a re-seal rather than the work', async () => {
        const { root, certified } = await certifiedUnderAnUnmeetableObligation();
        const before = (await import('node:fs/promises')).readdir(revisionsDir(root, taskId));

        await writeFile(join(root, 'src', 'owned.ts'), 'export const holds = "changed";\n', 'utf8');
        await runCommand('build', taskId, root, {
            seal: true,
            checks: [{ kind: 'test', command: process.execPath, args: ['-e', 'process.exit(1)'], cwd: root }],
        });

        // The certified revision is still on disk and still the one the Judge's record names: the refused seal added an
        // uncertified one, it did not destroy or overwrite the evidence of what was certified.
        const stored = await before;
        // The store names them by revision id **with** the extension, which the first version of this assertion got wrong.
        expect(stored).toContain(`${certified}.json`);
        const judge = JSON.parse(await readFile(join(root, '.kata', 'tasks', taskId, 'judge.json'), 'utf8')) as { revisionId?: string };
        expect(judge.revisionId).toBe(certified);
    });
});
