import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initLayout } from '../../src/core/layout.js';
import { createTask } from '../../src/core/task.js';
import { REVIEW_GATE_CONDITIONS, buildAdversarialBrief } from '../../src/quality/adversarial.js';
import type { AdversarialGateReason } from '../../src/quality/adversarial.js';

/**
 * **Every condition the gate judges a record by is stated in the brief that record answers.**
 *
 * Measured before this test existed: of the gate's 19 refusal reasons, 9 judge the pass, and **6 of those 9 appeared nowhere in the brief**.
 * Each of the six refused a record on this repository:
 *
 *   * `incomplete` — the coverage requirement (every criterion the revision changed must be claimed) was met by seven rounds only
 *     because a human was pasting it into each dispatch prompt by hand;
 *   * `incomplete` — `inconclusive` and `abandoned` each refuse the whole record, while the brief's own envelope section tells the pass to
 *     record what it did not reach as `abandoned`;
 *   * `incomplete` — `resolves()` requires an `observation.ref` to be *exactly one declared path*, while the brief asked only for
 *     "something openable at this revision", so six refs carrying a line range were refused for a format nobody had stated;
 *   * `incomplete` — an `analysis` ref resolves only against an instrument registry the brief never mentioned;
 *   * `undeclared_test_path` — `readTests` was required (by a neighbouring change) and declared in no brief;
 *   * `stale_revision`, `brief_mismatch`, `delta_stale`, `not_fresh_context` — none stated.
 *
 * Its twin already exists for the writer's half of the same contract: *every field the brief prescribes is accepted by the writer*. The two
 * together are one rule — **the brief's vocabulary and the gate's vocabulary are the same vocabulary** — and this file is the half a pass
 * experiences as an unexplained refusal.
 */
describe('every condition the gate judges by is stated in the brief', () => {
    const roots: string[] = [];
    afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

    async function workspace(): Promise<string> {
        const root = await mkdtemp(join(tmpdir(), 'kata-gate-conditions-'));
        roots.push(root);
        await initLayout(root);
        await createTask({ root, id: 'k-task', title: 'K', acceptance: [{ id: 'AC-1', statement: 'x' }] });
        return root;
    }

    /**
     * The reasons that refuse **a record** for something the record could have done differently. Everything here is a condition a pass
     * could have satisfied had it been told, which is why a row is required for each.
     */
    const PASS_FACING: AdversarialGateReason[] = [
        'incomplete',
        'undeclared_test_path',
        'brief_mismatch',
        'not_fresh_context',
        'stale_revision',
        'executor_unavailable',
    ];

    /**
     * The reasons that describe a **state of the task or the host** rather than a property of the record, listed explicitly so the carve-out
     * is a decision rather than an omission: `no_revision` and `brief_not_issued` are "nothing has been sealed or issued yet", and
     * `delta_stale` / `delta_unavailable` are "the remit could not be derived" — no record can satisfy or violate any of them, so there is
     * nothing for a brief to state about the record.
     */
    const TASK_OR_HOST_STATES: AdversarialGateReason[] = ['no_revision', 'brief_not_issued', 'delta_stale', 'delta_unavailable'] as never;

    it('has a row for every refusal that judges the pass', () => {
        const covered = new Set(REVIEW_GATE_CONDITIONS.map((row) => row.reason));
        const missing = PASS_FACING.filter((reason) => !covered.has(reason));
        expect(
            missing,
            `these refusals judge the pass and no brief states their condition — a pass cannot satisfy a rule it cannot read: ${missing.join(', ')}`,
        ).toEqual([]);
    });

    it('renders every row into the brief the pass is handed', async () => {
        const root = await workspace();
        const brief = await buildAdversarialBrief(root, 'k-task', 'review');
        const text = brief.text;
        for (const row of REVIEW_GATE_CONDITIONS) {
            expect(text, `the brief does not state: ${row.condition}`).toContain(row.condition);
        }
        // And the refusal each condition produces is named, so the pass recognises it when it arrives.
        for (const row of REVIEW_GATE_CONDITIONS) {
            expect(text, `the brief does not name what refuses the record: ${row.what}`).toContain(row.what);
        }
    });

    it('states the conditions contiguously, rather than scattered through the guidance', async () => {
        // A condition buried in prose is a condition the pass reads after deciding, so the table is one block with one heading. This is
        // asserted because the value of the block is that it can be found at all.
        const root = await workspace();
        const brief = await buildAdversarialBrief(root, 'k-task', 'review');
        const text = brief.text;
        const heading = '## What will refuse this record';
        expect(text).toContain(heading);
        for (const row of REVIEW_GATE_CONDITIONS) {
            const at = text.indexOf(row.condition);
            expect(at, `a condition rendered outside the block: ${row.condition.slice(0, 40)}`).toBeGreaterThan(text.indexOf(heading));
        }
    });
});
