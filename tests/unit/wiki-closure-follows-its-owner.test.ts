import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initLayout, wikiDir } from '../../src/core/layout.js';
import { createTask } from '../../src/core/task.js';
import { writeWikiRecord } from '../../src/wiki/store.js';
import { evaluateWikiClosure, writeWikiClosure } from '../../src/wiki/closure.js';

/**
 * **The closure gate must be satisfiable from inside the worktree it is asked about.**
 *
 * Measured on the first task sealed under `isolated_worktree`: `kata-cli wiki register` (not a workflow command, so the
 * workspace root) wrote the candidate to the primary checkout's store, while `kata-cli verify --change` (task-addressed, so
 * the code root) read the worktree's own `.kata/wiki`, which does not exist. The gate then answered `candidate_missing` for
 * a candidate that exists, and its own remedy — "register the page first" — reproduced the state. Review and archive stay
 * closed, and the only workaround is to copy the store into the worktree, which is the fault the project already documents:
 * a second answer to the same question, under a directory the archive deletes.
 *
 * The second half of this suite is what keeps the repair from becoming "accept any id": a candidate that was never
 * registered must still fail closed.
 */
const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

const now = '2026-10-06T00:00:00.000Z';
const candidateId = 'llmwiki-concepts-registered-through-the-worktree';

async function fixture(): Promise<{ primary: string; linked: string }> {
    const primary = await mkdtemp(join(tmpdir(), 'kata-wiki-owner-'));
    roots.push(primary);
    await initLayout(primary);
    await createTask({
        root: primary,
        id: 'wiki-task',
        title: 'Wiki',
        acceptance: [{ id: 'AC-1', statement: 'x' }],
        ownedPaths: ['src/a.ts'],
    });
    // **The real shape.** A worktree a task is working in holds no `.kata/tasks/<id>/` — the records live in the checkout
    // that owns it — so nothing inside the worktree can name the task, and the owner has to come from the path shape.
    const linked = join(primary, '.kata', 'worktrees', 'wiki-task');
    await mkdir(join(linked, 'src'), { recursive: true });
    return { primary, linked };
}

async function exists(path: string): Promise<boolean> {
    try {
        await stat(path);
        return true;
    } catch {
        return false;
    }
}

describe('the Wiki closure follows its owner', () => {
    it('registers a candidate written through the worktree root under the owning checkout', async () => {
        const { primary, linked } = await fixture();

        await writeWikiRecord(linked, {
            id: candidateId,
            statement: 'a reading carries the fact it is about',
            scope: ['.llmwiki/concepts/an-observation-that-does-not-name-its-fact.md'],
            kind: 'llmwiki-summary',
            sourceRefs: ['.llmwiki/concepts/an-observation-that-does-not-name-its-fact.md'],
            sourceHashes: {},
            validationTaskId: 'wiki-task',
            provenance: 'distilled',
            evidenceIds: ['llmwiki-000000000000'],
            status: 'candidate',
            lastVerifiedAt: now,
            createdAt: now,
            updatedAt: now,
        });

        // One store, one owner: the record is where the primary checkout keeps it, and the worktree keeps no copy.
        expect(await exists(join(primary, '.kata', 'wiki', `${candidateId}.json`))).toBe(true);
        expect(await exists(join(linked, '.kata', 'wiki', `${candidateId}.json`))).toBe(false);
        expect(wikiDir(linked)).toBe(join(primary, '.kata', 'wiki'));
    });

    it('evaluates the closure as valid when asked from inside the linked worktree', async () => {
        const { primary, linked } = await fixture();
        await writeWikiRecord(linked, {
            id: candidateId,
            statement: 'a reading carries the fact it is about',
            scope: ['.llmwiki/concepts/an-observation-that-does-not-name-its-fact.md'],
            kind: 'llmwiki-summary',
            sourceRefs: ['.llmwiki/concepts/an-observation-that-does-not-name-its-fact.md'],
            sourceHashes: {},
            validationTaskId: 'wiki-task',
            provenance: 'distilled',
            evidenceIds: ['llmwiki-000000000000'],
            status: 'candidate',
            lastVerifiedAt: now,
            createdAt: now,
            updatedAt: now,
        });
        await writeWikiClosure(linked, 'wiki-task', {
            decision: 'captured',
            reason: 'a reading carries the fact it is about',
            candidateIds: [candidateId],
        });

        // The regression itself: this answered `candidate_missing` before the store followed its owner, and the closure is
        // recorded from the worktree because that is where the verifying command stands.
        expect(await evaluateWikiClosure(linked, 'wiki-task')).toMatchObject({ valid: true, decision: 'captured' });
        // And the primary checkout gives the same answer, because it is the same store.
        expect(await evaluateWikiClosure(primary, 'wiki-task')).toMatchObject({ valid: true, decision: 'captured' });
    });

    it('still fails closed for a candidate that was never registered', async () => {
        const { linked } = await fixture();
        await writeWikiClosure(linked, 'wiki-task', {
            decision: 'captured',
            reason: 'this change taught nothing durable',
            candidateIds: ['llmwiki-concepts-never-registered'],
        });

        // The repair must not become "accept whatever id was recorded": an unregistered id is a real gap.
        expect(await evaluateWikiClosure(linked, 'wiki-task')).toMatchObject({ valid: false, reason: 'candidate_missing' });
    });
});
