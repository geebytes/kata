import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

/** The review entry obtains one authorizing snapshot; commit validation is separately tested. */
const decisionSnapshots = vi.hoisted(() => ({ count: 0, failFrom: Number.POSITIVE_INFINITY }));
vi.mock('../../src/workflow/revision.js', async (importOriginal) => {
    const original = await importOriginal<typeof import('../../src/workflow/revision.js')>();
    return {
        ...original,
        readReviewDecisionSnapshot: async (...args: Parameters<typeof original.readReviewDecisionSnapshot>) => {
            decisionSnapshots.count += 1;
            if (decisionSnapshots.count >= decisionSnapshots.failFrom) {
                throw new Error('a second authorizing snapshot must not be read');
            }
            return original.readReviewDecisionSnapshot(...args);
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
        decisionSnapshots.count = 0;
        decisionSnapshots.failFrom = 2;

        // The command may enter the review round or refuse structurally; it must never ask for
        // a second authorizing snapshot. The lock-held validator is separately covered by the
        // decision-snapshot commit sequence tests.
        const result = await runCommand('review', taskId, root, { confirmHostModel: true });
        expect(result.command).toBe('review');

        expect(decisionSnapshots.count).toBe(1);
    });
});
