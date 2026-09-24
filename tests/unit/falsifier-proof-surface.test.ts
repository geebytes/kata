import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initLayout, taskPath } from '../../src/core/layout.js';
import { createTask } from '../../src/core/task.js';
import { mutateTaskArtefact } from '../../src/core/state.js';
import { createTaskRevision, falsifierProofSurface } from '../../src/workflow/revision.js';
import { hasReddening } from '../../src/quality/falsifier-reddenings.js';

/**
 * A falsifier proof is *about* content, and the content it is about is the task's current declaration — not the older
 * revision's frozen one.
 *
 * `rba7-f5` and `rba7-f6`, measured on this change's own ledger: the reddening proving `finding-a4e3edc4` was recorded
 * against `revision-e64139639a2833ef`, whose `pathDigests` held **11** paths, while the mutation was applied to
 * `src/workflow/revision.ts` — a path the task's declaration (23 paths) carried and that revision did not. So the proof
 * named eleven paths that did not include the file it was about, and the closure rule's content binding could not credit it
 * (it fell back to a revision-id comparison that had already moved). The same command's absence door bound the identical kind
 * of proof to `task.ownedPaths`; two doors, two declarations. There is now one derivation, `falsifierProofSurface`, and this
 * pins that it names the mutation's file.
 */
const roots: string[] = [];
afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('a falsifier proof binds to the task declaration, not the older revision', () => {
    it('names a path the task declares but the revision does not carry', async () => {
        const root = await mkdtemp(join(tmpdir(), 'kata-proof-surface-'));
        roots.push(root);
        await initLayout(root);
        await createTask({ root, id: 'p-task', title: 'Proof', acceptance: [{ id: 'AC-1', statement: 'x' }], ownedPaths: ['src/sealed.ts'] });
        await mkdir(join(root, 'src'), { recursive: true });
        await writeFile(join(root, 'src/sealed.ts'), 'sealed\n', 'utf8');
        // The revision is minted over the task's declaration as it stands now: one path.
        const revision = await createTaskRevision({ root, taskId: 'p-task', ownedPaths: ['src/sealed.ts'] });
        expect(Object.keys(revision.pathDigests ?? {})).toEqual(['src/sealed.ts']);

        // The task then declares the file the mutation will touch, and that file exists on disk — but the revision never
        // carried it. This is exactly the measured shape (`src/workflow/revision.ts` on the real change).
        await writeFile(join(root, 'src/mutated.ts'), 'the defect lives here\n', 'utf8');
        await mutateTaskArtefact(root, 'p-task', taskPath(root, 'p-task'), async (raw) => {
            const current = JSON.parse(raw) as Record<string, unknown>;
            return `${JSON.stringify({ ...current, ownedPaths: ['src/sealed.ts', 'src/mutated.ts'] }, null, 2)}\n`;
        });

        const proof = await falsifierProofSurface(root, 'p-task', revision);
        // The surface the proof is recorded against names the mutation's file...
        expect(proof.surface).toContain('src/mutated.ts');
        expect(Object.keys(proof.pathDigests)).toContain('src/mutated.ts');
        // ...and carries a real digest of it, so a later reader can tell the content it was about.
        expect(proof.pathDigests['src/mutated.ts']).toBeTruthy();
        // The sealed path is still named, because proving content must not lose the path the revision described.
        expect(Object.keys(proof.pathDigests)).toContain('src/sealed.ts');
    });

    it('falls back to the revision’s sealed set when the task declares none', async () => {
        const root = await mkdtemp(join(tmpdir(), 'kata-proof-surface-'));
        roots.push(root);
        await initLayout(root);
        // A task with no `ownedPaths` at all (the schema permits it): the sealed set is the only declaration there is.
        await createTask({ root, id: 'p-task', title: 'Proof', acceptance: [{ id: 'AC-1', statement: 'x' }] });
        await mkdir(join(root, 'src'), { recursive: true });
        await writeFile(join(root, 'src/sealed.ts'), 'sealed\n', 'utf8');
        const revision = await createTaskRevision({ root, taskId: 'p-task', ownedPaths: ['src/sealed.ts'] });

        const proof = await falsifierProofSurface(root, 'p-task', revision);
        expect(proof.surface).toEqual(['src/sealed.ts']);
        expect(Object.keys(proof.pathDigests)).toEqual(['src/sealed.ts']);
    });

    it('expires when the mutation’s own file changes, which the revision-only surface could not see', async () => {
        // The harm the recorded keys exist to prevent, stated as a case: the binding is `every recorded digest still
        // matches`. Over the revision-only surface (one path) the recorded set did not include the file the mutation
        // touched, so a proof of a fix in `src/mutated.ts` stayed "true" after that very file changed. Over the task's
        // declaration it does not.
        const root = await mkdtemp(join(tmpdir(), 'kata-proof-surface-'));
        roots.push(root);
        await initLayout(root);
        await createTask({ root, id: 'p-task', title: 'Proof', acceptance: [{ id: 'AC-1', statement: 'x' }], ownedPaths: ['src/sealed.ts'] });
        await mkdir(join(root, 'src'), { recursive: true });
        await writeFile(join(root, 'src/sealed.ts'), 'sealed\n', 'utf8');
        const revision = await createTaskRevision({ root, taskId: 'p-task', ownedPaths: ['src/sealed.ts'] });
        await writeFile(join(root, 'src/mutated.ts'), 'the defect lives here\n', 'utf8');
        await mutateTaskArtefact(root, 'p-task', taskPath(root, 'p-task'), async (raw) => {
            const current = JSON.parse(raw) as Record<string, unknown>;
            return `${JSON.stringify({ ...current, ownedPaths: ['src/sealed.ts', 'src/mutated.ts'] }, null, 2)}\n`;
        });
        const proof = await falsifierProofSurface(root, 'p-task', revision);
        const record = { findingId: 'f1', check: 'c', mutation: 'm', revisionId: revision.id, pathDigests: proof.pathDigests, observed: { before: 0, mutated: 1, after: 0 }, reddenedAt: 'x' };

        // The mutation's file changes after the proof was recorded — the content the proof is about is no longer there.
        await writeFile(join(root, 'src/mutated.ts'), 'changed after the proof\n', 'utf8');
        const after = await falsifierProofSurface(root, 'p-task', revision);
        expect(hasReddening([record], 'f1', { revisionId: revision.id, pathDigests: after.pathDigests })).toBe(false);
        // The revision-only surface would have missed it: the changed file was not among its recorded keys.
        expect(Object.keys(revision.pathDigests ?? {})).not.toContain('src/mutated.ts');
    });
});
