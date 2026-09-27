import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * **How far a platform's name reaches: the coupling index, and the radius of adding one.**
 *
 * The plan asked for two measurements and neither existed. The first is *where* platform words appear in `src/` — the
 * kernel's own check covers `src/kernel/**`, which is the part that must be zero, and nothing measured the rest. The
 * second is the **adapter change radius**: how many files outside the adapter layer a new platform forces you to touch.
 * The answer is supposed to be zero; the honest number is in the table below, with a reason for every non-zero entry, and
 * the case fails when an unknown one appears rather than passing over it.
 *
 * Platform words are matched in code with comments blanked, because a comment may name a platform precisely in order to
 * say kata does not handle it.
 */
const PLATFORM_WORDS = ['claude', 'opencode', 'codex', 'cursor', 'gemini', 'litellm', 'deepseek', 'pi'] as const;

/**
 * Every module outside `src/adapters/**` that names a platform, and why it is allowed to.
 *
 * An entry here is a **decision**, not an exemption list: each says which fact about a platform the module needs and what
 * would have to exist before it could stop needing it. The case below fails on a file that is not in this table, so the
 * table cannot silently grow.
 */
const ALLOWED: Record<string, string> = {
    'src/core/layout.ts':
        'Workspace markers and ignored directories (`opencode.json`, `.opencode`): which files mark a repository root is a '
        + 'fact about the filesystems kata runs in, discovered while resolving `--root` — before any platform has been '
        + 'identified, so there is nobody to ask. Moving it needs a root-resolution hook the adapter layer does not have.',
    'src/core/repository-identity.ts':
        'The same fact for repository identity: `.codex`, `.claude`, `.opencode` are what identify a kata workspace from '
        + 'inside. Same reason and the same missing hook as `layout.ts`.',
    // **`src/workflow/worktree.ts` is deliberately absent, and that is a measurement rather than an omission.** It mentions
    // `.claude/worktrees/` and `.codex/…` only in its doc comment, describing the convention kata *stopped* leaving to each
    // host: linked worktrees now live under `.kata/worktrees/`, so the platform name is history in a comment and the code
    // is neutral. Blanking comments before scanning is what kept it out of the count, which is the same rule the kernel's
    // check uses and the reason a comment naming a platform is not coupling.
    // `src/cli/installer.ts` is absent for a related reason: it reaches a platform through `platformDefinitionById`, so no
    // platform name appears in its code at all.
    'src/cli/handoff.ts': 'The handoff surface: it names the platform an operator is handing work to, by design.',
    'src/cli/baseline.ts': 'Reports payload size per platform, so the platform is its parameter.',
};

const INSTALL_LAYER = ['src/adapters/'];

function sourceFiles(dir: string, found: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) sourceFiles(path, found);
        else if (path.endsWith('.ts')) found.push(path);
    }
    return found;
}

/** Comments blanked line-structure-preserving, which is the same rule the kernel's check uses. */
function codeOnly(source: string): string {
    return source
        .replace(/\/\*[\s\S]*?\*\//gu, (match) => match.replace(/[^\n]/gu, ' '))
        .split('\n')
        .map((line) => line.replace(/\/\/.*$/u, ''))
        .join('\n');
}

function offenders(): Array<{ file: string; words: string[] }> {
    const found: Array<{ file: string; words: string[] }> = [];
    for (const file of sourceFiles('src').sort()) {
        if (INSTALL_LAYER.some((prefix) => file.startsWith(prefix))) continue;
        const source = codeOnly(readFileSync(file, 'utf8')).toLowerCase();
        const words = PLATFORM_WORDS.filter((word) => new RegExp(`\\b${word}\\b`, 'u').test(source));
        if (words.length > 0) found.push({ file, words: [...words] });
    }
    return found;
}

describe('a platform\'s name reaches exactly as far as it is allowed to', () => {
    it('is zero in the kernel, and every other appearance is a decision with a reason', () => {
        const undeclared = offenders().filter((entry) => ALLOWED[entry.file] === undefined);
        expect(
            undeclared,
            'these modules name a platform and no reason is recorded for it, so the adapter change radius just grew: '
            + `${undeclared.map((entry) => `${entry.file} (${entry.words.join(', ')})`).join('; ')}. Either move the fact `
            + 'into the adapter layer or add an entry to ALLOWED saying which fact it needs and what would let it stop.',
        ).toEqual([]);
    });

    it('keeps the adapter change radius at four modules, and names what each is for', () => {
        const current = offenders();
        // The number *is* the radius: adding a platform must not make it grow. Measured, it is four, and they fall into
        // two groups — two CLI surfaces that take a platform as a parameter, and **one fact in two modules** (which files
        // mark a workspace root and what identifies a kata workspace from inside). The second group is what the plan's
        // "zero outside the adapter layer" goal is actually about, and it is one fact rather than two.
        expect(
            current.length,
            `files outside the adapter layer that name a platform, measured at four: ${current.map((entry) => entry.file).join(', ')}`,
        ).toBe(4);
        expect(current.map((entry) => entry.file)).toEqual([
            'src/cli/baseline.ts', 'src/cli/handoff.ts', 'src/core/layout.ts', 'src/core/repository-identity.ts',
        ]);
    });

    it('names a platform in no kernel file, which is the invariant the rest of this rests on', () => {
        for (const file of sourceFiles('src/kernel')) {
            const source = codeOnly(readFileSync(file, 'utf8')).toLowerCase();
            for (const word of PLATFORM_WORDS) {
                expect(new RegExp(`\\b${word}\\b`, 'u').test(source), `${file} names "${word}"`).toBe(false);
            }
        }
    });
});
