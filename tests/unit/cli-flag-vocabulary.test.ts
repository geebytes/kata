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
];

async function readFlags(): Promise<Set<string>> {
    const read = new Set<string>();
    for (const file of await sourceFiles()) {
        const text = await readFile(file, 'utf8');
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
    it('lists every flag a value is read for in the shapes the scan can see', async () => {
        const read = await readFlags();
        expect(read.size).toBeGreaterThan(30);
        const missing = [...read].filter((flag) => !VALUE_FLAGS.includes(flag) && flag !== '--change');
        expect(missing, `value flags missing from VALUE_FLAGS: ${missing.join(', ')}`).toEqual([]);
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
