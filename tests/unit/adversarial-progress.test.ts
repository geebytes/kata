import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initLayout } from '../../src/core/layout.js';
import { createTask } from '../../src/core/task.js';
import { appendProgressLine, progressSummary } from '../../src/quality/adversarial-progress.js';
import { addAdversarialFinding, adversarialGateFor, readAdversarialRecord, writeAdversarialRecord } from '../../src/quality/adversarial.js';

/**
 * A pass is not all-or-nothing (K1/K2/K3).
 *
 * The proposal recorded a pass that vanished mid-run: no error, nothing written, and the only mitigation was telling the
 * reviewer to save early. The seal already had a heartbeat for exactly this reason; a pass had a single write point at the
 * end. These tests are the crash reproduction, expressed as what must survive it.
 */
describe('a pass leaves recoverable work when it dies', () => {
    const roots: string[] = [];
    afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

    async function workspace(): Promise<string> {
        const root = await mkdtemp(join(tmpdir(), 'kata-progress-'));
        roots.push(root);
        await initLayout(root);
        await createTask({ root, id: 'k-task', title: 'K', acceptance: [{ id: 'AC-1', statement: 'x' }] });
        return root;
    }

    it('K1: the heartbeat holds what the pass had established', async () => {
        const root = await workspace();
        await appendProgressLine(root, 'k-task', {
            type: 'attempt',
            at: '2026-09-18T12:00:00.000Z',
            node: 'verify',
            hypothesis: 'the guard is not reached',
            method: 'deleted the check, ran the focused test',
            outcome: 'confirmed',
        });

        // The pass dies here: no record, no verdict. The work is still on disk and readable from outside.
        const summary = await progressSummary(root, 'k-task');
        expect(summary.lines).toBe(1);
        expect(summary.last).toMatchObject({ node: 'verify', outcome: 'confirmed', hypothesis: 'the guard is not reached' });

        const raw = await readFile(join(root, '.kata/tasks/k-task/adversarial-progress.jsonl'), 'utf8');
        expect(raw.trim().split('\n')).toHaveLength(1);
    });

    it('K1: a torn last line is a crash, not a failure to read', async () => {
        const root = await workspace();
        await appendProgressLine(root, 'k-task', { type: 'attempt', at: '2026-09-18T12:00:00.000Z', node: 'verify', hypothesis: 'a' });
        const path = join(root, '.kata/tasks/k-task/adversarial-progress.jsonl');
        // A process killed mid-append leaves a partial line; the lines before it must still be readable.
        await writeFile(path, `${await readFile(path, 'utf8')}{"type":"attempt","at":"2026-09`, 'utf8');

        const summary = await progressSummary(root, 'k-task');
        expect(summary.lines).toBe(1);
        expect(summary.last?.hypothesis).toBe('a');
    });

    it('K2: findings land as they are confirmed, and a partial pass is never mistaken for a verdict', async () => {
        const root = await workspace();
        const finding = await addAdversarialFinding(root, 'k-task', 'verify', {
            severity: 'major',
            message: 'the second instance of the merged-stream defect',
            path: 'src/a.ts',
        });

        const record = await readAdversarialRecord(root, 'k-task', 'verify');
        expect(record?.findings?.map((entry) => entry.id)).toEqual([finding.id]);
        // No verdict was sealed, so the gate refuses: partial must never read as passed.
        await expect(adversarialGateFor(root, 'k-task', 'verify')).resolves.toMatchObject({ satisfied: false });
    });

    it('K2: record seals the verdict and keeps the findings that arrived one at a time', async () => {
        const root = await workspace();
        const first = await addAdversarialFinding(root, 'k-task', 'verify', { severity: 'minor', message: 'one' });
        const second = await addAdversarialFinding(root, 'k-task', 'verify', { severity: 'nit', message: 'two' });
        const partial = await readAdversarialRecord(root, 'k-task', 'verify');

        await writeAdversarialRecord(root, 'k-task', {
            ...partial!,
            attempts: [{ hypothesis: 'x', method: 'y', outcome: 'refuted' }],
            verdict: 'defects_found',
            findings: [...(partial!.findings ?? [])],
        });

        const sealed = await readAdversarialRecord(root, 'k-task', 'verify');
        expect(sealed?.verdict).toBe('defects_found');
        expect(sealed?.findings?.map((entry) => entry.id).sort()).toEqual([first.id, second.id].sort());
    });

    it('K3: the brief is reproducible, which is what makes a partial pass resumable', async () => {
        const root = await workspace();
        const { buildAdversarialBrief } = await import('../../src/quality/adversarial.js');

        const before = await buildAdversarialBrief(root, 'k-task', 'verify');
        // A partial pass writes findings and a heartbeat, but no verdict.
        await addAdversarialFinding(root, 'k-task', 'verify', { severity: 'minor', message: 'partial work' });
        await appendProgressLine(root, 'k-task', { type: 'attempt', at: '2026-09-18T12:00:00.000Z', node: 'verify', hypothesis: 'a' });

        const after = await buildAdversarialBrief(root, 'k-task', 'verify');
        // The retry renders the same brief, so it can continue rather than re-derive fifteen minutes of work.
        expect(after.sha256).toBe(before.sha256);
    });
});

