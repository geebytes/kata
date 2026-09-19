import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initLayout } from '../../src/core/layout.js';
import { createTask } from '../../src/core/task.js';
import { runCommand } from '../../src/workflow/orchestrator.js';
import { evaluateClaims, validateClaims } from '../../src/quality/claims.js';

/**
 * §17.3's Definition of Done, as three conditions the platform can actually evaluate.
 *
 * The section's real contribution is the last paragraph: **the loop terminates on stability**, not on "one more round
 * found nothing". This test asserts each condition the platform holds, and names the one it does not (a seeded false claim
 * being *demonstrated* red belongs to the project's own checker — see §16's K/P split).
 */
describe('the Definition of Done, condition by condition', () => {
    const roots: string[] = [];
    afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

    async function task(claims: Array<Record<string, unknown>>): Promise<string> {
        const root = await mkdtemp(join(tmpdir(), 'kata-dod-'));
        roots.push(root);
        await initLayout(root);
        await createTask({ root, id: 'dod', title: 'DoD', ownedPaths: ['src/'], acceptance: [{ id: 'AC-1', statement: 'x', claims: claims as never }] });
        await mkdir(join(root, 'src'), { recursive: true });
        await writeFile(join(root, 'src/a.py'), 'x = 1\n', 'utf8');
        await writeFile(
            join(root, '.kata-config.json'),
            JSON.stringify({ quality: { discoverChecks: false, buildChecks: [{ id: 'noop', name: 'noop', kind: 'lint', command: 'true' }] } }),
            'utf8',
        );
        await runCommand('design', 'dod', root, {});
        return root;
    }

    it('condition 1: every claim exits as declared, and an unfalsifiable claim is refused', async () => {
        const holds = await task([{ id: 'c1', statement: 'x is 1', check: { command: 'node', args: ['-e', 'process.exit(0)'], expect: { exitCode: 0 } } }]);
        expect((await runCommand('build', 'dod', holds, { seal: true })).success).toBe(true);

        // "Demonstrated able to fail" is enforced as a property of the declaration: a check with no expectation cannot red.
        expect(validateClaims([{ id: 'AC-1', statement: 'x', claims: [{ id: 'c', statement: 'x', check: { command: 'true', expect: undefined as never } }] }])).toHaveLength(1);
    });

    it('condition 1 fails the gate when a claim is contradicted', async () => {
        const contradicted = await task([{ id: 'c1', statement: 'x is 2', check: { command: 'node', args: ['-e', 'process.exit(3)'], expect: { exitCode: 0 } } }]);
        const result = await runCommand('build', 'dod', contradicted, { seal: true });

        expect(result.success).toBe(false);
        expect(JSON.stringify(result.diagnostics)).toContain('x is 2');
    });

    it('condition 3 leaves minor findings ungated but recorded, and blocks on blocking ones', async () => {
        const root = await task([]);
        const { writeAdversarialRecord, adversarialGateFor } = await import('../../src/quality/adversarial.js');
        // The gate is about a revision, so the fixture seals one: a gate with nothing sealed answers `no_revision`, which
        // is the correct refusal and not what this test is about.
        const { createTaskRevision } = await import('../../src/workflow/revision.js');
        const { issueAdversarialBrief } = await import('../../src/quality/adversarial.js');
        const sealed = await createTaskRevision({ root, taskId: 'dod', ownedPaths: ['src/a.py'], checkIds: [] });
        // The gate also requires a brief kata really issued for this node and revision — the 49d1aae property.
        const brief = await issueAdversarialBrief(root, 'dod', 'verify');

        await writeAdversarialRecord(root, 'dod', {
            node: 'verify',
            status: 'recorded',
            revisionId: sealed.id,
            manifestHash: sealed.manifestHash,
            briefSha256: brief.sha256,
            createdAt: '2026-09-19T00:00:00.000Z',
            executedInFreshContext: true,
            attempts: [{ hypothesis: 'h', method: 'm', outcome: 'confirmed' }],
            verdict: 'defects_found',
            findings: [{ id: 'n1', taskId: 'dod', severity: 'nit', message: 'naming' }],
        });
        // A nit does not gate: the gate reports it and stays satisfied.
        expect(await adversarialGateFor(root, 'dod', 'verify')).toMatchObject({ satisfied: true });

        await writeAdversarialRecord(root, 'dod', {
            node: 'verify',
            status: 'recorded',
            revisionId: sealed.id,
            manifestHash: sealed.manifestHash,
            briefSha256: brief.sha256,
            createdAt: '2026-09-19T00:01:00.000Z',
            executedInFreshContext: true,
            attempts: [{ hypothesis: 'h', method: 'm', outcome: 'confirmed' }],
            verdict: 'defects_found',
            findings: [{ id: 'b1', taskId: 'dod', severity: 'blocking', message: 'must be repaired' }],
        });
        // A blocking finding does.
        const gate = await adversarialGateFor(root, 'dod', 'verify');
        expect(gate.findings.map((finding) => finding.id)).toContain('b1');
    });

    it('the stopping condition is stability, which the platform expresses as the manifest hash', async () => {
        const root = await task([]);
        const { createTaskRevision, readCurrentTaskRevision } = await import('../../src/workflow/revision.js');
        const { bindsToRevision } = await import('../../src/workflow/verdict-binding.js');
        const { currentRevisionIdentity } = await import('../../src/workflow/verdict-binding.js');

        const sealed = await createTaskRevision({ root, taskId: 'dod', ownedPaths: ['src/a.py'], checkIds: [] });
        // A verdict about exactly this artifact…
        expect(bindsToRevision({ manifestHash: sealed.manifestHash }, await currentRevisionIdentity(root, 'dod'))).toBe(true);

        // …stops speaking for it the moment the artifact changes. "One more round found nothing" is a heuristic; this is
        // the condition: the artifact is the one that was judged.
        await writeFile(join(root, 'src/a.py'), 'x = 2\n', 'utf8');
        const resealed = await createTaskRevision({ root, taskId: 'dod', ownedPaths: ['src/a.py'], checkIds: [] });
        expect(resealed.manifestHash).not.toBe(sealed.manifestHash);
        expect(bindsToRevision({ manifestHash: sealed.manifestHash }, await currentRevisionIdentity(root, 'dod'))).toBe(false);
        // And unchanged content re-sealed is still the same artifact, so stability is not "no new revision id".
        expect(bindsToRevision({ manifestHash: resealed.manifestHash }, await currentRevisionIdentity(root, 'dod'))).toBe(true);
        void readCurrentTaskRevision;
    });

    it('a resolved claim set with no claims is vacuously satisfied, which is honest for prose', async () => {
        const { ran, failures } = evaluateClaims([{ id: 'AC-1', statement: 'still prose' }], []);
        expect(ran).toEqual([]);
        expect(failures).toEqual([]);
    });
});
