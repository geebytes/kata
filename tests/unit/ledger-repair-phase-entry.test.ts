import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runLedgerCommand } from '../../src/cli/ledger.js';
import { createTaskRevisionIfChanged } from '../../src/workflow/revision.js';
import { runCommand } from '../../src/workflow/orchestrator.js';
import { authorizeRepair } from '../../src/workflow/repair-entry.js';

const roots: string[] = [];

async function tempRoot(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'kata-ledger-phase-entry-'));
    roots.push(root);
    return root;
}

async function writeJson(root: string, relative: string, value: unknown): Promise<void> {
    const path = join(root, relative);
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function seedDecidedDeficit(root: string, taskId: string): Promise<void> {
    const ledger = async (argv: string[]): Promise<void> => {
        const spy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
        try {
            await runLedgerCommand(argv, { root, changeId: taskId });
        } finally {
            spy.mockRestore();
        }
    };
    await ledger(['policy', '--init']);
    await ledger(['freeze']);
    for (const [index, riskClass] of ['consistency', 'boundary', 'failure_mode'].entries()) {
        const claimId = `C${index + 1}`;
        const evidenceId = `E${index + 1}`;
        await ledger(['claim', 'add', '--statement', `${riskClass} holds`, '--risk-class', riskClass,
            '--severity', 'major', '--evidence', evidenceId, '--depends-on', 'path:src/subject.ts', '--id', claimId]);
        const submission = join(root, `${taskId}-${evidenceId}.json`);
        await writeFile(submission, JSON.stringify({
            claims: [],
            evidence: [{ id: evidenceId, type: 'static_witness', ref: 'src/subject.ts', assertion: 'contains:holds' }],
        }));
        await ledger(['evidence', 'add', '--file', submission]);
    }
    await ledger(['evidence', 'verify']);
    await mkdir(join(root, 'notes'), { recursive: true });
    await writeFile(join(root, 'notes', 'discovery.txt'), 'unresolved\n');
    await ledger(['challenge', 'add', '--claim', 'C1', '--command', 'grep -q marked notes/discovery.txt', '--id', 'X1']);
    await ledger(['challenge', 'check']);
}

async function seedGate(root: string, phase: 'hardVerify' | 'review' | 'judge'): Promise<{ taskId: string }> {
    const taskId = `ledger-${phase}`;
    await mkdir(join(root, '.kata', 'tasks', taskId), { recursive: true });
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src', 'subject.ts'), 'export const holds = true;\n');
    await writeJson(root, `.kata/tasks/${taskId}/task.json`, {
        id: taskId,
        title: `Ledger ${phase}`,
        phase,
        acceptance: [{ id: 'AC-1', statement: 'ledger repair entry' }],
        ownedPaths: ['src/subject.ts'],
        createdAt: '2026-10-04T00:00:00.000Z',
        updatedAt: '2026-10-04T00:00:00.000Z',
    });
    const sealed = await createTaskRevisionIfChanged({ root, taskId, ownedPaths: ['src/subject.ts'], checkIds: ['test'] });
    await writeJson(root, `.kata/tasks/${taskId}/current-state.json`, {
        taskId,
        phase,
        actor: { id: 'tester', role: 'reviewer' },
        updatedAt: '2026-10-04T00:00:00.000Z',
    });
    await writeJson(root, `.kata/tasks/${taskId}/verify.json`, {
        taskId,
        result: 'PASS',
        diffHash: 'd'.repeat(64),
        acceptance: [{ id: 'AC-1', result: 'PASS' }],
    });
    if (phase === 'review') {
        await writeJson(root, `.kata/tasks/${taskId}/review.json`, {
            revisionId: sealed.revision.id,
            status: 'pending',
            findings: [],
        });
    }
    if (phase === 'judge') {
        await writeJson(root, `.kata/tasks/${taskId}/judge.json`, {
            taskId,
            result: 'PASS',
            acceptance: [{ id: 'AC-1', result: 'PASS' }],
        });
    }
    await seedDecidedDeficit(root, taskId);
    return { taskId };
}

afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('all gate ledger-deficit repair entries', () => {
    it.each(['hardVerify', 'review', 'judge'] as const)(
        're-enters implementation through %s and records ledger_deficits',
        async (phase) => {
            const root = await tempRoot();
            const { taskId } = await seedGate(root, phase);


            const authorization = await authorizeRepair(phase, root, taskId);
            expect(authorization).toMatchObject({
                authorized: true,
                repair: { fromPhase: phase, reason: 'ledger_deficits' },
            });
            const result = await runCommand('build', taskId, root, { seal: false });
            const repair = JSON.parse(await readFile(join(root, '.kata', 'tasks', taskId, 'repair.json'), 'utf8')) as {
                fromPhase: string;
                reason: string;
            };

            expect(result).toMatchObject({ success: true, phase: 'implement' });
            expect(repair).toMatchObject({ fromPhase: phase, reason: 'ledger_deficits' });
        },
    );
});
