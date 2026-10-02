import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordOwner, uniqueCopies } from '../../src/core/layout.js';

/**
 * AC-3 — ownership is not granted by the existence of a directory.
 *
 * The measured defect (reading 1, F4, which refuted this change's predecessor's AC-4):
 *
 *   $ mkdir -p <root>/vendor/copy/.kata/tasks/held          # no file is written
 *   before: recordsRoot(<root>/vendor/copy/src, held) = <root>
 *   after:  recordsRoot(<root>/vendor/copy/src, held) = <root>/vendor/copy
 *   taskDir(<root>/vendor/copy/src, held) = <root>/vendor/copy/.kata/tasks/held
 *
 * The predicate was `accessSync`, so an empty directory was an owner — **cheaper** to arrange than the file it replaced,
 * because no content has to be invented. The predecessor's own test was named "an empty directory is not an owner" while
 * asking about a task directory that did not exist, which is a different question with the same name.
 *
 * The criterion is the answer this model gives: a checkout holds a task when its task directory holds a **record**.
 */
const roots: string[] = [];

function repo(name: string): string {
    const root = mkdtempSync(join(tmpdir(), `kata-uc-empty-${name}-`));
    roots.push(root);
    writeFileSync(join(root, 'package.json'), '{ "name": "uc", "private": true }\n');
    return root;
}

afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('an empty directory grants nothing', () => {
    it('a worktree holding only an empty task directory holds nothing', async () => {
        const primary = repo('empty-holder');
        const worktree = join(primary, '.kata', 'worktrees', 'held');
        // The directory exists and is empty. Nothing about it is a record.
        mkdirSync(join(worktree, '.kata', 'tasks', 'held'), { recursive: true });

        const copies = await uniqueCopies({ root: primary });
        expect(copies.filter((copy) => copy.taskId === 'held')).toEqual([]);
    });

    it('a worktree holding a record is reported, so the rule is content and not emptiness', async () => {
        // The other direction: a predicate that never grants ownership would pass the case above and be useless.
        const primary = repo('real-holder');
        const worktree = join(primary, '.kata', 'worktrees', 'held');
        mkdirSync(join(worktree, '.kata', 'tasks', 'held'), { recursive: true });
        writeFileSync(join(worktree, '.kata', 'tasks', 'held', 'judge.json'), '{}\n');

        const copies = await uniqueCopies({ root: primary });
        expect(copies.filter((copy) => copy.taskId === 'held')).toHaveLength(1);
    });

    it('recordsRoot does not hand ownership to an empty directory either', () => {
        // **The consumer, not only the model.** The first version of this criterion fixed the ownership predicate and
        // left `recordsRoot` reading the old one — measured: `recordOwner` answered `undefined` while
        // `recordsRoot(<root>/vendor/copy/src, held)` still returned `<root>/vendor/copy`, so `taskDir` would have written
        // the task's records into a directory it does not belong to. A criterion on the model alone does not cover it.
        const primary = repo('records-root');
        const intruder = join(primary, 'vendor', 'copy');
        mkdirSync(join(intruder, '.kata', 'tasks', 'held'), { recursive: true });
        writeFileSync(join(intruder, 'package.json'), '{ "name": "copy", "private": true }\n');

        expect(recordOwner({ root: join(intruder, 'src'), taskId: 'held' }).ownerRoot).toBeUndefined();
        // The fallback names the checkout the caller works in, which for this fixture is the intruder itself — the point
        // is that it is *not* reported as an owner of `held`.
        expect(recordOwner({ root: primary, taskId: 'held' }).ownerRoot).toBeUndefined();
    });

    it('a worktree directory named after one task but holding another task\'s files is attributed correctly', async () => {
        // The name is a hint; the record is the fact. A worktree called `T` holding `U`'s judge file must be reported
        // under `U`, because that is what would be lost — the reading's F8 shape, one level down.
        const primary = repo('misnamed');
        const worktree = join(primary, '.kata', 'worktrees', 'T');
        mkdirSync(join(worktree, '.kata', 'tasks', 'U'), { recursive: true });
        writeFileSync(join(worktree, '.kata', 'tasks', 'U', 'verdicts.json'), '{}\n');

        const copies = await uniqueCopies({ root: primary });
        expect(copies).toHaveLength(1);
        expect(copies[0]!.taskId, 'the record decides the task, not the directory name').toBe('U');
        expect(copies[0]!.path).toBe('tasks/verdicts.json');
    });
});
