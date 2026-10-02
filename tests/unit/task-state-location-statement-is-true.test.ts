import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..', '..');

/**
 * **AC-4: a statement about where task state lives must match where it is written.**
 *
 * `layout.ts` carried the sentence *"A nested worktree and its primary checkout both own the same task (task state is
 * tracked)"* — offered as the reason the nearest root could win. The premise was false for that version of `.gitignore`
 * (which ignored all of `.kata/`), so nothing was tracked and nothing reconciled the two copies. The sentence stayed while
 * the code kept writing a second copy, which is how a comment becomes a specification nobody follows.
 *
 * The premise has since been made true in the other direction: `.gitignore` admits the trace by name and `.kata` is out of
 * the name-level exclusion table. So the case asserts the *agreement* rather than either side of it, and reads both files,
 * because a prose claim and a gitignore rule that drift apart are exactly how the original defect survived review.
 */
describe('the claim about where task records live matches the code', () => {
    it('states one owner and does not claim the state is tracked', async () => {
        const layout = await readFile(join(root, 'src/core/layout.ts'), 'utf8');

        // The prose: the false premise may be *quoted* (that is how a reader learns why it was wrong), but it must not be
        // stated as a fact.
        const claimsIt = [...layout.matchAll(/task state is tracked/g)]
            .filter((match) => !/premise|was false|\(task state is tracked\)"/.test(layout.slice(Math.max(0, match.index - 220), match.index + 90)));
        expect(claimsIt, 'the phrase may be quoted as a false premise, never asserted').toEqual([]);

        // The code: one function owns the record question, and both resolver paths go through it.
        expect(layout).toContain('export function recordsRoot');
        expect(layout).toContain('export function resolveCodeRoot');
        // The answer must not be a function of file existence — the shape of the F1 defect.
        expect(layout).toContain('isUnderLinkedWorktrees');
    });

    it('states the code-root contract in the file that prints it, not only in layout.ts', async () => {
        // **The prose check used to read one file.** `createWorktree` prints `rootResolution` to the operator, and it
        // said a task-addressed command run from the worktree "resolves that worktree as the workspace root" — the old
        // behaviour, and the opposite of the one-owner rule. A statement a user acts on is part of the contract, so the
        // check reaches the file that renders it instead of the file the author happened to be editing.
        const worktreeSource = await readFile(join(root, 'src/workflow/worktree.ts'), 'utf8');
        // The rendered sentence states the split; the old promise survives only inside this comment, which is where a
        // reader learns why it was wrong.
        expect(worktreeSource).toContain('use that worktree as the code root');
        const printed = /rootResolution:\s*`[^`]*`/su.exec(worktreeSource)?.[0] ?? '';
        expect(printed, 'the operator-facing sentence must exist').not.toBe('');
        expect(printed, 'the sentence the code no longer keeps must not be rendered').not.toContain(
            'resolve that worktree as the workspace root',
        );
    });

    it('makes the gitignore fact it rests on explicit', async () => {
        const ignore = await readFile(join(root, '.gitignore'), 'utf8');
        const lines = ignore.split('\n').map((line) => line.trim());
        // The record is repository content: `.kata/*` denies the machinery, and the trace is re-admitted by name. A file
        // that names the shape of that rule is the fact the owner rule rests on, so it is asserted rather than assumed.
        expect(lines).toContain('.kata/*');
        expect(lines).toContain('!.kata/tasks/');
        // The machinery stays out: a worktree is a copy of the source, and a runtime pointer belongs to one session.
        expect(lines).toContain('.kata/worktrees/');
        expect(lines).toContain('.kata/runtime/');
    });
});
