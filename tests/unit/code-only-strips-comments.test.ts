import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * A measurement must measure the thing it names.
 *
 * Three counterexamples in one session were raised against code and matched a comment instead — a sentence saying the
 * adapter no longer arms a timer, and a doc comment describing the defect a fix had removed. Each opened a challenge
 * against a defect that was not there. So the stripper is a tool with its own check: the code survives, the prose does
 * not, and the line structure is kept so a reported position still points at the line it came from.
 */
const dir = mkdtempSync(join(tmpdir(), 'kata-code-only-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function strip(source: string): string {
    const file = join(dir, `sample-${Math.abs(source.length)}.ts`);
    writeFileSync(file, source);
    return execFileSync('node', [join(process.cwd(), 'scripts', 'code-only.mjs'), file], { encoding: 'utf8' });
}

describe('the comment stripper measures code rather than prose', () => {
    it('removes a line comment and keeps the code beside it', () => {
        const out = strip('const a = 1; // maxWallMs is gone\n');
        expect(out).toContain('const a = 1;');
        expect(out).not.toContain('maxWallMs');
        expect(out.split('\n').length).toBe(2);
    });

    it('removes a block comment, including a multi-line one', () => {
        const out = strip('/**\n * changedPaths: []\n */\nexport const x = 1;\n');
        expect(out).not.toContain('changedPaths');
        expect(out).toContain('export const x = 1;');
        expect(out.split('\n').length).toBe(5);
    });

    it('does not touch a string literal, because a string is code', () => {
        const out = strip('const pattern = "changedPaths: []";\n');
        expect(out).toContain('"changedPaths: []"');
    });

    it('fails on a file it cannot read instead of printing nothing', () => {
        expect(() => execFileSync('node', [join(process.cwd(), 'scripts', 'code-only.mjs'), join(dir, 'absent.ts')], { stdio: 'pipe' }))
            .toThrow();
    });
});