describe('the default framing rotates, and stops rotating at an unrepaired blocker (M2)', () => {
    const roots: string[] = [];
    afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

    async function workspace(): Promise<string> {
        const root = await mkdtemp(join(tmpdir(), 'kata-mode-'));
        roots.push(root);
        await initLayout(root);
        await createTask({ root, id: 'm-task', title: 'M', acceptance: [{ id: 'AC-1', statement: 'x' }] });
        return root;
    }

    it('opens cold on a task with no pass yet, then alternates', async () => {
        const root = await workspace();
        const { resolveBriefMode, writeAdversarialRecord } = await import('../../src/quality/adversarial.js');

        expect(await resolveBriefMode(root, 'm-task', 'verify')).toMatchObject({ mode: 'cold' });

        const base = {
            node: 'verify' as const,
            status: 'recorded' as const,
            revisionId: 'revision-1',
            createdAt: '2026-09-18T10:00:00.000Z',
            executedInFreshContext: true,
            scope: { kind: 'full' as const },
            attempts: [{ hypothesis: 'x', method: 'y', outcome: 'refuted' as const }],
            findings: [],
        };
        await writeAdversarialRecord(root, 'm-task', { ...base, mode: 'cold' });
        expect(await resolveBriefMode(root, 'm-task', 'verify')).toMatchObject({ mode: 'verify' });

        await writeAdversarialRecord(root, 'm-task', { ...base, mode: 'verify', createdAt: '2026-09-18T11:00:00.000Z' });
        expect(await resolveBriefMode(root, 'm-task', 'verify')).toMatchObject({ mode: 'cold' });
    });

    it('refuses to rotate into cold while a blocking or major finding is unrepaired', async () => {
        const root = await workspace();
        const { resolveBriefMode, writeAdversarialRecord } = await import('../../src/quality/adversarial.js');
        await writeAdversarialRecord(root, 'm-task', {
            node: 'verify',
            status: 'recorded',
            revisionId: 'revision-1',
            createdAt: '2026-09-18T10:00:00.000Z',
            executedInFreshContext: true,
            scope: { kind: 'full' },
            attempts: [{ hypothesis: 'x', method: 'y', outcome: 'confirmed' }],
            mode: 'cold',
            verdict: 'defects_found',
            findings: [{ id: 'blocker', taskId: 'm-task', severity: 'major', message: 'must be repaired' }],
        });

        const resolved = await resolveBriefMode(root, 'm-task', 'verify');
        expect(resolved.mode).toBe('verify');
        expect(resolved.reason).toMatch(/open major finding \(blocker\) is unrepaired/);
    });

    it('honours an explicit --mode over the rotation', async () => {
        const root = await workspace();
        const { resolveBriefMode } = await import('../../src/quality/adversarial.js');
        expect(await resolveBriefMode(root, 'm-task', 'verify', 'verify')).toMatchObject({ mode: 'verify', reason: expect.stringContaining('requested explicitly') });
    });
});

describe('§18.7: a costly attempt is visible while the round runs', () => {
    const roots: string[] = [];
    afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

    it('records tool uses on the heartbeat line, not only on the pass total', async () => {
        const root = await mkdtemp(join(tmpdir(), 'kata-per-attempt-'));
        roots.push(root);
        await initLayout(root);
        await createTask({ root, id: 'cost-task', title: 'C', acceptance: [{ id: 'AC-1', statement: 'x' }] });

        await appendProgressLine(root, 'cost-task', {
            type: 'attempt',
            at: '2026-09-19T00:00:00.000Z',
            node: 'verify',
            hypothesis: 'the second instance of the merged-stream defect',
            method: 'grep for the sentinel across the partition boundary',
            outcome: 'confirmed',
            toolUses: 17,
        });

        const summary = await progressSummary(root, 'cost-task');
        // The pass total says a round was expensive; this says which of its batches was — and it is readable mid-round.
        expect(summary.last).toMatchObject({ toolUses: 17, hypothesis: 'the second instance of the merged-stream defect' });
    });

    it('accepts an attempt with no count, and the recorded attempt schema allows one', async () => {
        const { validate } = await import('../../src/core/schema.js');
        // Optional on purpose: a reviewer that does not count is not blocked, it is merely less measurable.
        expect(() => validate('adversarial-review', {
            node: 'verify',
            status: 'recorded',
            revisionId: 'revision-1',
            createdAt: '2026-09-19T00:00:00.000Z',
            executedInFreshContext: true,
            attempts: [{ hypothesis: 'h', method: 'm', outcome: 'refuted', toolUses: 4 }],
            findings: [],
        })).not.toThrow();
        expect(() => validate('adversarial-review', {
            node: 'verify',
            status: 'recorded',
            revisionId: 'revision-1',
            createdAt: '2026-09-19T00:00:00.000Z',
            executedInFreshContext: true,
            attempts: [{ hypothesis: 'h', method: 'm', outcome: 'refuted' }],
            findings: [],
        })).not.toThrow();
    });
});
