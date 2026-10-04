import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * **The review entry mints one identity from one pointer read.**
 *
 * Measured by an independent review of `review-loop-verdict-unification`: `orchestrator.ts` called
 * `currentRevisionIdentity(root, taskId)` twice inside one `review` entry — once to stamp the placeholder record and
 * again to decide whether the previous record must be archived. The pointer is written non-atomically, so a seal landing
 * between the two reads lets the stamp and the decision rest on different revisions. This is the same invariant the
 * review-repair round writer carries (`repair-entry.ts`), asserted with the same counting mock the verify/judge writers
 * use (`commands-stamp-from-their-read.test.ts`): the second read is made impossible, so an entry that takes one still
 * completes while an entry that takes two cannot.
 */
const revisionReads = vi.hoisted(() => ({ count: 0, failFrom: Number.POSITIVE_INFINITY }));
vi.mock('../../src/workflow/revision.js', async (importOriginal) => {
    const original = await importOriginal<typeof import('../../src/workflow/revision.js')>();
    return {
        ...original,
        // **Both exported spellings, because a module-internal call is not redirected.** `vi.mock` replaces a module's
        // exports for its *importers* while a module internal call to its own function is untouched, so a mock of one
        // spelling counts nothing when the entry calls the other — the lesson the change's design §6.1.5 records, and
        // this file was the third witness to miss it (an independent review measured that).
        readCurrentTaskRevisionState: async (...args: Parameters<typeof original.readCurrentTaskRevisionState>) => {
            revisionReads.count += 1;
            if (revisionReads.count >= revisionReads.failFrom) {
                return { kind: 'unreadable', detail: 'the pointer could not be read on this attempt' } as never;
            }
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
const taskId = 'review-entry-one-read';
let root: string;

describe('a review entry mints one identity from one pointer read', () => {
    afterEach(async () => {
        await rm(root, { recursive: true, force: true });
    });

    it('answers the entry and the archive decision from the same read', async () => {
        root = await mkdtemp(join(tmpdir(), 'kata-review-entry-read-'));
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
                status: 'approved',
                reviewEvidence: 'reviewed',
                findings: [],
            })}\n`,
        );
        revisionReads.count = 0;
        revisionReads.failFrom = 2;

        // The command either enters the review round or refuses structurally; what it must not do is take a second look
        // at the pointer, which this instrument turns into an unreadable artefact.
        const result = await runCommand('review', taskId, root, { confirmHostModel: true });
        expect(result.command).toBe('review');

        expect(revisionReads.count).toBe(1);
    });
});
