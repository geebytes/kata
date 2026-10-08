import { mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { clearMutation, recordMutation, withVerificationWindow } from '../../src/store/verify-context.js';
import { verifyAll } from '../../src/producers/verifiers.js';
import type { VerifyContext } from '../../src/producers/port.js';

/**
 * **One identity per cycle, derived once and carried — because the file it names can change underneath it.**
 *
 * The lock and journal key used to be recomputed at each of the three sites that needed it: the window's entry, the journal
 * write, and the clear. A check that rewrites its own target — an ordinary `mv` of a temp file, which is how a formatter or
 * a preprocessor lands its result — changes the inode *inside* the window, so the clear looked for a journal under a name
 * nobody had written. An independent round measured both consequences: every successful cycle left a stale journal behind
 * while reporting success, and a killed run's defect was never repaired because its journal had become an orphan.
 *
 * The identity is now derived once at the window's entry and carried in the window, and the repair a later cycle performs
 * finds a journal **by the file it names** — the one thing about it that a replaced inode cannot invalidate.
 */
const roots: string[] = [];
afterEach(async () => {
    await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const original = 'const x = 1;\n';
const injected = 'const x = 2;\n';

const journalsIn = async (root: string): Promise<string[]> => {
    const dir = join(root, '.kata', 'locks');
    return (await readdir(dir).catch(() => [])).filter((name) => name.endsWith('.journal.json'));
};

/** Replace a file the way a check that rewrites its own target does: same path, new inode. */
async function replaceAtomically(root: string, file: string, content: string): Promise<void> {
    const temp = join(root, `.replacement-${file.replaceAll('/', '-')}`);
    await writeFile(temp, content);
    await rename(temp, join(root, file));
}

describe('the cycle identity is derived once and carried', () => {
    it('repairs a killed run after the file was replaced inside its window', async () => {
        const root = await mkdtemp(join(tmpdir(), 'kata-key-repair-'));
        roots.push(root);
        const file = 'a.ts';
        await writeFile(join(root, file), injected);
        // The note a killed run leaves, written by the production path: the cycle writes the journal before injecting, and a
        // process that dies there never reaches the clear.
        await expect(
            withVerificationWindow(root, file, async (window) => {
                await recordMutation(window, original, injected);
                throw new Error('killed before the restore');
            }),
        ).rejects.toThrow('killed before the restore');
        // **And the check had already replaced its own target**, so the inode the killed run keyed on no longer exists.
        await replaceAtomically(root, file, injected);

        // The next run repairs from the note, which it finds by the file the note names rather than by a key derived now.
        await withVerificationWindow(root, file, async () => 'ran');
        expect(await readFile(join(root, file), 'utf8')).toBe(original);
        expect(await journalsIn(root)).toEqual([]);
    });

    it('leaves no stale journal when a successful cycle replaced its target', async () => {
        const root = await mkdtemp(join(tmpdir(), 'kata-key-clear-'));
        roots.push(root);
        const file = 'a.ts';
        await writeFile(join(root, file), original);
        let calls = 0;
        const context = {
            root,
            subject: { revision: `rev:${'a'.repeat(16)}`, pathDigests: { [file]: 'a'.repeat(64) } },
            run: async () => {
                calls += 1;
                // The mutated run is where a real check rewrites its own target: the content it reads is what it writes back,
                // so nothing is lost — only the inode moves.
                if (calls === 2) await replaceAtomically(root, file, await readFile(join(root, file), 'utf8'));
                const content = await readFile(join(root, file), 'utf8');
                return { code: content.includes('const x = 2;') ? 1 : 0, stdout: '', stderr: '', timedOut: false };
            },
            now: () => '2026-10-08T00:00:00.000Z',
            producer: () => 'fixture',
            readText: async (path: string) => (path === file ? await readFile(join(root, file), 'utf8') : null),
            writeText: async (path: string, content: string) => { if (path === file) await writeFile(join(root, file), content); },
        } as unknown as VerifyContext;
        const item = { id: 'E9', type: 'executable_falsifier' as const, command: 'true', mutation: { file, find: 'const x = 1;', replace: 'const x = 2;' } };

        const verdicts = await verifyAll([item], context);
        expect(verdicts[0].verdict).toBe('supported');
        expect(await readFile(join(root, file), 'utf8')).toBe(original);
        // **A cycle that says it restored the file has also cleared its note.** The clear used to recompute the key from the
        // inode as it stood *then*, which the check had just replaced, so the journal survived a successful run.
        expect(await journalsIn(root)).toEqual([]);
    });

    it('clears the journal the cycle itself wrote, under the key it wrote it with', async () => {
        const root = await mkdtemp(join(tmpdir(), 'kata-key-same-'));
        roots.push(root);
        const file = 'a.ts';
        await writeFile(join(root, file), original);
        let key = '';
        let journalDuring = '';
        await withVerificationWindow(root, file, async (window) => {
            key = window.key;
            await recordMutation(window, original, injected);
            journalDuring = (await journalsIn(root))[0] ?? '';
            await clearMutation(window);
        });
        // The name is derived from the window's key, so "the journal this cycle wrote" and "the journal this cycle cleared"
        // are the same file by construction rather than by a repeated derivation that can disagree.
        expect(journalDuring).toBe(`verify-${key}.journal.json`);
        expect(await journalsIn(root)).toEqual([]);
    });
});
