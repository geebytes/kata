import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { VALUE_FLAGS, parseChangeArg } from '../../src/cli/invocation.js';

/**
 * **The value-flag vocabulary has to cover the flags the code reads, or a value takes the change-id slot.**
 *
 * Measured twice by independent reviews. First `--review-evidence` was missing, so
 * `kata-cli review --review-evidence hello --change t1` read `hello` as the *change id*. Then seven more were missing —
 * `--branch`, `--base`, `--path`, `--by`, `--since`, `--record`, `--c0` — so `worktree create --branch feature/x` read the
 * branch name as the change id and `--base main` became a branch named `kata/main`.
 *
 * **This is a strong approximation, not a derived table, and it says so.** It scans the shapes flags are read in
 * (`argValue`/`inlineValue`/`indexOf` with a literal flag string). A flag reached through a variable, or read outside
 * `src/cli/`, is invisible to it — that blind spot is stated rather than pretended away, and the case below also pins the
 * behaviour (not just membership) for the shapes it can see.
 */
async function sourceFiles(): Promise<string[]> {
    const found: string[] = [];
    const cli = join(import.meta.dirname, '..', '..', 'src', 'cli');
    for (const name of await readdir(cli)) {
        if (name.endsWith('.ts')) found.push(join(cli, name));
    }
    found.push(join(import.meta.dirname, '..', '..', 'src', 'cli.ts'));
    return found;
}

/** Every flag literal read as a *value*, in the shapes this scan can see. */
const READS = [
    /(?:argValue|inlineValue)\(\s*[^,()]+,\s*'(--[a-z][a-z-]*)'/gu,
    /indexOf\(\s*'(--[a-z][a-z-]*)'/gu,
    /startsWith\(\s*`\$\{(--[a-z][a-z-]*)/gu,
    // **The shape that was missing, and it is the common one.** A hand-written `arg === '--x'` parser reads a value just as
    // much as `argValue` does — `relations add --from <v>`, `installer --home <path>`, `handoff --to <role>` — and eight
    // flags were reachable only through it while the vocabulary stayed green (R8-F3).
    /===\s*'(--[a-z][a-z-]*)'/gu,
    /'(--[a-z][a-z-]*)'\s*===/gu,
];

/**
 * Blank comments and string-literal *prose* before scanning, so a docblock that mentions a flag in an example is not read
 * as a reader of it. Measured while writing this: a comment showing the comparison shape made `--flag` look like a flag the
 * CLI reads, and the vocabulary case failed on a sentence.
 */
function codeOnly(text: string): string {
    return text
        .replace(/\/\*[\s\S]*?\*\//gu, (block) => block.replace(/[^\n]/gu, ' '))
        .replace(/(^|[^:])\/\/[^\n]*/gu, (match, prefix: string) => prefix + ' '.repeat(match.length - prefix.length));
}

async function readFlags(): Promise<Set<string>> {
    const read = new Set<string>();
    for (const file of await sourceFiles()) {
        const text = codeOnly(await readFile(file, 'utf8'));
        for (const shape of READS) {
            for (const match of text.matchAll(shape)) {
                const flag = match[1];
                if (flag !== undefined) read.add(flag);
            }
        }
    }
    return read;
}

describe('the CLI value-flag vocabulary', () => {
    /**
     * Flags a `===` comparison touches that take **no** value: they are switches, so they belong in no vocabulary. Listed
     * rather than filtered by a shape, because "is this flag a switch" is a judgement and a silent filter is how a real
     * value flag would hide.
     */
    const SWITCHES = new Set([
        '--all', '--approve', '--confirm', '--cost', '--create', '--discover-checks', '--dry-run', '--force', '--frozen',
        '--help', '--init', '--json', '--list-checks', '--no-discover-checks', '--no-refresh', '--no-wiki', '--quiet',
        '--refresh', '--version', '--x', '--yes',
    ]);

    it('lists every flag a value is read for in the shapes the scan can see', async () => {
        const read = await readFlags();
        expect(read.size).toBeGreaterThan(30);
        const missing = [...read].filter((flag) => !VALUE_FLAGS.includes(flag) && !SWITCHES.has(flag) && flag !== '--change');
        expect(missing, `value flags missing from VALUE_FLAGS: ${missing.join(', ')}`).toEqual([]);
    });

    it('scans the hand-written comparison shape, not only the shared readers', async () => {
        // R8-F3: the scan covered three shapes and a flag read as `arg === '--x'` was invisible — eight of them were, while
        // the vocabulary reported itself complete. The assertion is on the *scan*, because a membership list can be kept
        // right by hand while the guard that is supposed to keep it right stays blind.
        const cli = join(import.meta.dirname, '..', '..', 'src', 'cli');
        const sources = await Promise.all((await readdir(cli)).filter((name) => name.endsWith('.ts'))
            .map((name) => readFile(join(cli, name), 'utf8')));
        const comparedShape = sources.reduce((total, text) => total + [...text.matchAll(/===\s*'(--[a-z][a-z-]*)'/gu)].length, 0);
        expect(comparedShape).toBeGreaterThan(20);

        const read = await readFlags();
        for (const flag of ['--to', '--type', '--field', '--endpoint', '--wiki', '--query', '--decision', '--scope']) {
            expect(read.has(flag), `${flag} is read in a shape the scan must see`).toBe(true);
            expect(VALUE_FLAGS).toContain(flag);
            expect(parseChangeArg([flag, 'a-value'])).toBeUndefined();
        }
    });

    it('keeps a value flag from taking the change-id slot for the flags that were actually missing', () => {
        // Membership alone is not the property that broke; this is. Each of these was read as the change id before the fix.
        for (const flag of ['--branch', '--base', '--path', '--by', '--since', '--record', '--review-evidence']) {
            expect(VALUE_FLAGS).toContain(flag);
            expect(parseChangeArg([flag, 'a-value', '--change', 't1'])).toBe('t1');
        }
        // The documented shape that failed: `worktree create --branch feature/x` — the subcommand's own `rest` slice, which
        // is what `src/cli/ops.ts` passes, so the branch name is the only bare token in it.
        expect(parseChangeArg(['--branch', 'feature/x'])).toBeUndefined();
        expect(parseChangeArg(['--base', 'main'])).toBeUndefined();
        expect(parseChangeArg(['--branch', 'feature/x', '--path', 'p'])).toBeUndefined();
    });
});
