import { mkdir, readFile, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { writeFileAtomic } from './state.js';

function lockRootForArtefact(callerRoot: string, artefactPath: string): string {
    const resolvedPath = resolve(artefactPath);
    const kataSegment = `${sep}.kata${sep}`;
    const kataOffset = resolvedPath.lastIndexOf(kataSegment);
    // Repository artefacts live below <repository>/.kata/. Their lock identity follows that owner path,
    // not the caller that happened to reach it through a linked worktree. Retain the caller fallback
    // for a future non-Kata artefact instead of inventing a second layout rule here.
    return kataOffset === -1 ? resolve(callerRoot) : resolvedPath.slice(0, kataOffset);
}

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
    const lockRoot = lockRootForArtefact(root, path);
    const lockDir = join(lockRoot, '.kata', 'locks');
    const lockPath = join(lockDir, `${name}.lock`);
    await mkdir(lockDir, { recursive: true });
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
