import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordMutation, withVerificationWindow, type VerificationWindow } from '../../src/store/verify-context.js';

/**
 * **A run that dies mid-cycle leaves a repair note, not a broken checkout.**
 *
 * An independent round killed a run between the injection and the restore: the file kept the defect and the lock was never
 * released, so every later run on that file reported `refuted … the check was already failing before any mutation` — a
 * misdiagnosis pointing at the check instead of at the tree. Two further rounds of that review then broke the first repair:
 * the journal was written by a helper the production path never called, the recovery could write outside the workspace, and
 * reclaiming a lock on the mere presence of a journal stole live locks.
 */

/**
 * The journal a killed run left, written by the production path — **and read back from disk**, not reconstructed here.
 *
 * The window no longer hands out a key, so the guard finds the note by looking for it rather than by re-deriving its name:
 * a guard that recomputes the name the code computes would keep passing if both moved together, which is exactly how the
 * earlier key-based guards missed two holes.
 */
async function killedCycleNote(root: string, file: string, original: string, injected: string): Promise<string> {
    await expect(withVerificationWindow(root, file, async (window: VerificationWindow) => {
        await recordMutation(window, original, injected);
        throw new Error('killed before the restore');
    })).rejects.toThrow('killed before the restore');
    const notes = (await readdir(join(root, '.kata', 'locks'))).filter((name) => name.endsWith('.journal.json'));
    expect(notes).toHaveLength(1);
    return notes[0] as string;
}

describe('a crashed cycle leaves a repair note', () => {
    it('is written by the production path, and the next run repairs from it and reclaims the lock', async () => {
        const root = await mkdtemp(join(tmpdir(), 'kata-journal-'));
        const original = 'const x = 1;\n';
        const injected = 'const x = 2;\n';
        await writeFile(join(root, 'a.ts'), injected);
        // **The leftovers a killed run leaves, written by the production path.** The journal is the one the cycle itself
        // wrote; the lock is re-created here because a killed process never reaches the `finally` that would have removed it.
        const note = await killedCycleNote(root, 'a.ts', original, injected);
        const locks = join(root, '.kata', 'locks');
        // The lock is the repository's now: one cycle at a time, with no per-file key to re-derive.
        const lockDir = join(locks, 'verify-repository.lock');
        await mkdir(lockDir, { recursive: true });
        // A holder that is gone: the pid is not running, so the lock is reclaimable.
        await writeFile(join(lockDir, 'holder.json'), JSON.stringify({ pid: 999_999, startedAt: '2026-10-08T00:00:00.000Z' }));

        const ran = await withVerificationWindow(root, 'a.ts', async () => 'ran');
        expect(ran).toBe('ran');
        expect(await readFile(join(root, 'a.ts'), 'utf8')).toBe(original);
        await rm(root, { recursive: true, force: true });
    });

    it('does not steal a lock whose holder is still alive', async () => {
        const root = await mkdtemp(join(tmpdir(), 'kata-live-'));
        await writeFile(join(root, 'a.ts'), 'const x = 1;\n');
        await killedCycleNote(root, 'a.ts', 'const x = 1;\n', 'const x = 2;\n');
        const locks = join(root, '.kata', 'locks');
        const lockDir = join(locks, 'verify-repository.lock');
        await mkdir(lockDir, { recursive: true });
        await writeFile(join(lockDir, 'holder.json'), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));

        // The holder is this very process, so the lock is live: the run must wait, not steal.
        const attempt = withVerificationWindow(root, 'a.ts', async () => 'ran');
        const outcome = await Promise.race([attempt.then(() => 'ran', (error: Error) => error.message), new Promise((resolve) => setTimeout(() => resolve('waited'), 200))]);
        expect(outcome).toBe('waited');
        await rm(locks, { recursive: true, force: true });
        await rm(root, { recursive: true, force: true });
    });

    it('refuses to repair a path outside the workspace', async () => {
        const root = await mkdtemp(join(tmpdir(), 'kata-outside-'));
        await writeFile(join(root, 'a.ts'), 'const x = 2;\n');
        await writeFile(join(root, 'outside.txt'), 'untouched\n');
        const note = await killedCycleNote(root, 'a.ts', 'const x = 1;\n', 'const x = 2;\n');
        const locks = join(root, '.kata', 'locks');
        // The note names a path outside the workspace: the repair is contained, so nothing is written there.
        await writeFile(join(locks, note), JSON.stringify({ file: '../outside.txt', original: 'PWNED\n' }));

        await withVerificationWindow(root, 'a.ts', async () => 'ran');
        expect(await readFile(join(root, 'outside.txt'), 'utf8')).toBe('untouched\n');
        await rm(root, { recursive: true, force: true });
    });
});

/**
 * **The repair is a write too, and it refuses a link for the same reason the restore does.**
 *
 * A killed run's note names a path; if something has since made that path a symlink, the repair would write the note's
 * original content through it into whatever the link points at. This is the restore's rule arriving by the other door, and
 * the case exists so the door is shut on both.
 */
describe('a repair never writes through a link', () => {
    it('leaves the linked file alone and removes the note', async () => {
        const root = await mkdtemp(join(tmpdir(), 'kata-repair-link-'));
        const original = 'const x = 1;\n';
        const injected = 'const x = 2;\n';
        const peer = 'b.ts';
        // **The peer holds the injected bytes**, so the repair's "is the injection still there?" test says yes and the only
        // thing left standing between the note and the peer is the link refusal. With other content the case would pass on
        // the hash test alone, which is how a guard ends up measuring its neighbour.
        const peerContent = injected;
        await writeFile(join(root, 'a.ts'), injected);
        await writeFile(join(root, peer), peerContent);
        const note = await killedCycleNote(root, 'a.ts', original, injected);
        // The target is a link now, and the note's name still matches the file it is about.
        await rm(join(root, 'a.ts'), { force: true });
        await symlink(peer, join(root, 'a.ts'));

        await withVerificationWindow(root, 'a.ts', async () => 'ran');
        // The file the note is *not* about is untouched, and the note is gone: quarantined, not replayed through a link.
        expect(await readFile(join(root, peer), 'utf8')).toBe(peerContent);
        expect((await readdir(join(root, '.kata', 'locks'))).filter((name) => name.endsWith('.journal.json'))).toEqual([]);
        await rm(root, { recursive: true, force: true });
    });
});
