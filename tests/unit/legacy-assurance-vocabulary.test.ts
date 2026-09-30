import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensureAssurance, ledgerReport, readLedger, reviewDir } from '../../src/store/ledger.js';
import { initLayout } from '../../src/core/layout.js';
import { createTask } from '../../src/core/task.js';
import { defaultPolicy } from '../../src/kernel/policy.js';

let root: string;
const changeId = 'historical-assurance';

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'kata-legacy-assurance-'));
    await mkdir(reviewDir(root, changeId), { recursive: true });
});

afterEach(async () => {
    await rm(root, { recursive: true, force: true });
});

/**
 * Retiring a writer vocabulary cannot erase an audit fact. A historical sandboxed
 * record is reportable, while a current observed round cannot manufacture or rewrite it.
 */
describe('historical assurance vocabulary', () => {
    it('reads and preserves sandboxed assurance without classifying the ledger unreadable', async () => {
        const usagePath = join(reviewDir(root, changeId), 'usage.json');
        const historical = { usage: {}, assurance: 'sandboxed' };
        await writeFile(usagePath, `${JSON.stringify(historical)}\n`);
        const currentPolicy = defaultPolicy();
        const historicalPolicy = {
            ...currentPolicy,
            tiers: { ...currentPolicy.tiers, security: { ...currentPolicy.tiers.security, assuranceFloor: 'sandboxed' } },
        };
        await writeFile(join(reviewDir(root, changeId), 'policy.json'), `${JSON.stringify(historicalPolicy)}\n`);

        const before = await readFile(usagePath, 'utf8');
        const ledger = await readLedger(root, changeId);
        expect(ledger.assurance).toBe('sandboxed');
        expect(ledger.malformedFiles).toEqual([]);
        // **The policy is read and the retired floor is substituted, visibly.** R8-F9 moved the substitution into the
        // reader's fill step (it used to happen only for the schema check), so a historical policy comes back with the
        // current default floor and the fact is named — the same rule every other fill in this reader follows. The *usage*
        // record below is the one that must be preserved verbatim, and it is.
        expect(ledger.policy.tiers.security.assuranceFloor).toBe('observed');
        expect(ledger.policyFilled).toContain('tiers.security.assuranceFloor');
        expect(ledger.policyRejected).toBeNull();

        // **Reading is not deciding.** A reader preserves what the file says: the current assurance stays `sandboxed`
        // and the document is not rewritten by the act of reading it. What a later round *writes* is a separate
        // question, answered by the case below — a retired value must not outrank the round that just ran.
        expect(await readFile(usagePath, 'utf8')).toBe(before);
        expect(ledger.assurance).toBe('sandboxed');
    });
});

/**
 * A retired value that outranks every later round is a value that decides the gate for ever.
 *
 * Measured before this fix: an approval refused the change and dispatched "re-run the verification so Kata records
 * current observed assurance", and re-running returned the same `sandboxed` byte for byte, because `ensureAssurance`
 * kept the stronger of the two and no command removes a ledger file. The state the refusal named as its remedy was
 * therefore unreachable.
 */
