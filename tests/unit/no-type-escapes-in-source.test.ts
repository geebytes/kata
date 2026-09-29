import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * **A type escape is a place where the compiler stopped helping.**
 *
 * Two forms say "any value whatsoever is this type" rather than naming what is asserted: `x as never`, and
 * `x as unknown as T`. Both appeared in the identity path this change is about — `revisionRead.revision as never` in the
 * freeze-hash producer, and `record as never` where a binding was read off a review record — and each hid a real
 * mismatch: the producer's parameter was a structural *copy* of the reader's result, and the review record was never a
 * binding at all. Nineteen further sites in the tree carried the same shape, every one of them standing in for a
 * narrowing, a named assertion, or a type that should have been declared.
 *
 * A named assertion (`as Evidence`, `as Policy`) is not banned: it says which type the code is claiming, next to the
 * checks that make the claim true. What is banned is the form that claims nothing.
 *
 * The scan reads comments-stripped source, and requires a code position after `never` — the guidance text this
 * repository generates contains the phrase "as never written", which is prose rather than an escape.
 */
/**
 * The two banned forms, in code only.
 *
 * - **`as never`, anywhere.** `x as never` says the value belongs to no type at all; the only thing it can satisfy is the
 *   checker, and it can be laundered back into any type with a second `as` (`x as never as T`), which is why the first
 *   version — requiring a `,`/`;`/`)`/`]` straight after `never` — missed the form the criterion names. The right-hand
 *   boundary is a word boundary now, so `as never as T` and a bare `as never` at end of line are both caught.
 * - **`as unknown as T`.** It launders any value into a claimed type with no validation in between.
 *
 * **Bare `as unknown` is deliberately not banned, and the reason is measured.** Thirteen sites use it in this tree, every
 * one of them `JSON.parse(…) as unknown` (`src/cli/ledger.ts` ×3, `src/cli/tasks.ts`, `src/core/layout.ts`,
 * `src/core/relations.ts`, `src/quality/repair.ts`, `src/store/ledger.ts`, `src/wiki/closure.ts`, `src/adapters/*`,
 * `src/producers/submission.ts` ×2). That cast *removes* `any`: it is the first half of "parse, then validate, then
 * narrow", and the alternative a blanket ban forces is a cast to a named type nobody checked — worse than the `any` it
 * would replace. A criterion wide enough to forbid it would damage the code it is meant to protect.
 */
const ESCAPE = /\bas\s+never\b|\bas\s+unknown\s+as\b/;

async function sourceFiles(dir: string): Promise<string[]> {
    const entries = await readdir(dir, { withFileTypes: true });
    const files: string[] = [];
    for (const entry of entries) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) files.push(...await sourceFiles(path));
        else if (entry.name.endsWith('.ts')) files.push(path);
    }
    return files;
}

/**
 * Comments AND string literals blanked, so the scan reads code.
 *
 * Both halves are measured. `src/adapters/phase-guidance.ts` generates guidance text containing the phrase "as never
 * written", which a comment-stripping scan would report as an escape — prose is not a cast. And strings matter in the same
 * direction: an instruction string that names a forbidden form is a *description* of one. Blanking keeps every character's
 * position, so the reported line numbers stay true; deleting a block comment's newlines is what made a sibling guard read a
 * region eighteen lines away.
 */
function withoutComments(source: string): string {
    const blank = (text: string): string => text.replace(/[^\n]/g, ' ');
    return source
        .replace(/\/\*[\s\S]*?\*\//g, blank)
        .replace(/^[ \t]*\/\/.*$/gm, blank)
        .replace(/`(?:\\[\s\S]|[^`\\])*`/g, blank)
        .replace(/'(?:\\.|[^'\\\n])*'/g, blank)
        .replace(/"(?:\\.|[^"\\\n])*"/g, blank);
}

describe('no source file escapes a type with a cast to never or unknown', () => {
    it('finds no escape anywhere under src/', async () => {
        const files = await sourceFiles('src');
        expect(files.length).toBeGreaterThan(50);
        const offenders: string[] = [];
        for (const file of files) {
            const source = withoutComments(await readFile(file, 'utf8'));
            source.split('\n').forEach((line, index) => {
                if (ESCAPE.test(line)) offenders.push(`${file}:${index + 1}`);
            });
        }
        expect(offenders).toEqual([]);
    });

    it('reads the freeze-hash producer through the exported read type', async () => {
        const source = await readFile('src/quality/review-ir.ts', 'utf8');
        // The parameter names the reader's own result. A structural copy drifts: the copy here declared
        // `revision: { id: string }` while the real read carries the whole revision, which is what the cast was for.
        expect(source).toContain('revisionRead?: CurrentRevisionRead');
        expect(source).toContain("from '../workflow/revision.js'");
    });

    it('would catch every form of the two escapes, including the ones the first version missed', async () => {
        // The scan is a scan: prove it fires on the shapes that were there *and* on the shapes an independent review
        // measured as invisible, so a passing run means something.
        const banned = [
            'const a = revisionRead.revision as never);',
            'return result as unknown as Record<string, unknown>;',
            // Measured invisible to the first version: the exact form the criterion names.
            'const x = (y as never as string);',
            // And the same form at the end of a line, with no punctuation after it.
            'const x = y as never',
        ];
        // Through the scan's own reading of the source, not through the bare pattern: the prose half is what the scan
        // exists to ignore, so testing the pattern alone would report the very false positive the scan removes.
        const flags = (line: string): boolean => ESCAPE.test(withoutComments(line));
        for (const line of banned) expect([line, flags(line)]).toEqual([line, true]);

        const allowed = [
            // Prose: a phrase in generated guidance, not a cast.
            '// unexplained and unparseable is not the same fact as never written);',
            'const item = entry as Evidence;',
            // The safe direction, kept deliberately — see the note on the pattern.
            'const parsed = JSON.parse(text) as unknown;',
            "const subject = ledger.subject; // not `as never` any more",
        ];
        for (const line of allowed) expect([line, flags(line)]).toEqual([line, false]);
    });

    it('reads code rather than prose, so a sentence about an escape is not an escape', () => {
        const source = [
            'const guidance = `Never write the code under review; an artefact that is as never written is not a record`;',
            'const real = (value as never as string);',
        ].join('\n');
        const blanked = withoutComments(source);
        // The template literal is gone from the text the scan reads, and the cast on the next line survives.
        expect(blanked).not.toContain('as never written');
        expect(ESCAPE.test(blanked.split('\n')[1] ?? '')).toBe(true);
    });
});