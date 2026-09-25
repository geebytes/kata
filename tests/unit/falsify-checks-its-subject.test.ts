import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initLayout } from '../../src/core/layout.js';
import { createTask } from '../../src/core/task.js';
import { runFalsifyCommand } from '../../src/cli/ops.js';
import { writeAdversarialRecord } from '../../src/quality/adversarial.js';
import { readFile } from 'node:fs/promises';

/** The ledger's absences, read from the artefact the producer wrote — `readFalsifierReddenings` exposes only the reddenings. */
async function absencesOf(root: string): Promise<string[]> {
    const raw = await readFile(join(root, '.kata/tasks/subject-task/falsifier-reddenings.json'), 'utf8').catch(() => '{}');
    return (JSON.parse(raw).absences ?? []).map((entry: { findingId?: string }) => entry.findingId ?? '');
}

/**
 * **A disposition's subject must be a finding that exists.**
 *
 * Measured before this guard: four absences were recorded on this repository under *short* ids — `kgsr14-f1`, which is how a listing
 * renders a finding — while the task's records hold `kgsr14-f1-the-seal-writes-its-record-…`. `falsify` accepted all four, the ledger
 * stored them, and the seal kept refusing the same four findings as *"awaiting a falsifier or a recorded absence"* for work that had been
 * done. With the full ids they bound immediately and the seal went through first try.
 *
 * The command validates every refusal it can *measure* — a check that did not pass, a defect that did not redden, a tree that did not come
 * back — and took its **subject** on trust. A writer whose key is never checked against its reader's vocabulary is the class this line
 * spent a day removing, and this is that class inside the command written to record dispositions.
 */
describe('falsify refuses a finding id no finding carries', () => {
    const roots: string[] = [];
    afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

    async function workspaceWithAFinding(): Promise<string> {
        const root = await mkdtemp(join(tmpdir(), 'kata-falsify-subject-'));
        roots.push(root);
        await initLayout(root);
        await createTask({
            root,
            id: 'subject-task',
            title: 'S',
            ownedPaths: ['src/x.ts'],
            acceptance: [{ id: 'AC-1', statement: 'x' }],
        } as never);
        await writeAdversarialRecord(root, 'subject-task', {
            node: 'review',
            status: 'recorded',
            revisionId: 'revision-one',
            createdAt: '2026-09-25T10:00:00.000Z',
            hypotheses: [],
            attempts: [],
            findings: [
                {
                    id: 'the-real-finding',
                    taskId: 'subject-task',
                    severity: 'major',
                    message: 'a finding whose id is longer than the prefix a listing shows',
                    path: 'src/x.ts',
                },
            ],
        } as never);
        return root;
    }

    it('refuses a prefix of a real id, and names the id the records hold', async () => {
        const root = await workspaceWithAFinding();
        const cwd = process.cwd();
        process.chdir(root);
        try {
            const result = await runFalsifyCommand([
                '--change', 'subject-task', '--finding', 'the-real', '--none', '--reason', 'a reason that would have been recorded',
            ]);
            expect(result.success, 'a disposition against a finding that does not exist must not be recorded').toBe(false);
            expect(String(result.error)).toContain('the-real-finding');
            expect(await absencesOf(root), 'nothing was written').toEqual([]);
        } finally {
            process.chdir(cwd);
        }
    });

    it('records the disposition when the id is the one the records hold', async () => {
        const root = await workspaceWithAFinding();
        const cwd = process.cwd();
        process.chdir(root);
        try {
            const result = await runFalsifyCommand([
                '--change', 'subject-task', '--finding', 'the-real-finding', '--none', '--reason', 'the declaration was corrected and no check can redden for it',
            ]);
            expect(result.success).toBe(true);
            expect(await absencesOf(root)).toEqual(['the-real-finding']);
        } finally {
            process.chdir(cwd);
        }
    });
});
