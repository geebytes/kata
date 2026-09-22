import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initLayout } from '../../src/core/layout.js';
import { createTask } from '../../src/core/task.js';
import { createTaskRevision } from '../../src/workflow/revision.js';
import { buildAdversarialBrief, issueAdversarialBrief, renderAdversarialBrief } from '../../src/quality/adversarial.js';
import { evaluateAdmissibility, type ReviewState } from '../../src/quality/review-state.js';
import * as budgetModule from '../../src/quality/adversarial.js';

/**
 * The headroom the module applies over a measured cost. Restated here rather than imported so a silent change to the
 * factor fails this file: the factor is a judgement, and a judgement that moves without notice is how the envelope
 * drifted away from reality the first time.
 */
const REVIEW_HEADROOM = 1.5;

/**
 * §3.2.2: the budget is a **mechanism**, not a suggestion.
 *
 * The brief measured 15,631 characters, of which 5,221 (33%) were three prose sections telling the reviewer how to be
 * cheap — "How to spend a turn" (1,349), "Use the cheapest instrument that can answer" (2,943), "How long this round
 * should run" (929). None of it was enforced, and the measured 2,627-second, 128-tool-call pass ran with all of it in
 * context. A natural-language budget is not a budget: the reviewer can spend 40 tool calls inside one attempt and
 * believe it made three.
 *
 * This file pins the two halves that make it a mechanism:
 *
 *   1. the envelope is **structured data** carried by the issued brief, so a caller reads numbers rather than prose;
 *   2. exhausting it produces `budget_exhausted`, which §3.1.2's predicate already refuses — so a truncated round
 *      becomes a reported, actionable state instead of a silent pass.
 *
 * What this file deliberately does **not** claim: that the envelope is enforced by an executor. Kata is a CLI and cannot
 * observe a host subagent, so enforcement is the host's half of the contract (§3.2.1). Until an executor enforces it,
 * the envelope is at least *declared in machine-readable form* and *refused when reported exhausted*, which is strictly
 * more than prose.
 */
describe('the review budget is data, and running out of it is a refused state', () => {
    const roots: string[] = [];
    afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

    async function task(root: string, id: string): Promise<void> {
        await initLayout(root);
        await createTask({
            root, id, title: 'Budget', acceptance: [{ id: 'AC-1', statement: 'A budget exists.' }],
        });
        await mkdir(join(root, 'src'), { recursive: true });
        await writeFile(join(root, 'src/x.ts'), 'export const x = 1;\n', 'utf8');
        await createTaskRevision({ root, taskId: id, ownedPaths: ['src/x.ts'], checkIds: [] });
    }

    it('carries the envelope as data on the brief, not as prose in its text', async () => {
        const root = await mkdtemp(join(tmpdir(), 'kata-budget-'));
        roots.push(root);
        await task(root, 'budgeted');

        const brief = await buildAdversarialBrief(root, 'budgeted', 'verify');

        // The envelope is a structured field with all four limits, so a caller (or an executor) reads numbers.
        expect(brief.budget).toMatchObject({
            maxHypotheses: expect.any(Number),
            maxToolCalls: expect.any(Number),
            maxOutputBytes: expect.any(Number),
            maxWallMs: expect.any(Number),
        });
        expect(brief.budget.maxHypotheses).toBeGreaterThan(0);
        expect(brief.budget.maxWallMs).toBeGreaterThan(0);
        // And it is rendered for the reviewer as a contract, not as advice: the words that made the old sections advice
        // must not be the only statement of the limit.
        expect(brief.text).toContain('budget');
    });

    it('keeps the envelope stable across the issue → read path, so the issued copy is the authority', async () => {
        const root = await mkdtemp(join(tmpdir(), 'kata-budget-issue-'));
        roots.push(root);
        await task(root, 'budget-issued');

        const issued = await issueAdversarialBrief(root, 'budget-issued', 'verify', { mode: 'cold' });

        expect(issued.budget).toBeDefined();
        expect(issued.budget.maxHypotheses).toBeGreaterThan(0);
    });

    it('derives budget_exhausted from a hypothesis stopped by each limit the envelope names', () => {
        const base = {
            coverage: [{ criterionId: 'AC-1', paths: ['src/x.ts'] }],
            findings: [],
        };
        const revision = { revisionId: 'r', changedPaths: ['src/x.ts'], criterionIds: ['AC-1'] };

        for (const limit of ['budget', 'time', 'tools'] as const) {
            const state: ReviewState = {
                ...base,
                hypotheses: [
                    { id: 'h1', claim: 'c', targets: ['AC-1', 'src/x.ts'], method: 'source-read', outcome: 'refuted', observation: { kind: 'source', ref: 'src/x.ts#L1', observed: 'ok' } },
                    { id: 'h2', claim: 'c2', targets: ['AC-1', 'src/x.ts'], method: 'source-read', outcome: 'abandoned', abandoned: { limit, why: 'the envelope was reached' } },
                ],
            };
            const result = evaluateAdmissibility(state, revision);
            // Refused, and it says *which* limit — not "no defects found", which is the state a truncated round used to
            // terminate as whenever nothing was written down.
            expect(result.admissible).toBe(false);
            expect(result.verdict).toBe('budget_exhausted');
            expect(result.abandoned).toEqual(['h2']);
        }
    });
});

