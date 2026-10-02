import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * AC-5 — every statement about where a task's records live is derived from the code fact it describes.
 *
 * The measured defect (reading 2, major): a check was written as
 * `expect(source).toContain('use that worktree as the code root')`. It passed — while five sentences in three files and
 * one document still described the removed copy-in and the "nearest owner wins" rule, including one on the very function
 * the change had rewritten. **An assertion written against the thing you just changed is a restatement of your edit, not
 * a guard on the fact**, which is why this file derives each case from the fact it names:
 *
 *   • the fact that no copy exists is `taskStateCopied`, so the check reads that field and requires the prose to agree;
 *   • the fact that the code root and the record root are different questions is the existence of two exported
 *     functions, so the check requires both to exist before it accepts either sentence;
 *   • the fact that ownership is `recordOwner` is that one function, so the check reads its name.
 *
 * Deleting any of those facts reddens a case here. That is the property the previous check lacked.
 */
const root = '/data/work/ahaeureka/k2skills/kata';
const read = (path: string): string => readFileSync(join(root, path), 'utf8');

/** The sentence a file renders, so a check cannot pass on a comment that merely quotes the old wording. */
function facts(file: string): { source: string; statesNoCopy: boolean } {
    const source = read(file);
    return { source, statesNoCopy: !/carries the task's state into the checkout/u.test(source) };
}

describe('record-location statements follow the code', () => {
    it('the field the prose is about still exists, and still says no copy', () => {
        // Case 1 of 3 derives from the code: if `taskStateCopied` disappears, the prose below has nothing to agree with
        // and this test fails before it can pass vacuously.
        const worktreeSource = read('src/workflow/worktree.ts');
        expect(worktreeSource).toMatch(/taskStateCopied: boolean/u);
        expect(worktreeSource, 'the field is kept as a witness and is false').toMatch(/const taskStateCopied = false/u);
    });

    it('no source file claims the task state is carried into the checkout', () => {
        for (const file of ['src/workflow/worktree.ts', 'src/cli.ts', 'src/cli/ops.ts', 'src/core/layout.ts']) {
            const { source, statesNoCopy } = facts(file);
            expect(statesNoCopy, `${file} still claims a copy is carried into the worktree`).toBe(true);
            expect(source, `${file} still claims the state is tracked`).not.toMatch(/task state is tracked/u);
        }
    });

    it('the operations document states the one-owner rule and the code-root split', () => {
        const doc = read('docs/operations.md');
        // Derived from the code: both facts must exist for either statement to be checkable.
        const layout = read('src/core/layout.ts');
        expect(layout, 'the two questions must exist as two functions').toMatch(/export function recordsRoot/u);
        expect(layout, 'the two questions must exist as two functions').toMatch(/export function recordOwner/u);

        expect(doc, 'the document must say records have one owner').toMatch(/one owner/u);
        expect(doc, 'the document must not claim a state copy').not.toMatch(/copied in when/u);
        expect(doc, 'the document must describe the code root separately').toMatch(/code root/u);
    });

    it('the function that answers the records question is the one the prose names', () => {
        // Derived from the code: the prose and the implementation are compared against the same name.
        const layout = read('src/core/layout.ts');
        expect(layout).toMatch(/export function recordOwner/u);
        // The paragraph above `recordsRoot` must not describe the nearest-owner rule as its behaviour.
        const paragraph = layout.slice(layout.indexOf('/**\n * **The root that owns a task\'s records.**'), layout.indexOf('export function recordsRoot'));
        // The old wording may be *quoted* — that is how a reader learns it was wrong — but must not be stated as this
        // function's rule. The distinction is the same one the layout prose check makes, applied to a sentence rather
        // than a phrase: an assertion that forbids quoting would forbid the explanation.
        expect(paragraph, 'the paragraph must explain why the sentence was wrong').toMatch(/said the opposite/u);
        // Stated as this function's rule, the sentence would read as a claim about `resolveWorkspaceRootForTask`. The
        // quoted form always sits inside parentheses after `said the opposite`, so the unquoted opening is the tell.
        expect(paragraph, "the paragraph must not state the nearest-owner rule as this function's rule").not.toMatch(
            /Isolating a change isolates its code: `resolveWorkspaceRootForTask` prefers the nearest owner/u,
        );
    });
});
