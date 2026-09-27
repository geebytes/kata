import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { initLayout } from '../../src/core/layout.js';
import { createTask } from '../../src/core/task.js';
import { appendClaim, writePolicy } from '../../src/store/ledger.js';
import { defaultPolicy } from '../../src/kernel/policy.js';
import { buildBaseline } from '../../src/store/baseline.js';

/**
 * **The change-level baseline six acceptance items were waiting for, and the two things it must not pretend.**
 *
 * It reads records already on disk: an archived change's `adversarial-review.json` (self-reported `usage`) and a
 * ledger-route change's `round-runs.json` (counted by kata from the stream it read). A comparison between those two is a
 * comparison of different kinds of evidence, so the report names the basis of each rather than leaving it implied — and
 * the cases below pin the things that would make the number a lie: a mean over an empty population, a change silently
 * dropped from the corpus, and a self-reported figure presented as measured.
 */
describe('the change-level baseline reports both routes and names each one\'s basis', () => {
    async function scratch(): Promise<{ root: string; cleanup: () => Promise<void> }> {
        const root = await mkdtemp(join(tmpdir(), 'kata-baseline-'));
        await initLayout(root);
        return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
    }

    async function withRetiredRecord(root: string, id: string, tokens: number, findings: number): Promise<void> {
        await createTask({ root, id, title: id, acceptance: [{ id: 'AC-1', statement: 'x' }] });
        const dir = join(root, '.kata/tasks', id);
        await writeFile(join(dir, 'adversarial-review.json'), `${JSON.stringify({
            status: 'recorded',
            usage: { total_tokens: tokens, tool_uses: 40, duration_ms: 1_080_000 },
            findings: Array.from({ length: findings }, (_, index) => ({ id: `f-${index}` })),
        }, null, 2)}\n`, 'utf8');
        await writeFile(join(dir, 'change-record-revision-aaa.json'), '{}\n', 'utf8');
        await writeFile(join(dir, 'change-record-revision-bbb.json'), '{}\n', 'utf8');
    }

    it('reports a retired change\'s self-reported cost and a ledger change\'s measured runs', async () => {
        const { root, cleanup } = await scratch();
        try {
            await withRetiredRecord(root, 'retired-change', 500_000, 7);

            await createTask({ root, id: 'ledger-change', title: 'L', acceptance: [{ id: 'AC-1', statement: 'x' }] });
            await writePolicy(root, 'ledger-change', defaultPolicy());
            await appendClaim(root, 'ledger-change', {
                id: 'C1',
                statement: 'x',
                riskClass: 'consistency',
                severity: 'major',
                dependsOn: [],
                evidenceIds: [],
                challengeIds: [],
                status: 'open',
                at: '2026-09-27T00:00:00.000Z',
                reopens: 0,
            });
            await writeFile(join(root, '.kata/tasks/ledger-change/round-runs.json'), `${JSON.stringify({
                version: 1,
                runs: [{
                    runId: 'r1',
                    status: 'completed',
                    startedAt: '2026-09-27T00:00:00.000Z',
                    endedAt: '2026-09-27T00:10:00.000Z',
                    toolCalls: 12,
                    outputBytes: 4096,
                    tokens: 1234,
                }],
            }, null, 2)}\n`, 'utf8');

            const report = await buildBaseline(root);
            const retired = report.retired.find((entry) => entry.changeId === 'retired-change');
            expect(retired).toMatchObject({ passes: 1, reportedTokens: 500_000, findings: 7, revisions: 2 });
            expect(retired?.tokensUnreported).toBe(false);

            const ledger = report.ledgerRoute.find((entry) => entry.changeId === 'ledger-change');
            expect(ledger).toMatchObject({ claims: 1, runs: 1, measuredToolCalls: 12, measuredOutputBytes: 4096, measuredTokens: 1234 });

            // Both bases are stated, so a reader cannot take the two figures as interchangeable.
            expect(report.evidenceBasis.retired).toContain('self-reported');
            expect(report.evidenceBasis.ledgerRoute).toContain('measured by kata');
            expect(report.measures).toContain('does not measure whether a reviewer found');
        } finally {
            await cleanup();
        }
    });

    it('flags a pass that reported no tokens, because the sum then understates the real cost', async () => {
        const { root, cleanup } = await scratch();
        try {
            await withRetiredRecord(root, 'silent-pass', 0, 3);
            const report = await buildBaseline(root);
            expect(report.retired[0]).toMatchObject({ reportedTokens: 0, tokensUnreported: true });
            // A mean nobody can compute is null rather than zero: `0` would read as "free".
            expect(report.c0.meanReportedTokens).toBeNull();
            expect(report.c0.changes).toBe(1);
        } finally {
            await cleanup();
        }
    });

    it('names a change with neither route\'s records instead of dropping it from the population', async () => {
        const { root, cleanup } = await scratch();
        try {
            await createTask({ root, id: 'bare-change', title: 'B', acceptance: [{ id: 'AC-1', statement: 'x' }] });
            const report = await buildBaseline(root);
            expect(report.unmeasured).toEqual(['bare-change']);
            expect(report.c0.meanReportedTokens).toBeNull();
        } finally {
            await cleanup();
        }
    });

    it('counts a replaced pass as a pass, because the round count is what the cost was paid for', async () => {
        const { root, cleanup } = await scratch();
        try {
            await withRetiredRecord(root, 'many-rounds', 100_000, 2);
            const dir = join(root, '.kata/tasks/many-rounds');
            await writeFile(join(dir, 'adversarial-review-history.json'), `${JSON.stringify([
                { usage: { total_tokens: 100_000 }, findings: [{}] },
                { usage: { total_tokens: 100_000 }, findings: [{}, {}] },
            ], null, 2)}\n`, 'utf8');
            const report = await buildBaseline(root);
            expect(report.retired[0]).toMatchObject({ passes: 3, reportedTokens: 300_000, findings: 5 });
        } finally {
            await cleanup();
        }
    });
});
