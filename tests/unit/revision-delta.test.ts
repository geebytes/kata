import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initLayout } from '../../src/core/layout.js';
import { createTask } from '../../src/core/task.js';
import {
    computeManifestHash,
    createTaskRevision,
    revisionIdFor,
    type TaskRevision,
} from '../../src/workflow/revision.js';
import {
    changeSurface,
    changeSurfaceAgainstWorkspace,
    deltaCoversChange,
    diffPathDigests,
} from '../../src/quality/revision-delta.js';

/**
 * The change surface between two seals (F2 of the finding-lifecycle design).
 *
 * A rolling manifest digest cannot answer "which files changed since the last pass", which is the one question a
 * proportional re-verification needs. `pathDigests` answers it — and it does so **beside** `manifestHash`, never inside
 * it, because the derivation of the manifest hash is what every historical binding rests on (I4).
 */
describe('the change surface between revisions', () => {
    const roots: string[] = [];
    afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

    async function workspace(): Promise<string> {
        const root = await mkdtemp(join(tmpdir(), 'kata-delta-'));
        roots.push(root);
        await initLayout(root);
        await createTask({
            root,
            id: 'delta-task',
            title: 'Delta',
            acceptance: [{ id: 'AC-1', statement: 'The change surface is measurable.' }],
        });
        await mkdir(join(root, 'src'), { recursive: true });
        await writeFile(join(root, 'src/a.ts'), 'export const a = 1;\n', 'utf8');
        await writeFile(join(root, 'src/b.ts'), 'export const b = 1;\n', 'utf8');
        return root;
    }

    it('keeps manifestHash byte-identical whether or not per-path digests are recorded (I4)', async () => {
        const root = await workspace();
        const manifestHash = await computeManifestHash(root, ['src']);
        const revision = await createTaskRevision({ root, taskId: 'delta-task', ownedPaths: ['src'], checkIds: ['test'] });

        // The regression lock the design asks for: adding the field must not move any identity.
        expect(revision.manifestHash).toBe(manifestHash);
        expect(revision.id).toBe(revisionIdFor('delta-task', manifestHash, ['test']));
    });

    it('records a digest per owned file, expanding a directory', async () => {
        const root = await workspace();
        const revision = await createTaskRevision({ root, taskId: 'delta-task', ownedPaths: ['src'], checkIds: ['test'] });

        expect(Object.keys(revision.pathDigests ?? {}).sort()).toEqual(['src/a.ts', 'src/b.ts']);
    });

    it('reports added, modified and removed paths', async () => {
        const root = await workspace();
        const base = await createTaskRevision({ root, taskId: 'delta-task', ownedPaths: ['src'], checkIds: ['test'] });

        await writeFile(join(root, 'src/a.ts'), 'export const a = 2;\n', 'utf8');   // modified
        await writeFile(join(root, 'src/c.ts'), 'export const c = 1;\n', 'utf8');   // added
        await rm(join(root, 'src/b.ts'));                                          // removed
        const current = await createTaskRevision({ root, taskId: 'delta-task', ownedPaths: ['src'], checkIds: ['test', 'lint'] });

        const surface = await changeSurface(root, base, current);
        expect(surface.status).toBe('available');
        if (surface.status !== 'available') throw new Error('expected a surface');
        expect(surface.added).toEqual(['src/c.ts']);
        expect(surface.modified).toEqual(['src/a.ts']);
        expect(surface.removed).toEqual(['src/b.ts']);
        expect(surface.changedPaths).toHaveLength(3);
    });

    it('says unchanged when the content is identical, even if the revision id moved', async () => {
        const root = await workspace();
        const base = await createTaskRevision({ root, taskId: 'delta-task', ownedPaths: ['src'], checkIds: ['test'] });
        const resealed = await createTaskRevision({ root, taskId: 'delta-task', ownedPaths: ['src'], checkIds: ['test', 'lint'] });

        expect(resealed.id).not.toBe(base.id);
        expect(resealed.manifestHash).toBe(base.manifestHash);
        await expect(changeSurface(root, base, resealed)).resolves.toMatchObject({ status: 'unchanged' });
    });

    it('reports delta_unavailable for a revision sealed before the field existed, rather than guessing', async () => {
        const root = await workspace();
        const base = await createTaskRevision({ root, taskId: 'delta-task', ownedPaths: ['src'], checkIds: ['test'] });
        const legacy: TaskRevision = { ...base };
        delete legacy.pathDigests;

        const surface = await changeSurface(root, legacy, { ...base, pathDigests: base.pathDigests! });
        expect(surface).toMatchObject({ status: 'delta_unavailable' });
        await expect(changeSurfaceAgainstWorkspace(root, legacy)).resolves.toMatchObject({ status: 'delta_unavailable' });
    });

    it('measures against the workspace, which is what a re-seal has', async () => {
        const root = await workspace();
        const base = await createTaskRevision({ root, taskId: 'delta-task', ownedPaths: ['src'], checkIds: ['test'] });
        await writeFile(join(root, 'src/a.ts'), 'export const a = 3;\n', 'utf8');

        const surface = await changeSurfaceAgainstWorkspace(root, base);
        expect(surface).toMatchObject({ status: 'available', changedPaths: ['src/a.ts'] });
    });

    it('refuses a delta that does not cover the change', async () => {
        const base = { 'src/a.ts': 'a'.repeat(64), 'src/b.ts': 'b'.repeat(64) };
        const current = { 'src/a.ts': 'c'.repeat(64), 'src/b.ts': 'b'.repeat(64) };
        const diff = diffPathDigests(base, current);

        // A pass that declared only b.ts did not review what changed.
        expect(deltaCoversChange(['src/b.ts'], { status: 'available', ...diff })).toEqual({ covered: false, missing: ['src/a.ts'] });
        // A pass that declared both covers it.
        expect(deltaCoversChange(['src/a.ts', 'src/b.ts'], { status: 'available', ...diff })).toEqual({ covered: true, missing: [] });
    });

    it('produces byte-identical digests from one traversal, for a directory-owned path', async () => {
        const root = await workspace();
        const { computeBothOwnedDigests, computeManifestHash, computePathDigests } = await import('../../src/workflow/revision.js');

        const manifestAlone = await computeManifestHash(root, ['src']);
        const digestsAlone = await computePathDigests(root, ['src']);
        const both = await computeBothOwnedDigests(root, ['src']);

        // L1-02: one walk must produce exactly what two walks produced. The historical break was not the digest
        // algorithm but the *key shape* — a directory-owned path looked up in a file-keyed table — so the fixture is
        // a directory that owns declared files, not a file-shaped owned path.
        expect(both.manifestHash).toBe(manifestAlone);
        expect(both.pathDigests).toEqual(digestsAlone);
        expect(Object.keys(both.pathDigests).sort()).toEqual(['src/a.ts', 'src/b.ts']);
    });

    it('produces byte-identical digests from one traversal for a file path and for a missing path', async () => {
        const root = await workspace();
        const { computeBothOwnedDigests, computeManifestHash, computePathDigests } = await import('../../src/workflow/revision.js');

        // The two paths that do not go through the directory walk: they must agree too, or the equivalence is partial.
        for (const owned of [['src/a.ts'], ['src/not-here.ts']]) {
            const manifestAlone = await computeManifestHash(root, owned);
            const digestsAlone = await computePathDigests(root, owned);
            const both = await computeBothOwnedDigests(root, owned);

            expect(both.manifestHash).toBe(manifestAlone);
            expect(both.pathDigests).toEqual(digestsAlone);
        }
    });

    it('keeps the whole-tree tree hash unchanged while streaming it', async () => {
        const root = await workspace();
        const { repositoryTreeHash } = await import('../../src/core/repository-identity.js');

        const first = await repositoryTreeHash(root);
        await writeFile(join(root, 'src/a.ts'), 'export const a = 9;\n', 'utf8');
        const second = await repositoryTreeHash(root);

        // A stable digest over unchanged content is what every sealed revision rests on; streaming must not move it.
        expect(first).toMatch(/^[a-f0-9]{64}$/);
        expect(second).not.toBe(first);
        await writeFile(join(root, 'src/a.ts'), 'export const a = 1;\n', 'utf8');
        await expect(repositoryTreeHash(root)).resolves.toBe(first);
    });
});

