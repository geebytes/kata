import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
    argValue, flagPresent, inlineValue, paradeArgValue, readFlag, splitFlag,
} from '../../src/cli/invocation.js';

const cliDir = join(import.meta.dirname, '..', '..', 'src', 'cli');
const cliRoot = join(import.meta.dirname, '..', '..', 'src', 'cli.ts');

async function cliSources(): Promise<Array<{ path: string; text: string }>> {
    const files = [cliRoot, ...(await readdir(cliDir)).filter((name) => name.endsWith('.ts')).map((name) => join(cliDir, name))];
    return Promise.all(files.map(async (path) => ({ path, text: await readFile(path, 'utf8') })));
}

/** Comments and string bodies blanked (newlines kept), so prose about a pattern is not read as the pattern. */
function codeOnly(text: string): string {
    return text
        .replace(/\/\*[\s\S]*?\*\//gu, (block) => block.replace(/[^\n]/gu, ' '))
        .replace(/(^|[^:])\/\/[^\n]*/gu, (match, prefix: string) => prefix + ' '.repeat(match.length - prefix.length))
        .replace(/'(?:[^'\\\n]|\\.)*'/gu, (literal) => `'${' '.repeat(Math.max(0, literal.length - 2))}'`)
        .replace(/`(?:[^`\\]|\\.)*`/gu, (literal) => `\`${' '.repeat(Math.max(0, literal.length - 2))}\``);
}

/**
 * **The class, enforced rather than restated.** Four review rounds each found the same shape — one rule
 * (`--flag value` and `--flag=value` are one flag; "absent" and "present but empty" are two facts) applied to the
 * readers that had been named and not to the adjacent ones. Fixing instances one at a time kept producing new
 * instances, so the rule is enforced here: a hand-rolled `argv.indexOf('--x')` / `argv.includes('--x')` /
 * `argv[i + 1]` in `src/cli/**` fails this case, and every value read goes through `readFlag`.
 */
describe('CLI value reads go through one reader', () => {
    it('finds no hand-rolled flag lookup left in src/cli', async () => {
        const offences: string[] = [];
        for (const { path, text } of await cliSources()) {
            if (path.endsWith('invocation.ts')) continue;
            const code = codeOnly(text);
            const lines = code.split('\n');
            for (const [index, line] of lines.entries()) {
                // `argv[i + 1]` is allowed only on a line that also takes the inline value from `splitFlag`, because
                // that is the shape in which both spellings and the flag-is-not-a-value guard are present together.
                const handRolled = /argv\s*\.\s*indexOf\(\s*'--/u.test(line)
                    || /argv\s*\.\s*includes\(\s*'--/u.test(line);
                const nextToken = /argv\s*\[\s*[A-Za-z_$][\w$.]*\s*\+\s*1\s*\]/u.test(line);
                const pairedWithInline = /splitFlag\(/u.test(line) || /inline\s*\?\?/u.test(line) || /readFlag\(/u.test(line);
                if (handRolled || (nextToken && !pairedWithInline)) {
                    offences.push(`${path}:${index + 1}  ${line.trim()}`);
                }
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

        // A flag is not the next flag's value — the guard R10-F1 showed was missing in the installer loop.
        expect(readFlag(['--root', '--dry-run'], '--root')).toEqual({ present: true, value: undefined });
        expect(readFlag(['--root', '--dry-run'], '--root').value).toBeUndefined();

        // The aliases are the same reader, so a fix in one cannot diverge from the others.
        expect(argValue(['--root=/ws'], '--root')).toBe('/ws');
        expect(argValue(['--root', '/ws'], '--root')).toBe('/ws');
        expect(inlineValue(['--root=/ws'], '--root')).toBe('/ws');
        expect(flagPresent(['--root='], '--root')).toBe(true);
        expect(splitFlag('--root=/ws')).toEqual({ flag: '--root', inline: '/ws' });
        expect(paradeArgValue(['--owned-path=a', '--owned-path=b'], '--owned-path')).toEqual(['a', 'b']);
        expect(paradeArgValue(['--owned-path', 'a', '--owned-path=b'], '--owned-path')).toEqual(['a', 'b']);
    });

    it('pins the two choices the review found unpinned: repeated inline values and an empty inline value', async () => {
        // R12-F12: disabling the inline branch of `repeatedValues` left the whole suite green, and so did making
        // `argValue` return an empty string instead of `undefined`. Both were real choices with no case behind them.
        const { repeatedValues } = await import('../../src/cli/workflow.js');
        expect(repeatedValues(['--reviewed-path=a.ts', '--reviewed-path=b.ts'], '--reviewed-path')).toEqual(['a.ts', 'b.ts']);
        expect(repeatedValues(['--reviewed-path', 'a.ts'], '--reviewed-path')).toEqual(['a.ts']);
        expect(() => repeatedValues(['--reviewed-path='], '--reviewed-path')).toThrow(/requires a value/u);

        // An empty inline value is "no value", not the empty string: `argValue(...) ?? fallback` must fall back.
        expect(argValue(['--seed='], '--seed')).toBeUndefined();
        expect(argValue(['--seed='], '--seed') ?? 'default').toBe('default');
    });
});
