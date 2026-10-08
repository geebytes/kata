import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withVerificationLock } from '../../src/store/verify-context.js';

/**
 * **A run that dies mid-cycle leaves a repair note, not a broken checkout.**
 *
 * An independent round killed a run between the injection and the restore: the file kept the injected defect and the lock was
 * never released (no PID, no liveness, no TTL), so every later run on that file reported `refuted … the check was already
 * failing before any mutation` — a misdiagnosis pointing at the check instead of at the tree. The journal is written before
 * the defect exists, so the next run can repair the file and reclaim the lock.
 */
describe('a crashed cycle leaves a repair note', () => {
    it('restores the file from the journal and reclaims the lock', async () => {
        const root = await mkdtemp(join(tmpdir(), 'kata-journal-'));
        const locks = join(root, '.kata', 'locks');
        await mkdir(locks, { recursive: true });
        await writeFile(join(root, 'a.ts'), 'const x = 1;\n// injected before crash\n');
        // The leftovers a killed run leaves: a journal naming the file and its original bytes, and the lock it held.
        const key = (await import('../../src/core/hash.js')).hashContent(join(root, 'a.ts')).slice(0, 16);
        await writeFile(join(locks, `verify-${key}.journal.json`), JSON.stringify({ file: 'a.ts', original: 'const x = 1;\n' }));
        await mkdir(join(locks, `verify-${key}.lock`));

        const ran = await withVerificationLock(root, 'a.ts', async () => 'ran');
        expect(ran).toBe('ran');
        expect(await readFile(join(root, 'a.ts'), 'utf8')).toBe('const x = 1;\n');
        // And the note is consumed, so a later run does not restore a file that is already correct.
        await expect(readFile(join(locks, `verify-${key}.journal.json`), 'utf8')).rejects.toThrow();
        await rm(root, { recursive: true, force: true });
    });
});
