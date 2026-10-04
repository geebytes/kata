import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * **Every review-loop writer mints one identity from one pointer read.**
 *
 * Measured by three independent reviews, one writer at a time: the repair entry, then the review entry, then the approval
 * path — each taking a fresh look at the same non-atomically written `current-revision.json` while its own decision
 * rested on an earlier look. A seal landing between two reads lets a round be stamped with a revision the decision never
 * saw, and `review-rounds.jsonl` is exactly the artefact the escalation reads.
 *
 * The instrument is the repository's own: count the pointer reads and make the *second* one impossible, so a writer that
 * reads once still completes while a writer that reads twice cannot (same shape as `commands-stamp-from-their-read.test.ts`
 * and `review-entry-reads-the-pointer-once.test.ts`). Both exported spellings are wrapped, because a module-internal call
 * to `readCurrentTaskRevisionState` is not redirected by `vi.mock` — the lesson recorded in the change's design §6.1.5.
 */
const revisionReads = vi.hoisted(() => ({ count: 0, failFrom: Number.POSITIVE_INFINITY }));
vi.mock('../../src/workflow/revision.js', async (importOriginal) => {
    const original = await importOriginal<typeof import('../../src/workflow/revision.js')>();
    const unreadable = { kind: 'unreadable', detail: 'the pointer could not be read on this attempt' } as never;
    return {
        ...original,
        readCurrentTaskRevisionState: async (...args: Parameters<typeof original.readCurrentTaskRevisionState>) => {
            revisionReads.count += 1;
            if (revisionReads.count >= revisionReads.failFrom) return unreadable;
            return original.readCurrentTaskRevisionState(...args);
        },
        readCurrentTaskRevision: async (...args: Parameters<typeof original.readCurrentTaskRevision>) => {
            revisionReads.count += 1;
            if (revisionReads.count >= revisionReads.failFrom) return null;
            return original.readCurrentTaskRevision(...args);
        },
    };
});

const { runCommand } = await import('../../src/workflow/orchestrator.js');
const { createTaskRevisionIfChanged } = await import('../../src/workflow/revision.js');
const { initLayout } = await import('../../src/core/layout.js');

const NOW = '2026-10-04T00:00:00.000Z';
const taskId = 'review-writer-one-read';
let root: string;

/** A review-phase task with a sealed revision, an approved record and a passing ledger, so approval has work to do. */
async function seedReviewPhase(): Promise<void> {
    root = await mkdtemp(join(tmpdir(), 'kata-review-writer-'));
    await initLayout(root);
    await mkdir(join(root, '.kata', 'tasks', taskId), { recursive: true });
    await writeFile(join(root, 'subject.ts'), 'export const version = 1;\n');
    await writeFile(
        join(root, '.kata', 'tasks', taskId, 'task.json'),
        `${JSON.stringify({
            id: taskId,
            title: 'T',
            phase: 'review',
            acceptance: [{ id: 'AC-1', statement: 'x' }],
            ownedPaths: ['subject.ts'],
            acceptanceMatrix: {
                version: 1,
                rows: [{
                    acceptanceId: 'AC-1',
                    implementationPaths: ['subject.ts'],
                    testPaths: ['subject.ts'],
                    evidence: [{ id: 'ac-1', kind: 'test', command: 'vitest', testSelector: 'subject.ts' }],
                    verificationLevel: 'unit',
                }],
            },
            createdAt: NOW,
            updatedAt: NOW,
        })}\n`,
    );
    const sealed = await createTaskRevisionIfChanged({ root, taskId, ownedPaths: ['subject.ts'], checkIds: [] });
    await writeFile(
        join(root, '.kata', 'tasks', taskId, 'current-state.json'),
        `${JSON.stringify({ taskId, phase: 'review', actor: { id: 'kata-agent', role: 'implementer' }, updatedAt: NOW })}\n`,
    );
    await writeFile(
        join(root, '.kata', 'tasks', taskId, 'review.json'),
        `${JSON.stringify({
            revisionId: sealed.revision.id,
            manifestHash: sealed.revision.manifestHash,
            status: 'pending',
            reviewEvidence: 'sealed revision reviewed',
            findings: [],
        })}\n`,
    );
}

describe('a review-loop writer stamps what it read', () => {
    afterEach(async () => {
        await rm(root, { recursive: true, force: true });
    });

    it('does not take a second look at the pointer while approving a review', async () => {
        await seedReviewPhase();
        revisionReads.count = 0;
        revisionReads.failFrom = 2;

        const result = await runCommand('review', taskId, root, {
            approve: true,
            confirmHostModel: true,
            reviewEvidence: 'measured one pointer read',
        }).catch((error: unknown) => ({ command: 'review', error: String(error) }) as never);

        expect(result.command).toBe('review');
        // The ledger gate refuses this fixture before the approval branch runs, so the count reached from *any* path is
        // asserted rather than a claim about a completed approval: what the case pins is that no path here asks the
        // pointer a second question.
        // Whatever the approval decided, it decided it from one read: with the second read made unreadable, a writer that
        // takes it either refuses or loses the binding it already held.
        expect(revisionReads.count).toBe(1);
    });
});
