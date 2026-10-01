import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
    argValue, flagPresent, inlineValue, paradeArgValue, readFlag, splitFlag,
} from '../../src/cli/invocation.js';
import { scanHandRolledFlagLookups } from '../helpers/cli-flag-scan.js';

const cliDir = join(import.meta.dirname, '..', '..', 'src', 'cli');
const cliRoot = join(import.meta.dirname, '..', '..', 'src', 'cli.ts');

async function cliSources(): Promise<Array<{ path: string; text: string }>> {
    const files = [cliRoot, ...(await readdir(cliDir)).filter((name) => name.endsWith('.ts')).map((name) => join(cliDir, name))];
    return Promise.all(files.map(async (path) => ({ path, text: await readFile(path, 'utf8') })));
}

/**
 * **Samples that must be caught, first.** The previous version of this guard blanked quoted literals before looking for a
 * pattern that began with a quote, so two of its rules could never match and it called 21 live occurrences clean while its
 * own case stayed green. A rule that cannot be shown to fire is not a rule, so these come before the scan of the tree.
 */
const MUST_CATCH: Array<{ why: string; source: string }> = [
    {
        why: 'whole-token lookup',
        source: "const index = argv.indexOf('--root');\n",
    },
    {
        why: 'whole-token presence check',
        source: "if (argv.includes('--platform')) return true;\n",
    },
    {
        why: 'next token read with no guard',
        source: "const value = inline ?? argv[index + 1];\n",
    },
    {
        why: 'next token read behind a slice',
        source: "const value = argv.slice(index + 1)[0];\n",
    },
    {
        why: 'flag name held in a variable',
        source: "const flag = '--root';\nconst present = argv.some((token) => token.startsWith(`${flag}`));\n",
    },
    {
        why: 'predicate walk over a flag literal',
        source: "const on = argv.some((token) => token === '--seal');\n",
    },
    {
        why: 'predicate walk, find form',
        source: "const at = argv.findIndex((token) => token === '--root');\n",
    },
    {
        why: 'next token read behind readFlag().present, still unguarded',
        source: "const value = readFlag(argv, '--root').present ? argv[index + 1] : undefined;\n",
    },
];

/** And samples that must pass, so the guard is not just "everything is an offence". */
const MUST_PASS: Array<{ why: string; source: string }> = [
    { why: 'the shared reader', source: "const value = readFlag(argv, '--root').value;\n" },
    { why: 'repeated values through the shared reader', source: "const values = paradeArgValue(argv, '--owned-path');\n" },
    {
        why: 'inline plus a guarded neighbour',
        source: "const value = inline ?? (value2 === undefined || value2.startsWith('--') ? undefined : value2);\n",
    },
    { why: 'previous-token read, not a neighbour read', source: "const previous = argv[index - 1];\n" },
    { why: 'a comment about the pattern is not the pattern', source: "// argv.indexOf('--root') is forbidden here\n" },
    {
        why: 'the neighbour guard assigned on the next line',
        source: "const neighbour = argv[index + 1];\nconst value = inline ?? (neighbour === undefined || neighbour.startsWith('--') ? undefined : neighbour);\n",
    },
    { why: 'a switch read through the shared name', source: "if (switchPresent(argv, '--seal')) return true;\n" },
];

describe('CLI value reads go through one reader', () => {
    it('catches every shape it claims to forbid, on samples that must be caught', () => {
        for (const sample of MUST_CATCH) {
            const offences = scanHandRolledFlagLookups(sample.source);
            expect(offences.length, `${sample.why} was not caught:\n${sample.source}`).toBeGreaterThan(0);
        }
    });

    it('passes the shapes that are the reader itself', () => {
        for (const sample of MUST_PASS) {
            expect(scanHandRolledFlagLookups(sample.source), `${sample.why} was wrongly flagged:\n${sample.source}`).toEqual([]);
        }
    });

    it('finds no hand-rolled flag lookup left in src/cli, including the reader itself', async () => {
        const offences: string[] = [];
        for (const { path, text } of await cliSources()) {
            // T6-4: `invocation.ts` used to be skipped — the file where a regression would be least visible. The reader's
            // own `argv[i + 1]` read is allowed by *shape* (`readFlag`/`paradeArgValue` in the same statement), not by
            // exempting the file that contains it.
            for (const offence of scanHandRolledFlagLookups(text)) {
                offences.push(`${path}:${offence.line}  ${offence.text}  [${offence.why}]`);
            }
        }
        expect(offences, `hand-rolled flag lookups must go through readFlag:\n${offences.join('\n')}`).toEqual([]);
    });

    it('treats both spellings as one flag, and keeps absent distinct from empty', () => {
        expect(readFlag(['--root', '/ws'], '--root')).toEqual({ present: true, value: '/ws' });
        expect(readFlag(['--root=/ws'], '--root')).toEqual({ present: true, value: '/ws' });
        expect(readFlag(['--root'], '--root')).toEqual({ present: true, value: undefined });
        expect(readFlag(['--root='], '--root')).toEqual({ present: true, value: undefined });
        expect(readFlag([], '--root')).toEqual({ present: false, value: undefined });
        expect(readFlag(['--root', '--dry-run'], '--root')).toEqual({ present: true, value: undefined });

        expect(argValue(['--root=/ws'], '--root')).toBe('/ws');
        expect(argValue(['--root', '/ws'], '--root')).toBe('/ws');
        expect(inlineValue(['--root=/ws'], '--root')).toBe('/ws');
        expect(flagPresent(['--root='], '--root')).toBe(true);
        expect(splitFlag('--root=/ws')).toEqual({ flag: '--root', inline: '/ws' });
        expect(paradeArgValue(['--owned-path=a', '--owned-path=b'], '--owned-path')).toEqual(['a', 'b']);
        expect(paradeArgValue(['--owned-path', 'a', '--owned-path=b'], '--owned-path')).toEqual(['a', 'b']);

        // **Position decides, not spelling.** Scanning every inline token before the spaced ones made the *later* one win,
        // so a sliced read (`readFlag(argv.slice(i), flag)`) answered with a flag that came after the neighbour — measured
        // as `paradeArgValue(['--owned-path', 'a', '--owned-path=b'])` returning `['b','b']`. Found by a probe, so it gets
        // a case: the first occurrence in order is the answer.
        expect(readFlag(['--root', '/ws', '--root=/other'], '--root')).toEqual({ present: true, value: '/ws' });
        expect(readFlag(['--root=/other', '--root', '/ws'], '--root')).toEqual({ present: true, value: '/other' });
        expect(readFlag(['--root', '--dry-run', '--root=/other'], '--root').value).toBeUndefined();
        // The first occurrence wins even when it is incomplete: a later valid flag does not silently arbitrate an earlier
        // malformed one (T6-5). The caller refuses it by name.
        expect(readFlag(['--root=', '--root', '/ws'], '--root')).toEqual({ present: true, value: undefined });
    });

    it('pins the two choices the review found unpinned: repeated inline values and an empty inline value', async () => {
        const { repeatedValues } = await import('../../src/cli/workflow.js');
        expect(repeatedValues(['--reviewed-path=a.ts', '--reviewed-path=b.ts'], '--reviewed-path')).toEqual(['a.ts', 'b.ts']);
        expect(repeatedValues(['--reviewed-path', 'a.ts'], '--reviewed-path')).toEqual(['a.ts']);
        expect(() => repeatedValues(['--reviewed-path='], '--reviewed-path')).toThrow(/requires a value/u);

        expect(argValue(['--seed='], '--seed')).toBeUndefined();
        expect(argValue(['--seed='], '--seed') ?? 'default').toBe('default');
    });
});
