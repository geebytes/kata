import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runLedgerCommand } from '../../src/cli/ledger.js';
import { authorizeRepair, ledgerDeficitRepairAdmission } from '../../src/workflow/repair-entry.js';

const taskId = 'ledger-repair-boundary';
const roots: string[] = [];

afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tempRoot(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'kata-ledger-repair-boundary-'));
    roots.push(root);
    await mkdir(join(root, '.kata', 'tasks', taskId), { recursive: true });
    return root;
}

async function ledger(root: string, argv: string[]): Promise<void> {
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
        await runLedgerCommand(argv, { root, changeId: taskId });
    } finally {
        spy.mockRestore();
    }
}

async function seedDecidedLedger(root: string, leaveChallengeOpen: boolean): Promise<void> {
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src', 'subject.ts'), 'export const holds = true;\n');
    await writeFile(join(root, '.kata', 'tasks', taskId, 'task.json'), JSON.stringify({
        id: taskId,
        ownedPaths: ['src/subject.ts'],
    }));
    await ledger(root, ['policy', '--init']);
    await ledger(root, ['freeze']);

    for (const [index, riskClass] of ['consistency', 'boundary', 'failure_mode'].entries()) {
        const claimId = `C${index + 1}`;
        const evidenceId = `E${index + 1}`;
        await ledger(root, ['claim', 'add', '--statement', `${riskClass} holds`, '--risk-class', riskClass,
            '--severity', 'major', '--evidence', evidenceId, '--depends-on', 'path:src/subject.ts', '--id', claimId]);
        const submission = join(root, `${evidenceId}.json`);
        await writeFile(submission, JSON.stringify({
            claims: [],
            evidence: [{ id: evidenceId, type: 'static_witness', ref: 'src/subject.ts', assertion: 'contains:holds' }],
        }));
        await ledger(root, ['evidence', 'add', '--file', submission]);
    }
    await ledger(root, ['evidence', 'verify']);

    await mkdir(join(root, 'notes'), { recursive: true });
    const discovery = join(root, 'notes', 'discovery.txt');
    await writeFile(discovery, 'unresolved\n');
    await ledger(root, ['challenge', 'add', '--claim', 'C1', '--command', 'grep -q marked notes/discovery.txt', '--id', 'X1']);
    await ledger(root, ['challenge', 'check']);
    if (!leaveChallengeOpen) {
        await writeFile(discovery, 'marked\n');
        await ledger(root, ['challenge', 'check']);
    }
}

describe('ledger-deficit repair admission boundary', () => {
    it('denies absent and unreadable ledger states', async () => {
        const absentRoot = await tempRoot();
        expect(await ledgerDeficitRepairAdmission(absentRoot, taskId, 'review')).toMatchObject({
            authorized: false,
            entryPhase: 'review',
            denial: expect.stringMatching(/no ledger/i),
        });

        const unreadableRoot = await tempRoot();
        await mkdir(join(unreadableRoot, '.kata', 'tasks', taskId, 'review'), { recursive: true });
        await writeFile(join(unreadableRoot, '.kata', 'tasks', taskId, 'review', 'claims.json'), '{not-json');
        expect(await ledgerDeficitRepairAdmission(unreadableRoot, taskId, 'review')).toMatchObject({
            authorized: false,
            denial: expect.stringMatching(/cannot be read/i),
        });
    });

    it('authorizes only an actual decided non-pass ledger', async () => {
        const passRoot = await tempRoot();
        await seedDecidedLedger(passRoot, false);
        expect(await ledgerDeficitRepairAdmission(passRoot, taskId, 'judge')).toMatchObject({
            authorized: false,
            denial: expect.stringMatching(/passes/i),
        });

        const deficitRoot = await tempRoot();
        await seedDecidedLedger(deficitRoot, true);
        expect(await ledgerDeficitRepairAdmission(deficitRoot, taskId, 'judge')).toMatchObject({
            authorized: true,
            repair: { fromPhase: 'judge', reason: 'ledger_deficits' },
        });
    });

    it('names the ledger when the ledger is the unreadable record, not the review', async () => {
        const root = await tempRoot();
        await seedDecidedLedger(root, false);
        const reviewDir = join(root, '.kata', 'tasks', taskId, 'review');
        await mkdir(reviewDir, { recursive: true });
        await writeFile(join(reviewDir, 'review.json'), JSON.stringify({
            version: 1,
            taskId,
            status: 'pending',
            findings: [],
        }));
        await writeFile(join(reviewDir, 'claims.json'), '{not-json');

        const authorization = await authorizeRepair('review', root, taskId);

        expect(authorization.authorized).toBe(false);
        expect(authorization.denial).toMatch(/the evidence ledger cannot be read/i);
        expect(authorization.denial).not.toMatch(/the recorded review cannot be read/i);
    });
});
