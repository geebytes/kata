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
    it('keeps the enforcement in kata: the adapter writes no receipt and computes no envelope', async () => {
        // The property *is* the absence of code, so it is asserted over the file. The first version checked three string absences and
        // missed the real one: the adapter read `budget.maxWallMs`, added 30 000 ms and armed its own `kill` — the envelope's wall-clock
        // term, derived and enforced by the host, which kata also arms. A test that names a few strings is a test that passes until
        // someone writes the thing it did not think of, so this one names the whole family.
        const adapter = await readFile('host/pi-adapter.ts', 'utf8');
        const code = adapter.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
        for (const forbidden of ['requestSha256', 'maxToolCalls', 'maxWallMs', 'maxHypotheses', 'maxOutputBytes', 'setTimeout', 'kill(', 'receiptPath', 'kind: \'receipt\'']) {
            expect(code, `the adapter names \`${forbidden}\`, so it is enforcing or authoring something kata owns`).not.toContain(forbidden);
        }
        // And what it does do: emit the events and nothing else.
        expect(code).toContain("kind: 'launched'");
        expect(code).toContain("kind: 'result'");
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
                    // **Static and dynamic.** A lazy `await import('../host/…')` is the idiom this codebase uses for every module it
                    // loads on demand, and the first version matched `from '…'` only — so it would have said "kata never imports it"
                    // about a file that imports it lazily.
                    if (/from\s+['"][^'"]*\/host\/|from\s+['"]host\/|import\(\s*['"][^'"]*\/host\//.test(source)) offenders.push(path);
                }
            }
        };
        await walk(join(process.cwd(), 'src'));
        expect(offenders).toEqual([]);
    });
});
