import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * **The commands stamp their verdict from the read they already took.**
 *
 * This is the case the previous round was missing. `verify` and `judge` were fixed to refuse structurally when the
 * revision artefact cannot be read, and then to derive the identity from *their own* read — but the only case asserted
 * was a reader-level one that called the helper directly, so a mutation that put the independent re-read back left the
 * whole suite green. Measured: deleting `revisionRead: judgeRevisionRead` on the judge path and restoring
 * `currentRevisionIdentity(root, taskId)` on the verify path both passed 1113 cases.
 *
 * The pointer is written non-atomically, so "read it twice" is not a guard: the second read can answer differently from
 * the first, and the command then throws **after** doing all its work and **before** writing its verdict — discarding the
 * run. So the assertion here is on what gets written, driven through the real command, with a reader that fails from the
 * second call onward.
 */
const revisionReads = vi.hoisted(() => ({ count: 0, failFrom: Number.POSITIVE_INFINITY }));
vi.mock('../../src/workflow/revision.js', async (importOriginal) => {
    const original = await importOriginal<typeof import('../../src/workflow/revision.js')>();
    return {
        ...original,
        readCurrentTaskRevisionState: async (...args: Parameters<typeof original.readCurrentTaskRevisionState>) => {
            revisionReads.count += 1;
            if (revisionReads.count >= revisionReads.failFrom) {
                return { kind: 'unreadable', detail: 'the pointer could not be read on this attempt' } as never;
            }
            return original.readCurrentTaskRevisionState(...args);
        },
    };
});

const { runCommand } = await import('../../src/workflow/orchestrator.js');
const { createTaskRevisionIfChanged } = await import('../../src/workflow/revision.js');

const NOW = '2026-09-29T00:00:00.000Z';
let root: string;
const taskId = 'stamps-from-its-read';

async function seed(phase: 'hardVerify' | 'review'): Promise<string> {
    root = await mkdtemp(join(tmpdir(), 'kata-stamp-'));
    await mkdir(join(root, '.kata', 'tasks', taskId), { recursive: true });
    await writeFile(join(root, 'subject.ts'), 'export const version = 1;\n');
    await writeFile(
        join(root, '.kata', 'tasks', taskId, 'task.json'),
        `${JSON.stringify({
            id: taskId, title: 'T', phase, acceptance: [{ id: 'AC-1', statement: 'x' }], ownedPaths: ['subject.ts'],
            acceptanceMatrix: { version: 1, rows: [{ acceptanceId: 'AC-1', implementationPaths: ['subject.ts'], testPaths: ['subject.ts'], evidence: [{ id: 'ac-1', kind: 'test', command: 'vitest', testSelector: 'subject.ts' }], verificationLevel: 'unit' }] },
            createdAt: NOW, updatedAt: NOW,
        })}\n`,
    );
    const sealed = await createTaskRevisionIfChanged({ root, taskId, ownedPaths: ['subject.ts'], checkIds: [] });
    await writeFile(
        join(root, '.kata', 'tasks', taskId, `current-state.json`),
        `${JSON.stringify({ taskId, phase, actor: { id: 'kata-agent', role: 'implementer' }, updatedAt: NOW })}\n`,
    );
    if (phase === 'review') {
        await writeFile(
            join(root, '.kata', 'tasks', taskId, 'review.json'),
            `${JSON.stringify({ revisionId: sealed.revision.id, manifestHash: sealed.revision.manifestHash, status: 'approved', reviewEvidence: 'reviewed', findings: [] })}\n`,
        );
    }
    return sealed.revision.id;
}

describe('a command stamps what it read, not what a later read would say', () => {
    afterEach(async () => {
        await rm(root, { recursive: true, force: true });
    });

    it('writes a verify verdict bound to the revision it read, even if a later read of the same file would fail', async () => {
        const sealedId = await seed('hardVerify');
        revisionReads.count = 0;
        revisionReads.failFrom = 2;

        const result = await runCommand('verify', taskId, root);
        // The command either concludes or refuses structurally; what it must not do is discard the run by throwing.
        expect(result.command).toBe('verify');

        const written = JSON.parse(await readFile(join(root, '.kata', 'tasks', taskId, 'verify.json'), 'utf8')) as { revisionId?: string };
        expect(written.revisionId).toBe(sealedId);
    });

    it('writes a judge verdict bound to the revision it read, even if a later read of the same file would fail', async () => {
        const sealedId = await seed('review');
        revisionReads.count = 0;
        revisionReads.failFrom = 2;

        const result = await runCommand('judge', taskId, root, { confirmHostModel: true });
        expect(result.command).toBe('judge');

        const written = JSON.parse(await readFile(join(root, '.kata', 'tasks', taskId, 'judge.json'), 'utf8')) as { revisionId?: string };
        expect(written.revisionId).toBe(sealedId);
    });
});