describe('a recorded round replaces a recorded round', () => {
    it('lets a later observed round replace a retired sandboxed value, keeping the value as history', async () => {
        const replaceRoot = await mkdtemp(join(tmpdir(), 'kata-assurance-replace-'));
        const replaceChange = 'replace-fixture';
        try {
            await initLayout(replaceRoot);
            await createTask({
                root: replaceRoot,
                id: replaceChange,
                title: 'replace fixture',
                acceptance: [{ id: 'AC-1', statement: 'a recorded round replaces a recorded round' }],
                ownedPaths: ['src/store/ledger.ts'],
                workflowProfile: {
                    version: 1, isolationMode: 'current_worktree', developmentMode: 'tdd', reviewMode: 'strict',
                    comet: { projectInit: 'not_requested', openStatus: 'acknowledged' },
                },
            });
            await ensureAssurance(replaceRoot, replaceChange, 'observed');
            await writeFile(
                join(reviewDir(replaceRoot, replaceChange), 'usage.json'),
                `${JSON.stringify({ usage: {}, assurance: 'sandboxed' })}\n`,
                'utf8',
            );

            expect(await ensureAssurance(replaceRoot, replaceChange, 'observed')).toBe('observed');
            const written = JSON.parse(await readFile(join(reviewDir(replaceRoot, replaceChange), 'usage.json'), 'utf8')) as {
                assurance: string;
                assuranceHistory: Array<{ replaced: string }>;
            };
            expect(written.assurance).toBe('observed');
            // The retired value is not erased: it becomes history rather than the current assurance.
            expect(written.assuranceHistory.map((entry) => entry.replaced)).toEqual(['sandboxed']);
        } finally {
            await rm(replaceRoot, { recursive: true, force: true });
        }
    });

    it('publishes the retired value it moved past, so "kept as history" is a fact and not a file', async () => {
        // R8-F2: `ensureAssurance` wrote `assuranceHistory` and only a test ever read it, so the record existed and the
        // fact was unavailable — the write-only shape this repository removes everywhere else.
        const historyRoot = await mkdtemp(join(tmpdir(), 'kata-assurance-history-'));
        const historyChange = 'history-fixture';
        try {
            await initLayout(historyRoot);
            await createTask({
                root: historyRoot, id: historyChange, title: 'history fixture',
                acceptance: [{ id: 'AC-1', statement: 'the retired value is published, not just recorded' }],
                ownedPaths: ['src/store/ledger.ts'],
                workflowProfile: {
                    version: 1, isolationMode: 'current_worktree', developmentMode: 'tdd', reviewMode: 'strict',
                    comet: { projectInit: 'not_requested', openStatus: 'acknowledged' },
                },
            });
            await ensureAssurance(historyRoot, historyChange, 'observed');
            await writeFile(
                join(reviewDir(historyRoot, historyChange), 'usage.json'),
                `${JSON.stringify({ usage: {}, assurance: 'sandboxed' })}\n`, 'utf8',
            );
            await ensureAssurance(historyRoot, historyChange, 'observed');

            const ledger = await readLedger(historyRoot, historyChange);
            expect(ledger.assurance).toBe('observed');
            expect(ledger.assuranceHistory.map((entry) => entry.replaced)).toEqual(['sandboxed']);
            expect(ledger.assuranceHistory[0]?.why).toContain('history');

            // And the report envelope publishes it — the surface a reader actually inspects.
            const report = await ledgerReport(historyRoot, historyChange);
            expect(report.assurance).toBe('observed');
            expect(report.assuranceHistory.map((entry) => entry.replaced)).toEqual(['sandboxed']);

            // **The plain `ledger status` envelope, asserted on its own.** R9-F3: this change said the history was published
            // by "`ledger status --cost` and `ledgerReport`" — which is *one* surface, since `--cost` calls `ledgerReport`.
            // Deleting the line from the plain status envelope left 1289 cases green, so the second surface had no
            // falsifier and the count was wrong. A surface a reader can reach has to be asserted where it is reached.
            const { runLedgerCommand } = await import('../../src/cli/ledger.js');
            const { vi } = await import('vitest');
            const chunks: string[] = [];
            const spy = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string) => {
                chunks.push(String(chunk));
                return true;
            }) as never);
            try {
                await runLedgerCommand(['status'], { root: historyRoot, changeId: historyChange });
            } finally {
                spy.mockRestore();
            }
            const envelope = JSON.parse(chunks.join('').split('\n').filter((line) => line.trim().startsWith('{')).pop() ?? '{}') as {
                assurance?: string;
                assuranceHistory?: Array<{ replaced: string }>;
            };
            expect(envelope.assurance).toBe('observed');
            expect(envelope.assuranceHistory?.map((entry) => entry.replaced)).toEqual(['sandboxed']);
        } finally {
            await rm(historyRoot, { recursive: true, force: true });
        }
    });
});
