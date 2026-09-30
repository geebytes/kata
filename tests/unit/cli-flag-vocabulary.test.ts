import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { VALUE_FLAGS } from '../../src/cli/invocation.js';

/**
 * **The value-flag vocabulary has to cover the flags the code reads, or a value takes the change-id slot.**
 *
 * Measured by an independent review: `--review-evidence` was missing from the hand-kept list, so
 * `kata-cli review --review-evidence hello --change t1` read `hello` as the *change id* and silently operated on a task
 * named `hello`. The list cannot be kept in step by hand — that is a second derivation of the command line — so this case
 * derives the flags from the source and fails when one is missing.
 */
const actors = ['src/cli', 'src/cli.ts'];

async function sourceFiles(): Promise<string[]> {
    const { readdir } = await import('node:fs/promises');
    const found: string[] = [];
    for (const entry of actors) {
        const absolute = join(import.meta.dirname, '..', '..', entry);
        if (!entry.endsWith('.ts')) {
            for (const name of await readdir(absolute)) {
                if (name.endsWith('.ts')) found.push(join(absolute, name));
            }
            continue;
        }
        found.push(absolute);
    }
    return found;
}

describe('the CLI value-flag vocabulary', () => {
    it('lists every flag a reader takes a value for', async () => {
        const reads = /(?:argValue|inlineValue)\(\s*argv\s*,\s*'(--[a-z][a-z-]*)'\s*\)|(?:indexOf)\(\s*'(--[a-z][a-z-]*)'\s*\)/gu;
        const read = new Set<string>();
        for (const file of await sourceFiles()) {
            const text = await readFile(file, 'utf8');
            for (const match of text.matchAll(reads)) {
                const flag = match[1] ?? match[2];
                if (flag === undefined) continue;
                // `indexOf` is also used for the change id's own lookup, which the guesser handles directly.
                read.add(flag);
            }
        }
        expect(read.size).toBeGreaterThan(10);
        const missing = [...read].filter((flag) => !VALUE_FLAGS.includes(flag) && flag !== '--change');
        expect(missing, `value flags missing from VALUE_FLAGS: ${missing.join(', ')}`).toEqual([]);
    });
});
