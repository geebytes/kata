import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initLayout, taskPath } from '../../src/core/layout.js';
import { createTask, readTask } from '../../src/core/task.js';
import { mutateTaskArtefact } from '../../src/core/state.js';
import { createTaskRevision, revisionStatus } from '../../src/workflow/revision.js';

/**
 * A revision's declaration can be outgrown by the task's, and that is not the same fact as its content changing.
 *
 * **Measured, on this change.** `repair-by-another-author` grew its own `ownedPaths` from 11 paths to 22 — with
 * `kata-cli scope change` + `scope apply`, which recorded the decision as `scope-1` — while its sealed revision kept eleven. There
 * were then **two declarations of one surface**, and the freshness check read the older: `revisionStatus` hashed
 * `revision.ownedPaths`, found it unchanged, and reported `current`. `repair-entry.ts` read that as *"the sealed revision still
 * matches the workspace"* and refused the seal — a claim about the workspace decided from a declaration eleven of whose twenty-two
 * paths had never been hashed, and the seal it refused is the only thing that can take on the newer one.
 *
 * So there are three states rather than two, and they ask for different actions: **`declaration-moved`** says the revision is not
 * about the change's declared surface any more (re-seal, which adopts it), and **`superseded`** says the content it described has
 * since changed (the verdict bound to it cannot stand).
 */
const roots: string[] = [];
afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('a revision reports whether the task has outgrown its declaration', () => {
    it('says declaration-moved when the task declares paths the revision does not carry', async () => {
        const root = await mkdtemp(join(tmpdir(), 'kata-declared-'));
        roots.push(root);
        await initLayout(root);
        // **The task's declaration and the revision's agree to begin with**, or the state under test fires immediately — `createTask`
        // defaults to `tasks/<id>`, so the declaration is set to the path the revision will describe.
        await createTask({ root, id: 'd-task', title: 'Declared', acceptance: [{ id: 'AC-1', statement: 'x' }], ownedPaths: ['src/a.ts'] });
        await mkdir(join(root, 'src'), { recursive: true });
        await writeFile(join(root, 'src/a.ts'), 'sealed\n', 'utf8');
        // The revision is minted over the task's own declaration, so it starts current.
        const revision = await createTaskRevision({ root, taskId: 'd-task', ownedPaths: ['src/a.ts'] });
        expect((await revisionStatus(root, revision, 'd-task')).status).toBe('current');

        // And then the task grows, exactly as this change's did — through the declaration, not through the content.
        await mutateTaskArtefact(root, 'd-task', taskPath(root, 'd-task'), async (raw) => {
            const current = JSON.parse(raw) as Record<string, unknown>;
            return `${JSON.stringify({ ...current, ownedPaths: ['src/a.ts', 'src/b.ts'] }, null, 2)}\n`;
        });
        const status = await revisionStatus(root, revision, 'd-task');
        // **The declaration moved and the content did not**, which is what makes this a different state rather than a subcase.
        expect(status.status).toBe('declaration-moved');
        // The two sets are both reported, because "which paths are new" is the question an operator asks next.
        expect(status.status === 'declaration-moved' ? status.revisionOwnedPaths : []).toEqual(['src/a.ts']);
        expect(status.status === 'declaration-moved' ? status.taskOwnedPaths : []).toEqual(['src/a.ts', 'src/b.ts']);
        // And the content is untouched — that is why this is a different state from `superseded`, not a subcase of it.
        expect(status.status === 'declaration-moved' ? status : {}).not.toHaveProperty('expectedManifestHash');
    });

    it('still says superseded when the content moved, which takes precedence', async () => {
        const root = await mkdtemp(join(tmpdir(), 'kata-declared-'));
        roots.push(root);
        await initLayout(root);
        await createTask({ root, id: 'd-task', title: 'Declared', acceptance: [{ id: 'AC-1', statement: 'x' }], ownedPaths: ['src/a.ts'] });
        // The file exists before the revision is minted, or the revision would describe a path that was never there.
        await mkdir(join(root, 'src'), { recursive: true });
        await writeFile(join(root, 'src/a.ts'), 'sealed\n', 'utf8');
        const revision = await createTaskRevision({ root, taskId: 'd-task', ownedPaths: ['src/a.ts'] });
        // Both move: the file the revision describes changes, and the declaration grows. Content drift is the stronger fact — and
        // my first version of this case claimed that in a comment without actually writing the file, so it measured the weaker one.
        await writeFile(join(root, 'src/a.ts'), 'changed\n', 'utf8');
        await mutateTaskArtefact(root, 'd-task', taskPath(root, 'd-task'), async (raw) => {
            const current = JSON.parse(raw) as Record<string, unknown>;
            return `${JSON.stringify({ ...current, ownedPaths: ['src/a.ts', 'src/b.ts'] }, null, 2)}\n`;
        });
        const status = await revisionStatus(root, revision, 'd-task');
        // **Content drift is the stronger fact and it wins**, because a revision whose own files changed cannot describe the
        // workspace at all — while a moved declaration says only that it is no longer about the declared surface. Both call for a
        // re-seal, and the name says which happened.
        expect(status.status).toBe('superseded');
        // Without the task id the old question is answered the old way, so existing callers keep their meaning.
        expect((await revisionStatus(root, revision)).status).toBe('superseded');
        // And the task really is readable, or the comparison would be answering about nothing.
        expect((await readTask(root, 'd-task')).ownedPaths).toEqual(['src/a.ts', 'src/b.ts']);
    });
});
