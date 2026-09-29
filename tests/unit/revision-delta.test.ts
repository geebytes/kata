import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { currentRevisionPath, initLayout, revisionPath } from '../../src/core/layout.js';
import { createTask } from '../../src/core/task.js';
import {
    computeManifestHash,
    createTaskRevision,
    createTaskRevisionIfChanged,
    revisionIdFor,
    readCurrentTaskRevision,
    readTaskRevision,
    contentSnapshotHash,
    type TaskRevision,
} from '../../src/workflow/revision.js';
import { repositoryTreeHash } from '../../src/core/repository-identity.js';
import {
    changeSurface,
    changeSurfaceAgainstWorkspace,
    diffPathDigests,
} from '../../src/quality/revision-delta.js';

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

    /**
     * The pre-snapshot revision, **appended to a real seal rather than written beside one**.
     *
     * The fixture used to write `current-revision.json` by hand to put the change "mid-flight on the old identity". That
     * is the third state of a task directory, and **no seal can produce it** — content-bound identity is what a seal
     * mints — so a case built on it asserts what the engine *would* do in a state it never creates, and that is how two
     * earlier drafts of these cases came to assert the opposite of the contract. The rule this helper follows instead:
     * the engine writes the current pointer, always; a fixture may only add records that a task directory from before the
     * change could legitimately contain.
     */
    async function appendHistoricRevision(root: string, taskId: string, id: string, manifestHash: string): Promise<void> {
        const record = JSON.stringify({ id, taskId, ownedPaths: ['src'], manifestHash, createdAt: '2026-01-01T00:00:00.000Z' });
        await mkdir(join(root, '.kata', 'tasks', taskId, 'revisions'), { recursive: true });
        await writeFile(revisionPath(root, taskId, id), `${record}\n`, 'utf8');
    }

    it('keeps manifestHash byte-identical whether or not per-path digests are recorded (I4)', async () => {
        const root = await workspace();
        const manifestHash = await computeManifestHash(root, ['src']);
        const revision = await createTaskRevision({ root, taskId: 'delta-task', ownedPaths: ['src'], checkIds: ['test'] });

        // The regression lock the design asks for: adding per-path digests must not move the manifest hash, so every
        // existing binding keeps its meaning. The **id** now also covers the declaration-independent content snapshot
        // (AC-2), because a revision has to exist for a change the declaration does not cover — and the previous
        // derivation returned the same id for such a round, which is how the change became unrepresentable rather than
        // merely invisible.
        expect(revision.manifestHash).toBe(manifestHash);
        expect(revision.id).toBe(revisionIdFor(
            'delta-task',
            manifestHash,
            ['test'],
            contentSnapshotHash(revision.contentDigests ?? {}),
        ));
        // And the snapshot is what the id now depends on: the same owned manifest with a different repository content
        // must not collapse to the same revision.
        expect(revision.contentDigests).toBeTruthy();
        expect(Object.keys(revision.contentDigests ?? {}).sort()).toEqual(
            expect.arrayContaining(['src/a.ts', 'src/b.ts']),
        );
    });

    it('makes an unowned file above the tree-hash cap change the content-bound revision identity', async () => {
        const root = await workspace();
        await mkdir(join(root, 'assets'), { recursive: true });
        const oversized = join(root, 'assets', 'outside.bin');
        await writeFile(oversized, 'a'.repeat(2_000_001), 'utf8');

        const first = await createTaskRevision({ root, taskId: 'delta-task', ownedPaths: ['src'], checkIds: ['test'] });
        await writeFile(oversized, 'b'.repeat(2_000_001), 'utf8');
        const second = await createTaskRevision({ root, taskId: 'delta-task', ownedPaths: ['src'], checkIds: ['test'] });

        expect(first.contentDigests?.['assets/outside.bin']).toBeDefined();
        expect(second.contentDigests?.['assets/outside.bin']).not.toBe(first.contentDigests?.['assets/outside.bin']);
        expect(second.id).not.toBe(first.id);
    });

    /**
     * **The identity contract, on a fixture the engine can actually produce.**
     *
     * This case replaced four drafts. Drafts 1 and 2 built impossible states (a hand-written pointer; an id discovered by
     * sealing first, which moves the pointer away). Draft 3 asserted a reuse that a pointer-only gate granted — and the
     * adversarial pass showed that gate re-opens the original defect, so the case was recording a bug as a contract.
     * Draft 4 (this one) does the only thing that can be trusted: it **seals repeatedly through the engine** and asserts
     * what comes out, with a historic record merely present in the directory the way a pre-change task directory has one.
     *
     * What it pins, in one place:
     *   • an unowned file moving must move the identity — one id for three content states is the defect this change exists
     *     to remove, and it is what both earlier gates allowed;
     *   • the identity follows the content the declaration cannot see;
     *   • a historic record stays readable and is never rewritten, promoted, or renumbered.
     */
    /**
     * **A historic record is left alone, and never answers for the current content.**
     *
     * The staged state is a task directory from before content-bound identity, and the assertion is about *it* rather than
     * about a pointer this file wrote: the historic record is appended (see the helper), and the case drives the engine
     * from there. The rule it pins is the one §14 settled — the identity is the content-bound derivation and nothing
     * else — and the cost of that rule is measured in the repository's own store rather than asserted here.
     */
    it('leaves a historic record untouched and does not let it answer for the current content', async () => {
        const root = await workspace();
        const manifestHash = await computeManifestHash(root, ['src']);
        const historicId = revisionIdFor('delta-task', manifestHash, ['test']);
        await appendHistoricRevision(root, 'delta-task', historicId, manifestHash);

        const seal = await createTaskRevisionIfChanged({ root, taskId: 'delta-task', ownedPaths: ['src'], checkIds: ['test'] });
        // The historic record is not the identity: the seal mints the content-bound one.
        expect(seal.reused).toBe(false);
        expect(seal.revision.id).not.toBe(historicId);
        expect(seal.revision.contentDigests).toBeDefined();

        // **And the historic file is untouched** — same id, still snapshot-less, still readable by whatever named it.
        // What stopped is its use as the current identity, not its existence.
        const historic = await readTaskRevision(root, 'delta-task', historicId);
        expect(historic.id).toBe(historicId);
        expect(historic.contentDigests).toBeUndefined();
        expect((await readCurrentTaskRevision(root, 'delta-task'))?.id).toBe(seal.revision.id);
    });

    it('moves the identity with content the declaration does not cover', async () => {
        const root = await workspace();
        // A record from before content-bound identity existed. Appended, never made current — see the helper.
        const manifestHash = await computeManifestHash(root, ['src']);
        const historicId = revisionIdFor('delta-task', manifestHash, ['test']);
        await appendHistoricRevision(root, 'delta-task', historicId, manifestHash);
        await mkdir(join(root, 'assets'), { recursive: true });

        const ids: string[] = [];
        const reused: boolean[] = [];
        for (const content of ['one\n', 'two\n', 'three\n']) {
            await writeFile(join(root, 'assets', 'unowned.bin'), content, 'utf8');
            const seal = await createTaskRevisionIfChanged({ root, taskId: 'delta-task', ownedPaths: ['src'], checkIds: ['test'] });
            ids.push(seal.revision.id);
            reused.push(seal.reused);
            // **The pointer is the engine's to write.** Asserting it here is what keeps a future fixture from fabricating
            // current-state: if the engine did not write it, this fails before any identity claim is made.
            expect((await readCurrentTaskRevision(root, 'delta-task'))?.id).toBe(seal.revision.id);
        }

        // Three content states, three identities — none of them the historic one, because the content moved.
        expect(new Set(ids).size).toBe(3);
        expect(reused).toEqual([false, false, false]);
        expect(ids).not.toContain(historicId);
        // And the historic record is untouched: snapshot-less, same id, still readable by whatever bound to it.
        const historic = await readTaskRevision(root, 'delta-task', historicId);
        expect(historic.id).toBe(historicId);
        expect(historic.contentDigests).toBeUndefined();
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