/**
 * §1.3.4 item 4: the envelope goes into the brief **as data**, not only as rendered prose.
 *
 * Rendered as a table it is the reviewer's to read; as a machine-readable object it is also the *host's* to parse, so an
 * executor can hold the round to the same numbers the text states without re-parsing Markdown. Measured before this:
 * the brief carried the numbers and the IR carried the object, so a host reading only the prompt had no envelope.
 */
describe('the brief carries the envelope as data', () => {
    const base = {
        taskId: 'budget-data', node: 'review' as const, revisionId: 'revision-1',
        acceptance: [{ id: 'AC-1', statement: 'x' }], evidence: [], ownedPaths: ['src/a.ts'],
    };

    it('embeds one machine-readable budget object that agrees with the rendered table', () => {
        const text = renderAdversarialBrief(base);
        const match = /```json\n([\s\S]*?)\n```/.exec(text.split('## Budget')[1] ?? '');
        expect(match, 'the budget section must carry a fenced json object').toBeTruthy();

        const parsed = JSON.parse(match![1]!) as { maxHypotheses: number; maxToolCalls: number; maxWallMs: number };
        expect(parsed.maxHypotheses).toBeGreaterThan(0);
        expect(parsed.maxToolCalls).toBeGreaterThan(0);
        expect(parsed.maxWallMs).toBeGreaterThan(0);
        // The data and the prose are one envelope: a host and a reader must not see different limits.
        expect(text).toContain(`| hypotheses | ${parsed.maxHypotheses} |`);
    });
});

/** The rendered table and the embedded object are one envelope, checked line by line. */
describe('the table and the data cannot drift', () => {
    it('states the same numbers in both', () => {
        const text = renderAdversarialBrief({
            taskId: 'budget-drift', node: 'review', revisionId: 'revision-1',
            acceptance: [{ id: 'AC-1', statement: 'x' }], evidence: [], ownedPaths: ['src/a.ts'],
        });
        const section = text.split('## Budget')[1] ?? '';
        const parsed = JSON.parse(/```json\n([\s\S]*?)\n```/.exec(section)![1]!) as Record<string, number>;
        const grouped = (value: number): string => String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
        for (const [key, value] of Object.entries(parsed)) {
            // The wall time is also rendered as a human duration, so its raw value is what pins the shared envelope.
            expect(section.includes(grouped(value)), `${key}=${value} must appear in the table (as ${grouped(value)})`).toBe(true);
        }
    });
});

/**
 * The envelope's limits were taken from the design's **illustrative** JSON block — `{maxHypotheses: 6, maxToolCalls: 48,
 * maxOutputBytes: 2000000, maxWallMs: 900000}` — and never calibrated against what a pass on this repository costs.
 *
 * Measured consequence (2026-09-22): a real independent pass, executed honestly under the envelope, was killed at the
 * wall limit after 15 minutes having made **70 tool calls** with 32 turns, still working. Both limits were below the
 * cost of the round they were bounding, and `budget_exhausted` is a **refused** verdict — so a strict review was
 * structurally impossible here, not merely expensive.
 *
 * That is the same defect as an uncalibrated threshold anywhere else: a value chosen from an example rather than from a
 * measurement. These assertions are the guard — a limit may not sit below the cost this repository's passes have
 * actually incurred, because such a limit refuses honest work instead of stopping a runaway.
 */
describe('the review envelope is calibrated from measured pass cost', () => {
    it('sets every limit above the cost the recorded passes actually incurred', () => {
        const { DEFAULT_REVIEW_BUDGET, MEASURED_REVIEW_PASS_COST } = budgetModule;

        expect(
            DEFAULT_REVIEW_BUDGET.maxWallMs,
            `a wall limit below the slowest recorded pass (${MEASURED_REVIEW_PASS_COST.slowestWallMs} ms) kills an honest round`,
        ).toBeGreaterThan(MEASURED_REVIEW_PASS_COST.slowestWallMs);
        expect(
            DEFAULT_REVIEW_BUDGET.maxToolCalls,
            `a tool-call limit below the highest recorded pass (${MEASURED_REVIEW_PASS_COST.mostToolCalls}) kills an honest round`,
        ).toBeGreaterThan(MEASURED_REVIEW_PASS_COST.mostToolCalls);
        expect(
            DEFAULT_REVIEW_BUDGET.maxOutputBytes,
            `an output limit below the largest measured payload (${MEASURED_REVIEW_PASS_COST.bytesPerToolCall} B/tool call) cannot bound a real round`,
        ).toBeGreaterThan(MEASURED_REVIEW_PASS_COST.bytesPerToolCall * MEASURED_REVIEW_PASS_COST.mostToolCalls);
    });

    it('derives the limits rather than restating them, so a recalibration moves all three together', () => {
        const { DEFAULT_REVIEW_BUDGET, MEASURED_REVIEW_PASS_COST } = budgetModule;

        // The relationship, not the number: each limit is its measurement times the module's stated headroom. A literal
        // would drift the moment the measurement is refreshed, which is how the illustrative values survived this long.
        expect(DEFAULT_REVIEW_BUDGET.maxWallMs).toBe(Math.ceil(MEASURED_REVIEW_PASS_COST.slowestWallMs * REVIEW_HEADROOM));
        expect(DEFAULT_REVIEW_BUDGET.maxToolCalls).toBe(Math.ceil(MEASURED_REVIEW_PASS_COST.mostToolCalls * REVIEW_HEADROOM));
    });
});
