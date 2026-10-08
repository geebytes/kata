import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordMutation, withVerificationLock } from '../../src/store/verify-context.js';

/**
 * **A run that dies mid-cycle leaves a repair note, not a broken checkout.**
 *
 * An independent round killed a run between the injection and the restore: the file kept the defect and the lock was never
 * released, so every later run on that file reported `refuted … the check was already failing before any mutation` — a
 * misdiagnosis pointing at the check instead of at the tree. Two further rounds of that review then broke the first repair:
 * the journal was written by a helper the production path never called, the recovery could write outside the workspace, and
 * reclaiming a lock on the mere presence of a journal stole live locks.
 */
describe('a crashed cycle leaves a repair note', () => {
    it('is written by the production path, and the next run repairs from it and reclaims the lock', async () => {
        const root = await mkdtemp(join(tmpdir(), 'kata-journal-'));
        const original = 'const x = 1;\n';
        const injected = 'const x = 2;\n';
        await writeFile(join(root, 'a.ts'), injected);
        // The leftovers a killed run leaves: the journal the cycle wrote before injecting, and the lock it held.
        await recordMutation(root, 'a.ts', original, injected);
        const locks = join(root, '.kata', 'locks');
        // The lock's name carries the key, so it is derived from the journal rather than guessed: the guard drives the same
        // identity the production path does.
        const journalName = (await readdir(locks)).find((entry) => entry.endsWith('.journal.json'));
        expect(journalName).toBeDefined();
        const lockDir = join(locks, `${(journalName ?? '').replace('.journal.json', '')}.lock`);
        await mkdir(lockDir, { recursive: true });
        // A holder that is gone: the pid is not running, so the lock is reclaimable.
        await writeFile(join(lockDir, 'holder.json'), JSON.stringify({ pid: 999_999, startedAt: '2026-10-08T00:00:00.000Z' }));

        const ran = await withVerificationLock(root, 'a.ts', async () => 'ran');
        expect(ran).toBe('ran');
        expect(await readFile(join(root, 'a.ts'), 'utf8')).toBe(original);
        await rm(root, { recursive: true, force: true });
    });

    it('does not steal a lock whose holder is still alive', async () => {
        const root = await mkdtemp(join(tmpdir(), 'kata-live-'));
        await writeFile(join(root, 'a.ts'), 'const x = 1;\n');
        await recordMutation(root, 'a.ts', 'const x = 1;\n', 'const x = 2;\n');
        const locks = join(root, '.kata', 'locks');
        const journalName = (await readdir(locks)).find((entry) => entry.endsWith('.journal.json'));
        const lockDir = join(locks, `${(journalName ?? '').replace('.journal.json', '')}.lock`);
        await mkdir(lockDir, { recursive: true });
        await writeFile(join(lockDir, 'holder.json'), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));

        // The holder is this very process, so the lock is live: the run must wait, not steal.
        const attempt = withVerificationLock(root, 'a.ts', async () => 'ran');
        const outcome = await Promise.race([attempt.then(() => 'ran', (error: Error) => error.message), new Promise((resolve) => setTimeout(() => resolve('waited'), 200))]);
        expect(outcome).toBe('waited');
        await rm(locks, { recursive: true, force: true });
        await rm(root, { recursive: true, force: true });
    });

    it('refuses to repair a path outside the workspace', async () => {
        const root = await mkdtemp(join(tmpdir(), 'kata-outside-'));
        await writeFile(join(root, 'a.ts'), 'const x = 2;\n');
        await writeFile(join(root, 'outside.txt'), 'untouched\n');
        await recordMutation(root, 'a.ts', 'const x = 1;\n', 'const x = 2;\n');
        const locks = join(root, '.kata', 'locks');
        const journal = (await readdir(locks)).find((entry) => entry.endsWith('.journal.json'));
        await writeFile(join(locks, journal ?? ''), JSON.stringify({ file: '../outside.txt', original: 'PWNED\n' }));

        await withVerificationLock(root, 'a.ts', async () => 'ran');
        expect(await readFile(join(root, 'outside.txt'), 'utf8')).toBe('untouched\n');
        await rm(root, { recursive: true, force: true });
    });
});
