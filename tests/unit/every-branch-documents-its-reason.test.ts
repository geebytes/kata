import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

/**
 * **A branch has to say why *it* returns, not inherit a neighbour's note.**
 *
 * Measured in `suggestCandidateAction`: the branch for an unreadable current revision carried two comments that described
 * other branches — one about the terminal escalation's ordering, one about a verify-repair priority in a phase that branch
 * no longer lives in. The reader following the router had to work out which of the three statements applied, and the
 * branch's own condition (the artefact every other answer is derived from cannot be read) was stated nowhere.
 *
 * The rule is mechanical and narrow: the comment block directly above a branch must not name a reason that another branch
 * in the same function returns. Naming its *own* reason is fine, and so is prose — `pass`, `fail` and words that no branch
 * returns are not claims about a route.
 */
const REASON_RETURNED = /reason:\s*'([a-z_]+)'/g;
const QUOTED_WORD = /`([a-z_]+)`|'([a-z_]+)'/g;

/**
 * The function body, from its declaration to the closing brace at column zero.
 *
 * Scoped rather than taken to the end of the file: the previous version scanned past the function, so two branches in a
 * helper below it were attributed to the router — and, more importantly, a branch nested deeper than the two spaces the
 * pattern required was never examined at all (measured: one such branch).
 */
function routerBody(lines: string[]): string[] {
    const start = lines.findIndex((line) => line.includes('export function suggestCandidateAction'));
    const end = lines.findIndex((line, index) => index > start && line === '}');
    return lines.slice(start, end + 1);
}

/**
 * Every branch in the body, with the comment block directly above it (empty when there is none).
 *
 * `if (` at **any** indentation: a nested branch is a branch, and the first version's `/^\s{2}if \(/` could not see one.
 */
function branches(lines: string[]): Array<{ line: number; text: string; condition: string }> {
    const out: Array<{ line: number; text: string; condition: string }> = [];
    for (const [index, line] of lines.entries()) {
        // `} else if (` is a branch too: the first version matched `if (` at line start only, so an else-if arm was never
        // examined — and one of them is what an unreachable duplicate looked like in this router.
        const match = /^(\s*)(?:\}\s*)?(?:else\s+)?if \((.*)$/.exec(line);
        if (!match) continue;
        const collected: string[] = [];
        for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
            const previous = lines[cursor] ?? '';
            if (!/^\s*\/\//.test(previous)) break;
            collected.unshift(previous);
        }
        out.push({ line: index + 1, text: collected.join('\n'), condition: (match[2] ?? '').trim() });
    }
    return out;
}

describe('every route branch documents its own reason', () => {
    it('finds no branch carrying a note about another branch', async () => {
        const body = routerBody((await readFile('src/workflow/navigation.ts', 'utf8')).split('\n'));
        const all = branches(body);
        // A function with no branches would pass every assertion below, so the scan asserts what it examined.
        expect(all.length).toBeGreaterThan(15);

        // **The half that was never checked**: every branch states why it returns.
        const undocumented = all.filter((branch) => branch.text.trim() === '').map((branch) => `${branch.line}: ${branch.condition}`);
        expect(undocumented).toEqual([]);

        // And the half that was: no branch carries a note about a *different* branch.
        const returned = new Set<string>();
        for (const match of body.join('\n').matchAll(REASON_RETURNED)) if (match[1]) returned.add(match[1]);
        expect(returned.size).toBeGreaterThan(10);

        const borrowed: string[] = [];
        for (const branch of all) {
            for (const match of branch.text.matchAll(QUOTED_WORD)) {
                const name = match[1] ?? match[2];
                if (!name || !returned.has(name)) continue;
                const branchText = body.slice(branch.line - 1, branch.line + 14).join('\n');
                const own = /reason:\s*'([a-z_]+)'/.exec(branchText)?.[1];
                if (name !== own) borrowed.push(`line ${branch.line}: comment names \`${name}\` but the branch returns \`${own ?? 'nothing'}\``);
            }
        }
        expect(borrowed).toEqual([]);
    });

    it('examines nested branches too, which the first version stepped over', () => {
        // The one nested branch in the router: a two-space pattern cannot see four.
        const body = ['export function suggestCandidateAction() {', '  if (a) {', '    // its own note', '    if (b) {', '      return 1;', '    }', '  }', '}'];
        const found = branches(body);
        expect(found.map((branch) => branch.line)).toEqual([2, 4]);
        // And an else-if arm is a branch: same rule, no exception for how it is spelled.
        const chain = ['if (a) {', '  return 1;', '} else if (b) {', '  return 2;', '}'];
        expect(branches(chain).map((branch) => branch.condition)).toEqual(['a) {', 'b) {']);
        // And the nested one is *reported* when it carries no note, which is the point of seeing it.
        expect(found.filter((branch) => branch.text.trim() === '').map((branch) => branch.condition)).toEqual(['a) {']);
    });

    it('would notice the note this change removed', () => {
        const returned = new Set(['escalate_review_without_progress', 'repair_unreadable_current_revision']);
        const borrows = (text: string, own: string): boolean => [...text.matchAll(QUOTED_WORD)]
            .map((match) => match[1] ?? match[2])
            .some((name) => name !== undefined && name !== own && returned.has(name));
        // The measured text: the pointer branch carried the terminal state's note.
        const borrowedNote = '// The terminal state is evaluated first, and that word is load-bearing:\n// a loop routed on `escalate_review_without_progress` stops.';
        expect(borrows(borrowedNote, 'repair_unreadable_current_revision')).toBe(true);
        // Its own note is not a borrow.
        expect(borrows('// This branch names `repair_unreadable_current_revision` because the pointer cannot be read.', 'repair_unreadable_current_revision')).toBe(false);
    });
});