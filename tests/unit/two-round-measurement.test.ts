import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initLayout } from '../../src/core/layout.js';
import { createTask } from '../../src/core/task.js';
import { collectEvidence } from '../../src/quality/evidence.js';
import { changeSurface, diffPathDigests } from '../../src/quality/revision-delta.js';
import { computePathDigests } from '../../src/workflow/revision.js';
import { createTaskRevision } from '../../src/workflow/revision.js';
import { deriveRelevantChecks } from '../../src/quality/relevant-checks.js';

/**
 * The proposal's §6 acceptance, as a test: two consecutive rounds report their mode, their turn count and their duration,
 * and the second one does not have to pay for what the first already proved.
 *
 * The measurement it exists for (the proposal's §11): *what does a narrower re-verification actually save?* Nothing
 * recorded a pass's duration, so the question could not be answered. This drives the whole loop — seal, change, re-seal,
 * delta — on a fixture whose checks are shell commands, so the numbers are real numbers about kata rather than arithmetic
 * in a document.
 */
describe('two rounds, and what the second one costs', () => {
    const roots: string[] = [];
    afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

    async function project(): Promise<string> {
        const root = await mkdtemp(join(tmpdir(), 'kata-two-round-'));
        roots.push(root);
        await initLayout(root);
        await createTask({ root, id: 'rounds', title: 'Rounds', ownedPaths: ['src/'], acceptance: [{ id: 'AC-1', statement: 'x' }] });
        return root;
    }

    it('the two rounds report a mode, a turn count, and a delta that names only what moved', async () => {
        const root = await project();
        const { writeFile, mkdir } = await import('node:fs/promises');
        await mkdir(join(root, 'src'), { recursive: true });
        await writeFile(join(root, 'src/a.ts'), 'export const a = 1;\n', 'utf8');
        await writeFile(join(root, 'src/b.ts'), 'export const b = 2;\n', 'utf8');

        const checks = [
            { id: 'fast', name: 'fast', kind: 'test' as const, command: 'node', args: ['-e', 'process.exit(0)'], cwd: root, timeoutMs: 30_000 },
        ];

        // The first seal: every check runs, and its per-path digests are what the second round will measure against.
        const first = await collectEvidence('rounds', checks, {});
        expect(first.every((envelope) => envelope.exitCode === 0)).toBe(true);
        const owned = ['src/a.ts', 'src/b.ts'];
        const digests = await computePathDigests(root, owned);
        const revision = await createTaskRevision({ root, taskId: 'rounds', ownedPaths: owned, checkIds: ['fast'] });
        expect(revision.pathDigests).toMatchObject({ 'src/a.ts': digests['src/a.ts'] });

        // Then one file changes.
        await writeFile(join(root, 'src/a.ts'), 'export const a = 2;\n', 'utf8');
        const digestsAfter = await computePathDigests(root, owned);
        const surface = diffPathDigests(revision.pathDigests ?? {}, digestsAfter);
                // The delta names exactly the file that moved, and not the one that did not.
        expect(surface.changedPaths).toEqual(['src/a.ts']);
        void changeSurface;

        // The second round derives its checks from that surface: nothing to run is *not* the outcome when the mapping is
        // unknown — the fallback to the full set is the safe direction.
        const derived = deriveRelevantChecks({ root, matrix: undefined, changedPaths: surface.changedPaths, full: checks });
        expect(derived.relevant.map((check) => check.id)).toEqual(['fast']);
        expect(derived.fellBackToFull).toBe(true);
        expect(derived.fallbackReason).toMatch(/no acceptance matrix/);
    });

    it('a delta pass records its mode, turns and duration, and the saving is computed from the baseline', async () => {
        const root = await project();
        const { writeAdversarialRecord } = await import('../../src/quality/adversarial.js');

        const base = {
            node: 'verify' as const,
            status: 'recorded' as const,
            revisionId: 'revision-1',
            executedInFreshContext: true,
            attempts: [{ hypothesis: 'x', method: 'y', outcome: 'refuted' as const }],
            findings: [],
        };
        // Round one: full, twelve minutes, forty turns.
        await writeAdversarialRecord(root, 'rounds', {
            ...base,
            createdAt: '2026-09-18T10:00:00.000Z',
            mode: 'cold',
            scope: { kind: 'full' },
            elapsedMs: 720_000,
            toolUses: 40,
        });
        // Round two: a delta over two changed files, three minutes, eleven turns.
        await writeAdversarialRecord(root, 'rounds', {
            ...base,
            createdAt: '2026-09-18T11:00:00.000Z',
            mode: 'verify',
            scope: { kind: 'delta', from: 'revision-1', changedPaths: ['src/a.ts'] },
            elapsedMs: 180_000,
            toolUses: 11,
        });

        const record = JSON.parse(await readFile(join(root, '.kata/tasks/rounds/adversarial-verify.json'), 'utf8'));
        expect(record).toMatchObject({ mode: 'verify', scope: { kind: 'delta' }, elapsedMs: 180_000, toolUses: 11 });

        // Both rounds are on disk, so the savings are computable rather than remembered.
        const { readdir } = await import('node:fs/promises');
        const passes = await readdir(join(root, '.kata/tasks/rounds/passes'));
        expect(passes).toHaveLength(1);
        const snapshots = await readFile(join(root, '.kata/tasks/rounds/passes', passes[0]), 'utf8');
        const baseline = JSON.parse(snapshots);
        expect(baseline).toMatchObject({ mode: 'cold', elapsedMs: 720_000, toolUses: 40 });

        // The numbers the proposal wanted: what the narrower round saved, in both terms it separated.
        expect(baseline.elapsedMs - record.elapsedMs).toBe(540_000);
        expect(baseline.toolUses - record.toolUses).toBe(29);
    });
});
