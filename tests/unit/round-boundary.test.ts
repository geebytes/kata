import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * **The executor holds no enforcement, and kata never reaches into it** — criterion AC-5.
 *
 * Both halves are the absence of code, which is why they are asserted over the files rather than exercised: a host that computed the envelope
 * or built the receipt would have taken back the half the redesign moved, and `src/` importing `host/` would let the authorised party produce
 * its own independence evidence.
 */

describe('the boundary between kata and its executor', () => {
    it('keeps the enforcement in kata: the adapter writes no receipt and counts nothing', async () => {
        // The plan's criterion 6, as a source assertion because the property *is* the absence of code: a host that computes the envelope, or
        // constructs the artefact, has taken back the half the redesign moved. A test over the file is the only way to say "this stays absent".
        const adapter = await readFile('host/pi-adapter.ts', 'utf8');
        const code = adapter.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
        expect(code).not.toContain('requestSha256');
        expect(code).not.toContain('maxToolCalls');
        expect(code).not.toMatch(/kind: 'receipt'|receiptPath/);
    });
    it('is not part of the kata executable: src/ never imports host/', async () => {
        // The boundary is a checked fact, not a promise. `host/` produces the events that become a receipt for rounds reviewing kata's own
        // changes; if kata could call it, the authorised party would be producing its own independence evidence.
        const offenders: string[] = [];
        const walk = async (dir: string): Promise<void> => {
            for (const entry of await readdir(dir, { withFileTypes: true })) {
                const path = join(dir, entry.name);
                if (entry.isDirectory()) await walk(path);
                else if (/\.tsx?$/.test(entry.name)) {
                    const source = await readFile(path, 'utf8');
                    if (/from\s+['"][^'"]*\/host\/|from\s+['"]host\//.test(source)) offenders.push(path);
                }
            }
        };
        await walk(join(process.cwd(), 'src'));
        expect(offenders).toEqual([]);
    });
});