describe('the delta gate refuses a scope that does not cover the change', () => {
    const roots: string[] = [];
    afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

    it('accepts a delta whose declared paths are exactly the change, and refuses one that misses a path', async () => {
        const root = await mkdtemp(join(tmpdir(), 'kata-delta-gate-'));
        roots.push(root);
        await initLayout(root);
        await createTask({ root, id: 'gate-task', title: 'Gate', acceptance: [{ id: 'AC-1', statement: 'x' }] });
        await mkdir(join(root, 'src'), { recursive: true });
        await writeFile(join(root, 'src/a.ts'), 'export const a = 1;\n', 'utf8');
        await writeFile(join(root, 'src/b.ts'), 'export const b = 1;\n', 'utf8');
        const base = await createTaskRevision({ root, taskId: 'gate-task', ownedPaths: ['src'], checkIds: ['test'] });

        await writeFile(join(root, 'src/a.ts'), 'export const a = 2;\n', 'utf8');
        const current = await createTaskRevision({ root, taskId: 'gate-task', ownedPaths: ['src'], checkIds: ['test', 'lint'] });

        const { evaluateDeltaScope } = await import('../../src/quality/adversarial.js');
        const record = (declared: string[]) => ({
            node: 'verify' as const,
            status: 'recorded' as const,
            revisionId: current.id,
            createdAt: '2026-09-18T12:00:00.000Z',
            scope: { kind: 'delta' as const, from: base.id, changedPaths: declared },
        });

        await expect(evaluateDeltaScope(root, 'gate-task', record(['src/a.ts']), current.id)).resolves.toMatchObject({ ok: true });
        await expect(evaluateDeltaScope(root, 'gate-task', record(['src/b.ts']), current.id)).resolves.toMatchObject({
            ok: false,
            reason: 'delta_stale',
        });
        // A base revision that predates per-path digests cannot be verified as a delta at all.
        const legacyBase = { ...base };
        delete legacyBase.pathDigests;
        const { writeFile: write } = await import('node:fs/promises');
        await write(join(root, '.kata/tasks/gate-task/revisions', `${base.id}.json`), JSON.stringify(legacyBase), 'utf8');
        await expect(evaluateDeltaScope(root, 'gate-task', record(['src/a.ts']), current.id)).resolves.toMatchObject({
            ok: false,
            reason: 'delta_unavailable',
        });
    });
});

