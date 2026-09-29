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
const ESCAPE = /\bas\s+never\b\s*[,;)\]]|\bas\s+unknown\s+as\s+/;

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

/** Comments removed, so a note *about* an escape is not read as one. */
function withoutComments(source: string): string {
    return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
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

    it('would catch the escapes it removed', async () => {
        // The scan is a scan: prove it fires on the shapes that were there, so a passing run means something.
        expect(ESCAPE.test('const a = revisionRead.revision as never);')).toBe(true);
        expect(ESCAPE.test('return result as unknown as Record<string, unknown>;')).toBe(true);
        expect(ESCAPE.test('// unexplained and unparseable is not the same fact as never written);')).toBe(false);
        expect(ESCAPE.test('const item = entry as Evidence;')).toBe(false);
    });
});