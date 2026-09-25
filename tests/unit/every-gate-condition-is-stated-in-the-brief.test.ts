import { mkdtemp, readFile, rm } from 'node:fs/promises';
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
        'receipt_unbound',
        'capability_missing',
        'brief_not_issued',
    ];

    /**
     * The reasons that describe a **state of the task or of the host's launch** rather than a property of the record. Each is listed
     * with why, because the difference between a carve-out and an omission is whether somebody wrote the reason down.
     *
     * `missing` — the task request itself is absent; `waived` — a node the task's mode does not require; `not_required` — no pass is owed
     * for this node; `no_revision` — nothing has been sealed yet, so there is no revision to be about; `delta_stale` and
     * `delta_unavailable` — the remit could not be derived, a fact about the revision pair rather than about the record.
     *
     * **What this list cannot prove is that a carve-out is correct** — only that somebody made it. The auditing round that found the
     * first version's omissions was reading the mapping, not the test; the test's job is to make the mapping impossible to leave implicit.
     */
    const TASK_OR_HOST_STATES: AdversarialGateReason[] = [
        'missing',
        'waived',
        'not_required',
        'no_revision',
        'delta_stale',
        'delta_unavailable',
    ];

    /** Every member of the union, so a new refusal cannot enter without a decision recorded in this file. */
    const EVERY_REASON: AdversarialGateReason[] = [
        'missing',
        'no_revision',
        'stale_revision',
        'not_fresh_context',
        'brief_mismatch',
        'brief_not_issued',
        'incomplete',
        'waived',
        'delta_stale',
        'delta_unavailable',
        'undeclared_test_path',
        'not_required',
        'executor_unavailable',
        'receipt_unbound',
        'capability_missing',
    ];

    it('classifies every member of the union the gate declares, read from the source, so a new refusal cannot enter unclassified', async () => {
        // **The union is read from the code, not remembered here** (`aad-r7-f6`, a major finding from a round this repository executed).
        // The first version compared three hand-written literals against each other plus `expect(EVERY_REASON.length).toBe(15)`, so adding
        // a sixteenth member to `AdversarialGateReason` and changing nothing else left the file **green** — the new reason was neither
        // classified nor required to have a row, which is exactly the case this test's own comment claimed was impossible. A guard against
        // unclassified refusals that holds its own copy of the list is a guard over the copy.
        const source = await readFile('src/quality/adversarial.ts', 'utf8');
        const declared = source.slice(source.indexOf('export type AdversarialGateReason'));
        const union = [...declared.slice(0, declared.indexOf(';')).matchAll(/\|\s*'([a-z_]+)'/g)].map((match) => match[1] as AdversarialGateReason);
        expect(union.length, 'the union did not parse, so this test would assert nothing').toBeGreaterThan(5);

        const classified = new Set([...PASS_FACING, ...TASK_OR_HOST_STATES]);
        const unclassified = union.filter((reason) => !classified.has(reason));
        expect(
            unclassified,
            `these refusals are in neither list, so nobody decided whether a pass can act on them: ${unclassified.join(', ')}`,
        ).toEqual([]);
        const both = PASS_FACING.filter((reason) => TASK_OR_HOST_STATES.includes(reason));
        expect(both, 'a reason cannot be both a condition a pass satisfies and a state it cannot').toEqual([]);
        // And the other direction: a name this file classifies that the code does not declare is a decision about nothing.
        const declaredSet = new Set(union);
        const orphans = [...classified].filter((reason) => !declaredSet.has(reason));
        expect(orphans, `this file classifies refusals the gate does not declare: ${orphans.join(', ')}`).toEqual([]);
    });

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