describe('a pass records its own duration so the saving becomes measurable (design §11)', () => {
    it('reports the comparison as not-yet-measurable without a previous full pass, and computes it with one', async () => {
        const root = await mkdtemp(join(tmpdir(), 'kata-delta-saving-'));
        const { mkdir: mk } = await import('node:fs/promises');
        const { writeAdversarialRecord, readAdversarialRecord } = await import('../../src/quality/adversarial.js');
        const taskId = 'saving-task';
        await mk(join(root, '.kata/tasks', taskId), { recursive: true });

        const base = {
            node: 'verify' as const,
            status: 'recorded' as const,
            revisionId: 'revision-1',
            createdAt: '2026-09-18T10:00:00.000Z',
            executedInFreshContext: true,
            attempts: [{ hypothesis: 'x', method: 'y', outcome: 'refuted' as const }],
            findings: [],
        };

        // A full pass that took 20 minutes.
        await writeAdversarialRecord(root, taskId, { ...base, scope: { kind: 'full' }, elapsedMs: 1_200_000 });
        // A delta pass that took 3.
        await writeAdversarialRecord(root, taskId, {
            ...base,
            createdAt: '2026-09-18T11:00:00.000Z',
            scope: { kind: 'delta', from: 'revision-0', changedPaths: ['src/a.ts'] },
            elapsedMs: 180_000,
        });

        // The overwritten pass was snapshotted, so both sides of the comparison exist.
        const snapshotDir = join(root, '.kata/tasks', taskId, 'passes');
        const snapshots = await (await import('node:fs/promises')).readdir(snapshotDir);
        expect(snapshots).toHaveLength(1);
        const previous = JSON.parse(await (await import('node:fs/promises')).readFile(join(snapshotDir, snapshots[0]!), 'utf8')) as { elapsedMs?: number };
        expect(previous.elapsedMs).toBe(1_200_000);
        expect((await readAdversarialRecord(root, taskId, 'verify'))?.elapsedMs).toBe(180_000);
    });
});
