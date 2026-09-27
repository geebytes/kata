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
    /**
     * **This case asserted a property of a file that no longer exists, and the file is the reason it is kept as a note.**
     *
     * `host/pi-adapter.ts` was the reference launcher: kata ran it through `adversarial execute`, it spawned an isolated
     * session and mapped that session's stream into the six event kinds, and this case proved it held no enforcement — no
     * envelope arithmetic, no receipt, no kill. Its invoker was deleted with the round protocol, so the boundary it sat on
     * has nothing on the other side; the file went with it (`2026-09-26-decoupled-round-protocol.md`, addendum).
     *
     * The property itself is not lost, and that is why the note stays: on the ledger route **kata runs the checks itself**
     * through the `inline` adapter, so there is no host half left to hold enforcement away from. What the case was for — an
     * authorised party must not be able to produce its own independence evidence — is now the kernel's shape rather than a
     * boundary between two programs.
     */
    it('has no host half left to police: assurance comes from the adapter kata itself runs', async () => {
        const { createInlineAdapter, createFileAdapter } = await import('../../src/assurance/adapters/inline-adapter.js')
            .then(async (inline) => ({ createInlineAdapter: inline.createInlineAdapter, createFileAdapter: (await import('../../src/assurance/adapters/file-adapter.js')).createFileAdapter }));
        expect(createInlineAdapter().assurance).toBe('observed');
        expect(createFileAdapter({ dir: '.kata/review-results' }).assurance).toBe('relayed');
        // No level above these two is offered, so no adapter can claim isolation it has not got.
        for (const adapter of [createInlineAdapter(), createFileAdapter({ dir: '.kata/review-results' })]) {
            expect(['observed', 'relayed']).toContain(adapter.assurance);
        }
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
