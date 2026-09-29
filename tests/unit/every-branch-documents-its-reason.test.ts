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

/** The comments directly above each `if (` in a function body, keyed by the line the branch starts on. */
function branchComments(lines: string[]): Array<{ line: number; text: string }> {
    const blocks: Array<{ line: number; text: string }> = [];
    for (const [index, line] of lines.entries()) {
        if (!/^\s{2}if \(/.test(line)) continue;
        const collected: string[] = [];
        for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
            const previous = lines[cursor] ?? '';
            if (!/^\s*\/\//.test(previous)) break;
            collected.unshift(previous);
        }
        if (collected.length > 0) blocks.push({ line: index + 1, text: collected.join('\n') });
    }
    return blocks;
}

describe('every route branch documents its own reason', () => {
    it('finds no branch carrying a note about another branch', async () => {
        const source = await readFile('src/workflow/navigation.ts', 'utf8');
        const lines = source.split('\n');
        const start = lines.findIndex((line) => line.includes('export function suggestCandidateAction'));
        expect(start).toBeGreaterThan(0);
        const body = lines.slice(start);

        const returned = new Set<string>();
        for (const match of body.join('\n').matchAll(REASON_RETURNED)) if (match[1]) returned.add(match[1]);
        expect(returned.size).toBeGreaterThan(10);

        const borrowed: string[] = [];
        for (const block of branchComments(body)) {
            for (const match of block.text.matchAll(QUOTED_WORD)) {
                const name = match[1] ?? match[2];
                if (!name || !returned.has(name)) continue;
                // It is this branch's own reason only if the branch returns it; find the branch's reason below it.
                const branchText = body.slice(block.line - 1, block.line + 14).join('\n');
                const own = /reason:\s*'([a-z_]+)'/.exec(branchText)?.[1];
                if (name !== own) borrowed.push(`line ${block.line}: comment names \`${name}\` but the branch returns \`${own ?? 'nothing'}\``);
            }
        }
        expect(borrowed).toEqual([]);
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