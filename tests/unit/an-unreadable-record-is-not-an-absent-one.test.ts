import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { mostRecentDifferentContent } from '../../src/workflow/revision.js';
import { revisionsDir } from '../../src/core/layout.js';

/**
 * **The reference must not depend on the order the filesystem happens to return.**
 *
 * `mostRecentDifferentContent` sorts by `createdAt` alone, so two revisions sealed inside the same millisecond resolved by
 * `readdir` order — ext4 hash order and a sorted tmpfs disagree, which means the same store could name a different
 * reference (and therefore a different plan and declared subject) on another host. The revision id is the secondary key.
 *
 * The guard does not assume an order: it builds the same two revisions in **opposite insertion orders** in two roots and
 * requires both roots to name the same reference.
 */
const roots: string[] = [];
afterEach(async () => {
    await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const AT = '2026-10-08T00:00:00.000Z';
const current = { 'a.ts': 'a'.repeat(64) };
// The shape `schemas/revision.schema.json` requires: id, taskId, ownedPaths, manifestHash, createdAt.
const revision = (id: string, digest: string) => ({
    id,
    taskId: 'tie',
    ownedPaths: ['a.ts'],
    manifestHash: 'b'.repeat(64),
    pathDigests: { 'a.ts': digest },
    contentDigests: { 'a.ts': digest },
    createdAt: AT,
});

/** Each revision carries its own digest, so the guard can say *which* one the reference is. */
const DIGESTS: Record<string, string> = {
    'revision-aaaaaaaaaaaaaaaa': '1'.repeat(64),
    'revision-bbbbbbbbbbbbbbbb': '2'.repeat(64),
};

async function store(order: string[]): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'kata-tie-'));
    roots.push(root);
    const dir = revisionsDir(root, 'tie');
    await mkdir(dir, { recursive: true });
    for (const name of order) await writeFile(join(dir, `${name}.json`), `${JSON.stringify(revision(name, DIGESTS[name]))}\n`);
    return root;
}

describe('the reference does not depend on directory order', () => {
    it('names the same reference whichever order the two revisions were written in', async () => {
        const first = await store(['revision-aaaaaaaaaaaaaaaa', 'revision-bbbbbbbbbbbbbbbb']);
        const second = await store(['revision-bbbbbbbbbbbbbbbb', 'revision-aaaaaaaaaaaaaaaa']);
        const fromFirst = await mostRecentDifferentContent(first, 'tie', current);
        const fromSecond = await mostRecentDifferentContent(second, 'tie', current);
        expect(fromSecond).toEqual(fromFirst);
        // **And it names a specific one**, not merely the same one twice: with `createdAt` equal the id decides, so the
        // greater id wins. Asserting stability alone was blind here — this filesystem returns `readdir` sorted, so removing
        // the tie-break still produced the same answer twice and the guard could not see it.
        expect(fromFirst).toEqual({ kind: 'found', digests: { 'a.ts': DIGESTS['revision-bbbbbbbbbbbbbbbb'] } });
    });
});
