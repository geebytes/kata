import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * **Two cases with the same title make a suite unreadable, and a run can report one and be read as the other.**
 *
 * Measured in this change's own test file: a case named "returns a refusal envelope from verify when the revision cannot
 * be read" sat beside an earlier case that asserted the same thing for verify *and* judge, with weaker assertions. Both
 * passed, the file reported sixteen cases, and the second one was pure maintenance cost — its subject was already pinned
 * one screen up. Every future edit had two places to keep in step, and a failure naming that title could not say which
 * of them it came from.
 *
 * The rule is mechanical: within one file, no two `it(...)` titles are equal. Repeats *across* files are fine and often
 * right — a command's refusal deserves a case in its own file — and the scan says so by scoping to the file.
 */
const CASE_TITLE = /\bit\(\s*(['"`])((?:\\.|(?!\1)[^\\])*)\1/;

async function testFiles(dir: string): Promise<string[]> {
    const entries = await readdir(dir, { withFileTypes: true });
    const files: string[] = [];
    for (const entry of entries) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) files.push(...await testFiles(path));
        else if (entry.name.endsWith('.ts')) files.push(path);
    }
    return files;
}

/**
 * The duplicate titles in a file's source, as `line` pairs.
 *
 * Kept as a function so the case below can feed it synthetic input — and so this file's own source carries no `it('…')`
 * text that the scan would read as one of its own cases, which is exactly what happened on the first attempt: the
 * self-test's array literal contained two identical `it('refuses an unreadable record', …)` strings and the scan reported
 * *this* file.
 */
function duplicateTitles(lines: string[]): string[] {
    const seen = new Map<string, number>();
    const duplicates: string[] = [];
    for (const [index, line] of lines.entries()) {
        const match = CASE_TITLE.exec(line);
        const title = match?.[2];
        if (!title) continue;
        const first = seen.get(title);
        if (first === undefined) seen.set(title, index + 1);
        else duplicates.push(`${title} (lines ${first} and ${index + 1})`);
    }
    return duplicates;
}

/** A case line built at runtime, so this file's source never contains the pattern it scans for. */
const caseLine = (title: string): string => `it(${JSON.stringify(title)}, () => {});`;

describe('no two cases in one file share a title', () => {
    it('finds no duplicate title across the suites', async () => {
        const files = await testFiles('tests');
        expect(files.length).toBeGreaterThan(50);
        const duplicates: string[] = [];
        for (const file of files) {
            for (const duplicate of duplicateTitles((await readFile(file, 'utf8')).split('\n'))) {
                duplicates.push(`${file}: ${duplicate}`);
            }
        }
        expect(duplicates).toEqual([]);
    });

    it('would notice a duplicate, so a passing run means something', () => {
        const same = 'refuses an unreadable record';
        expect(duplicateTitles([caseLine(same), caseLine('does something else'), caseLine(same)]))
            .toEqual([`${same} (lines 1 and 3)`]);
        expect(duplicateTitles([caseLine(same), caseLine('does something else')])).toEqual([]);
    });
});
