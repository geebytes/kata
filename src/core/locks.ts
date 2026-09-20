import { mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { writeFileAtomic } from './state.js';

/**
 * Mutual exclusion for a repository-scoped artefact.
 *
 * `withTaskLock` covers task state and cannot cover `.kata/relations.json` or `.kata/wiki/*.json`, which belong to the
 * repository rather than to one task. The mechanism is deliberately identical — a lock *directory*, created with `mkdir`
 * so it is atomic on every filesystem kata runs on, and failing closed on `EEXIST` — because two lock designs is one
 * more than anyone can hold in their head, and the failure mode of the second is the one nobody tested.
 *
 * The lock covers the **read** as well as the write: `mutate` receives the current contents and returns the bytes to
 * write, so no caller can accidentally hold the stale read across the critical section. That is the same shape
 * `mutateTaskArtefact` uses, for the same reason.
 */
export async function withRepositoryArtefactLock(
    root: string,
    name: string,
    path: string,
    mutate: (current: string) => Promise<string>,
): Promise<void> {
    const lockPath = join(root, '.kata', 'locks', `${name}.lock`);
    await mkdir(join(root, '.kata', 'locks'), { recursive: true });
    try {
        await mkdir(lockPath);
    } catch (error) {
        if (typeof error === 'object' && error !== null && (error as NodeJS.ErrnoException).code === 'EEXIST') {
            throw new Error(`Another kata process is mutating ${name}; retry once it finishes`);
        }
        throw error;
    }
    try {
        const current = await readFile(path, 'utf8').catch(() => '');
        const content = await mutate(current);
        await writeFileAtomic(path, content);
    } finally {
        await rm(lockPath, { recursive: true, force: true });
    }
}
