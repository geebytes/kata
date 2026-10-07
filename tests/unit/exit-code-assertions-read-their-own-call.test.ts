import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * **An assertion about `process.exitCode` must read the call it names.**
 *
 * `process.exitCode` is process-wide. A command that refuses leaves it at 1, and a later successful command does not clear
 * it — deliberately, so a run that failed anywhere still reports failure. That makes a bare
 * `expect(process.exitCode).toBe(1)` a statement about *the whole process so far*, not about the command on the line above
 * it: measured, a case asserting a re-answer was refused stayed **green** while the write-once guard it was about was
 * deleted, because an earlier `decide` in the same case had already left the code at 1.
 *
 * The rule is therefore: within a case that asserts on `process.exitCode`, the value is reset to 0 before the sequence the
 * assertion is about. That keeps the deliberate carry-over assertion honest too — the one that requires a *passing* command
 * not to clear an earlier failure still says what it means, because now we know where the 1 came from.
 *
 * The guard is written to be able to fail: a control case drives the same checker with a fabricated case that resets and
 * one that does not, and the scanned suite has to be clean under it.
 */

/** Where each case begins, so an assertion is attributed to the case it lives in. */
const CASE_START = /^\s*(?:it|test)(?:\.\w+)?\(\s*['"`]/;

/**
 * The lines of each case in a test file, as `{ title, lines }`.
 *
 * Cases are cut at the next case start rather than by brace balance: a nested `describe` or a helper callback would defeat a
 * brace count, and attributing an assertion to the wrong case is worse than attributing it to a slightly long one.
 */
export function casesOf(text: string): Array<{ title: string; lines: string[] }> {
    const lines = text.split('\n');
    const starts: number[] = [];
    for (const [index, line] of lines.entries()) {
        if (CASE_START.test(line)) starts.push(index);
    }
    return starts.map((start, position) => ({
        title: (lines[start] ?? '').trim().slice(0, 90),
        lines: lines.slice(start, starts[position + 1] ?? lines.length),
    }));
}

/**
 * The helpers in a file that reset the exit code before invoking a command.
 *
 * **A case can keep the rule without spelling it out.** `probe-answer-binding.test.ts` routes every invocation through a
 * `ledger()` helper that resets first, so the case's own lines contain no reset and the assertion is still a fact about the
 * call it names. Reading only the case would report that file as an offender and be wrong about it — the shape of the rule is
 * "the value is reset before the call", not "the reset is written inside the case".
 */
function resettingHelpers(text: string): string[] {
    const names: string[] = [];
    for (const match of text.matchAll(/(?:async\s+)?function\s+(\w+)\s*\(/g)) {
        const name = match[1];
        if (name === undefined) continue;
        const body = text.slice(match.index ?? 0, text.indexOf('\n}', match.index ?? 0) + 2);
        if (/process\.exitCode\s*=\s*0\s*;/.test(body)) names.push(name);
    }
    return names;
}

/** An assertion about `process.exitCode`, and whether the value is reset before it — in the case or in a helper it calls. */
export function unpollutedAssertions(text: string): Array<{ title: string; line: string; reset: boolean }> {
    const out: Array<{ title: string; line: string; reset: boolean }> = [];
    const helpers = resettingHelpers(text);
    for (const testCase of casesOf(text)) {
        const body = testCase.lines.join('\n');
        let reset = /process\.exitCode\s*=\s*0\s*;/.test(body)
            || helpers.some((helper) => new RegExp(`\\b${helper}\\s*\\(`).test(body));
        for (const line of testCase.lines) {
            if (/process\.exitCode\s*=\s*0\s*;/.test(line)) reset = true;
            if (/expect\(\s*process\.exitCode/.test(line)) out.push({ title: testCase.title, line: line.trim().slice(0, 80), reset });
        }
    }
    return out;
}

const TESTS = new URL('../', import.meta.url).pathname;

async function testFiles(dir: string): Promise<string[]> {
    const out: string[] = [];
    for (const entry of await readdir(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) out.push(...(await testFiles(path)));
        else if (entry.name.endsWith('.test.ts')) out.push(path);
    }
    return out;
}

describe('an assertion about the exit code reads its own call', () => {
    it('no case asserts on process.exitCode without resetting it first', async () => {
        const offenders: string[] = [];
        for (const file of await testFiles(TESTS)) {
            if (file.endsWith('exit-code-assertions-read-their-own-call.test.ts')) continue;
            for (const found of unpollutedAssertions(await readFile(file, 'utf8'))) {
                if (!found.reset) offenders.push(`${file.replace(TESTS, 'tests/')} — ${found.title} — ${found.line}`);
            }
        }
        expect(
            offenders,
            'a case that asserts on `process.exitCode` must reset it first, or the assertion reads the whole process rather '
            + 'than the call it names',
        ).toEqual([]);
    });

    it('flags a case that does not reset, and clears one that does', () => {
        const polluted = [
            "it('refuses twice with no reset', async () => {",
            "    await ledger(['decide']);",
            '    expect(process.exitCode).toBe(1);',
            "    await ledger(['answer']);",
            '    expect(process.exitCode).toBe(1);',
            '});',
        ].join('\n');
        expect(unpollutedAssertions(polluted).map((found) => found.reset)).toEqual([false, false]);

        const clean = [
            "it('refuses twice with a reset', async () => {",
            '    process.exitCode = 0;',
            "    await ledger(['decide']);",
            '    expect(process.exitCode).toBe(1);',
            '});',
        ].join('\n');
        expect(unpollutedAssertions(clean).map((found) => found.reset)).toEqual([true]);
    });

    it('covers the assertions this change repaired, so the surface cannot shrink silently', async () => {
        // Three files assert on the exit code; each one's cases must be *seen* by the checker rather than skipped by a
        // pattern that quietly stopped matching.
        const seen: string[] = [];
        for (const name of ['discovery-challenge-binding', 'ledger-cli-end-to-end', 'sandboxed-retirement']) {
            const text = await readFile(join(TESTS, 'unit', `${name}.test.ts`), 'utf8');
            const found = unpollutedAssertions(text);
            expect(found.length, `${name} asserts on the exit code and must be seen by this checker`).toBeGreaterThan(0);
            seen.push(name);
        }
        expect(seen).toEqual(['discovery-challenge-binding', 'ledger-cli-end-to-end', 'sandboxed-retirement']);
    });
});
