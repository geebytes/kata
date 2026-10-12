import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runLedgerCommand } from '../../src/cli/ledger.js';
import { defaultPolicy } from '../../src/kernel/policy.js';
import { writePolicy } from '../../src/store/ledger.js';
import { writeTaskRecord } from '../helpers/task-fixture.js';

/**
 * **One question, one answer — including in the decision.**
 *
 * An independent round measured the disagreement this file pins: `ledger status --cost` reported the claim `stale` while
 * `ledger decide --tier standard` (a flag that today can only raise the gate tier — R2-F1) reported `pass, reasons: []` for the same ledger, because the decision handed the kernel
 * the subject **as frozen** (`ledgerVerdict`: `subject: ledger.subject`) while the claim projection and the discovery
 * projection compared against the subject **as declared** (`subjectAsDeclared`). A reading that answered a question the
 * ledger no longer asks was therefore credited below the discovery floor, in the one direction a gate must never take.
 *
 * Two ways for the question to move are covered — a restated claim, and a plan that changed under the same claims — because
 * the disagreement was about the *question*, not about the restatement path. The control matters as much as the
 * assertions: with no drift the same reading must still be credited, or a guard that refuses everything would pass.
 */
const changeId = 'decision-asks';
let root = '';
let previousExitCode: number | string | null | undefined;
const chunks: string[] = [];

async function ledger(argv: string[]): Promise<Record<string, unknown>> {
    chunks.length = 0;
    process.exitCode = 0;
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
        chunks.push(String(chunk));
        return true;
    });
    try {
        await runLedgerCommand(argv, { root, changeId });
    } finally {
        spy.mockRestore();
    }
    const text = chunks.join('');
    const start = text.indexOf('{');
    return start < 0 ? {} : (JSON.parse(text.slice(start)) as Record<string, unknown>);
}

const reasonsOf = (result: Record<string, unknown>): string[] =>
    ((result.reasons ?? []) as Array<{ code: string }>).map((reason) => reason.code);

const claimReport = (result: Record<string, unknown>) =>
    ((result.report ?? {}) as { claims?: { bySupport?: Record<string, number>; derived?: Array<{ claimId: string; state: string }> } }).claims ?? {};

/** A ledger with one reading, taken against the question as it stood at the freeze and linked to the claim. */
async function ledgerWithOneReading(): Promise<void> {
    await ledger(['policy', '--init']);
    // **The tier this fixture decides at is policy data, not an operator flag.** These cases used `decide --tier standard`
    // to sit below the strict ceiling; since R2-F1 a named tier can only raise the gate, so the fixture declares the ceiling
    // it means instead. What these cases are about is the question, not the tier.
    await writePolicy(root, changeId, { ...defaultPolicy(), ledgerTierCeiling: 'standard' });
    await ledger(['plan']);
    await ledger(['claim', 'add', '--id', 'C1', '--statement', 'the export holds', '--risk-class', 'consistency', '--severity', 'major', '--depends-on', 'path:src/a.ts']);
    await ledger(['freeze']);

    const file = join(root, 'submission.json');
    await writeFile(file, `${JSON.stringify({
        claims: [{
            id: 'C1',
            statement: 'the export holds',
            riskClass: 'consistency',
            severity: 'major',
            dependsOn: ['path:src/a.ts'],
            evidenceIds: ['E1'],
            challengeIds: [],
            status: 'open',
            at: '',
            reopens: 0,
        }],
        evidence: [{
            id: 'E1',
            type: 'executable_falsifier',
            command: 'grep -q "holds = true" src/a.ts',
            mutation: { file: 'src/a.ts', find: 'holds = true', replace: 'holds = false' },
        }],
    }, null, 2)}\n`);
    await ledger(['evidence', 'add', '--file', file]);
    const verified = await ledger(['evidence', 'verify']);
    expect(verified.ok).toBe(true);
}

beforeEach(async () => {
    previousExitCode = process.exitCode;
    root = await mkdtemp(join(tmpdir(), 'kata-decision-asks-'));
    await mkdir(join(root, 'src'), { recursive: true });
    await mkdir(join(root, '.kata', 'tasks', changeId), { recursive: true });
    await writeFile(join(root, 'src', 'a.ts'), 'export const holds = true;\n');
    await writeTaskRecord(root, { id: changeId, phase: 'implement', ownedPaths: ['src/a.ts'] });
});

afterEach(async () => {
    process.exitCode = previousExitCode;
    await rm(root, { recursive: true, force: true });
    vi.restoreAllMocks();
});

describe('the decision asks the question the ledger declares', () => {
    it('credits the reading while the question has not moved', async () => {
        // The control: the state is reachable, so the cases below are about the question and not about a ledger that
        // cannot pass for some other reason.
        await ledgerWithOneReading();

        const decision = await ledger(['decide']);

        expect(decision.verdict, JSON.stringify(decision)).toBe('pass');
        expect(reasonsOf(decision)).not.toContain('evidence_stale_subject');
    });

    it('does not credit it after a restated claim, where the report already calls it stale', async () => {
        await ledgerWithOneReading();

        // The question moves without the content moving.
        await ledger(['claim', 'restate', '--id', 'C1', '--statement', 'the export holds, restated']);

        const report = claimReport(await ledger(['status', '--cost']));
        expect(report.bySupport?.stale).toBe(1);
        expect(report.derived?.find((entry) => entry.claimId === 'C1')?.state).toBe('stale');

        const decision = await ledger(['decide']);
        expect(decision.verdict).not.toBe('pass');
        expect(reasonsOf(decision)).toContain('evidence_stale_subject');
    });

    it('does not credit it after the plan moved under the same claims', async () => {
        // The same class through the other half of the question: the plan is hashed into the subject, so a re-plan after
        // the content changed moves the question while the claims say exactly what they said before.
        await ledgerWithOneReading();
        await writeFile(join(root, 'src', 'a.ts'), 'export const holds = true;\nexport const extra = 1;\n');
        await ledger(['plan']);

        const report = claimReport(await ledger(['status', '--cost']));
        expect(report.bySupport?.stale).toBe(1);

        const decision = await ledger(['decide']);
        expect(decision.verdict).not.toBe('pass');
        expect(reasonsOf(decision)).toContain('evidence_stale_subject');
    });
});
