import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initLayout } from '../../src/core/layout.js';
import { createTask } from '../../src/core/task.js';
import { reportRounds } from '../../src/quality/repair-rounds.js';

const roots: string[] = [];
afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/**
 * AC-3: how many review rounds a change has had, and how many of the latest round's findings are about what the previous round
 * changed. The five rounds of `closure-gate` were reconstructed by hand from a directory listing to reach the conclusion that
 * the change could not be finished by its author; this is that reconstruction as a command.
 */
async function fixture(id: string): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'kata-rounds-'));
    roots.push(root);
    await initLayout(root);
    await createTask({ root, id, title: 'Rounds', acceptance: [{ id: 'AC-1', statement: 'x' }] });
    const dir = join(root, '.kata/tasks', id);
    await mkdir(dir, { recursive: true });
    await mkdir(join(dir, 'revisions'), { recursive: true });
    // Two recorded rounds, the second of which changed two paths.
    await mkdir(join(dir, 'adversarial-briefs'), { recursive: true });
    await writeFile(join(dir, 'adversarial-briefs/review-revision-one.json'), JSON.stringify({ version: 1, node: 'review', revisionId: 'revision-one', briefs: [{ sha256: 'a'.repeat(64) }] }), 'utf8');
    await writeFile(join(dir, 'adversarial-briefs/review-revision-two.json'), JSON.stringify({ version: 1, node: 'review', revisionId: 'revision-two', briefs: [{ sha256: 'b'.repeat(64) }] }), 'utf8');
    await writeFile(join(dir, 'adversarial-review-history.json'), JSON.stringify([
        { revisionId: 'revision-one', findings: [1, 2, 3], createdAt: '2026-09-23T01:00:00.000Z' },
    ]), 'utf8');
    await writeFile(join(dir, 'revisions/revision-one.json'), JSON.stringify({
        pathDigests: { 'src/changed.ts': 'a'.repeat(64), 'src/other.ts': 'b'.repeat(64), 'src/untouched.ts': 'c'.repeat(64) },
        // **contentDigests, because the change surface derives from content and not from the owned-path manifest** — the
        // distinction f1 is about, and the reason the first attempt at this fix reported 0 where the case expects 2.
        contentDigests: { 'src/changed.ts': 'a'.repeat(64), 'src/other.ts': 'b'.repeat(64), 'src/untouched.ts': 'c'.repeat(64) },
    }), 'utf8');
    await writeFile(join(dir, 'revisions/revision-two.json'), JSON.stringify({
        id: 'revision-two',
        pathDigests: { 'src/changed.ts': 'd'.repeat(64), 'src/other.ts': 'e'.repeat(64), 'src/untouched.ts': 'c'.repeat(64) },
        contentDigests: { 'src/changed.ts': 'd'.repeat(64), 'src/other.ts': 'e'.repeat(64), 'src/untouched.ts': 'c'.repeat(64) },
    }), 'utf8');
    await writeFile(join(dir, 'adversarial-review.json'), JSON.stringify({
        revisionId: 'revision-two',
        createdAt: '2026-09-23T02:00:00.000Z',
        // Three findings, of which two targeted a path the previous round changed.
        findings: [{ id: 'f1' }, { id: 'f2' }, { id: 'f3' }],
        hypotheses: [{ targets: ['src/changed.ts'] }, { targets: ['src/other.ts', 'AC-1'] }, { targets: ['src/untouched.ts'] }],
    }), 'utf8');
    return root;
}

describe('a change reports its review rounds and how many findings are about the previous round', () => {
    it('counts the rounds that left a record, and the share about the previous round', async () => {
        const root = await fixture('rounds');
        const report = await reportRounds(root, 'rounds', 'review');

        // Two rounds: the one in history and the live one. A round that produced nothing leaves no trace, which is why the
        // count can be lower than the number of rounds actually run.
        expect(report.rounds.map((round) => round.revisionId)).toEqual(['revision-one', 'revision-two']);
        expect(report.rounds.map((round) => round.findings)).toEqual([3, 3]);
        expect(report.targetsAboutThePreviousRound).toBe(2);
        // The share is over **targets**, not findings: the union of the hypotheses targets is four paths
        // (src/changed.ts, src/other.ts, AC-1, src/untouched.ts) and two of them are about the previous round.
        expect(report.shareAboutThePreviousRound).toBeCloseTo(2 / 4);
    });

    it('reports nothing for a task that has had no rounds, rather than failing', async () => {
        // **This case used to be `expect(true).toBe(true)`** — a green check that demonstrated no behaviour, sitting in the
        // selector the gate certifies AC-3 against (`rba-f12`). It only called `reportRounds` in its title. A task with no
        // rounds is the boundary the report exists for (the module docstring's "a round that produced nothing leaves no
        // trace"), so it is now exercised and asserted.
        //
        // The real-data check that used to live here — `closure-gate` reporting four rounds and a share of 0.85 — was moved
        // out of the suite: the seal runs a check against the sealed content, and another change's runtime data under
        // `.kata/` is not part of it, so the case exited 1 in the seal and passed in the working tree. A test that only
        // passes where its author's other changes happen to be is not a test. The measurement is recorded in the design doc
        // as a re-derived transcript instead.
        const root = await mkdtemp(join(tmpdir(), 'kata-rounds-'));
        roots.push(root);
        await initLayout(root);
        await createTask({ root, id: 'no-rounds', title: 'Rounds', acceptance: [{ id: 'AC-1', statement: 'x' }] });

        const report = await reportRounds(root, 'no-rounds', 'review');
        expect(report.rounds).toEqual([]);
        // No previous round, so the question is unanswerable rather than answered with zero.
        expect(report.targetsAboutThePreviousRound).toBeNull();
        expect(report.shareAboutThePreviousRound).toBeNull();
        expect(report.unrecorded).toBe(false);
    });

    it('reports two rounds on the same revision as unanswerable, not as a measured zero', async () => {
        // `rba-f10`: `shareAboutThePreviousRound` was `about / max(1, allTargets(live))` with `about` defaulting to 0, so a
        // round whose previous round sat on the **same revision** — no surface to be about — reported `share: 0`, which a
        // reader takes as perfect convergence. This is the case on disk for `closure-gate` (rounds 4 and 5 both on
        // `revision-1e0a2f0d2503bc5c`). An unanswerable question reads as unanswerable.
        const root = await mkdtemp(join(tmpdir(), 'kata-rounds-'));
        roots.push(root);
        await initLayout(root);
        await createTask({ root, id: 'same-revision', title: 'Rounds', acceptance: [{ id: 'AC-1', statement: 'x' }] });
        const dir = join(root, '.kata/tasks/same-revision');
        await mkdir(join(dir, 'revisions'), { recursive: true });
        await writeFile(join(dir, 'revisions/revision-one.json'), JSON.stringify({
            id: 'revision-one',
            pathDigests: { 'src/changed.ts': 'a'.repeat(64) },
            contentDigests: { 'src/changed.ts': 'a'.repeat(64) },
        }), 'utf8');
        await writeFile(join(dir, 'adversarial-review-history.json'), JSON.stringify([
            { revisionId: 'revision-one', findings: [1, 2], createdAt: '2026-09-23T01:00:00.000Z' },
        ]), 'utf8');
        await writeFile(join(dir, 'adversarial-review.json'), JSON.stringify({
            revisionId: 'revision-one',
            createdAt: '2026-09-23T02:00:00.000Z',
            findings: [{ id: 'f1' }, { id: 'f2' }],
            hypotheses: [{ targets: ['src/changed.ts'] }],
        }), 'utf8');

        const report = await reportRounds(root, 'same-revision', 'review');
        expect(report.rounds).toHaveLength(2);
        expect(report.targetsAboutThePreviousRound).toBeNull();
        expect(report.shareAboutThePreviousRound).toBeNull();
    });
});

/**
 * `rba-f2`: the field's docstring said "True when the rounds do not account for every brief issued — a round that produced
 * nothing", and the code could never report it. It asked whether the latest brief file existed and whether there were **no rounds
 * at all**, which is false the moment a round exists. Measured on `closure-gate`: five briefs across four files, four records.
 */
describe('a round that produced nothing is reported rather than papered over', () => {
    it('reports unrecorded when more briefs were issued than rounds left a record', async () => {
        const root = await fixture('unrecorded');
        const dir = join(root, '.kata/tasks/unrecorded');
        // Two rounds are recorded by the fixture; three briefs were issued, so one round left nothing behind.
        await writeFile(join(dir, 'adversarial-briefs/review-revision-extra.json'), JSON.stringify({
            version: 1, node: 'review', revisionId: 'revision-extra',
            briefs: [{ sha256: 'a'.repeat(64) }],
        }), 'utf8');

        const report = await reportRounds(root, 'unrecorded', 'review');
        expect(report.rounds).toHaveLength(2);
        expect(report.unrecorded).toBe(true);
    });
});

/**
 * A round is ordered by when it was *made*, and a record carries the timestamp of the pass it *replaces*.
 *
 * Measured on `repair-by-another-author`: `adversarial-review-history.json` held
 * `revision-daf33fefeb9f0bff @ 2026-09-23T13:45:00.000Z` while the live record was
 * `revision-becb49c9303042ca @ 2026-09-23T13:45:00.000Z` — the live record inherits the *old* timestamp because it replaced that
 * record. Two recorded passes, an order that was not oldest-first, and `rounds.at(-2)` then took the share's base from an entry
 * the live record was never measured against: numerator and denominator belonged to different rounds.
 *
 * A key built from `revisionId@createdAt` does not collide on that pair (the revisions differ) — which is why the first version
 * of this case could not fail. What the pair breaks is the **ordering**.
 */
describe('the latest round is the live record, and the share pairs it with its predecessor', () => {
    /**
     * `rba5-f5`, and it is a finding against the decision that closed `rba4-f1`: that repair changed the identity key and left
     * the pairing the same finding named. The share still read `previous = rounds.at(-2)` while ordering by `recordedAt` — a
     * value the writer **inherits from the pass it replaces** — so on this task's own artefacts the live record sorted into the
     * middle, `at(-2)` was the live record itself, `revisionChangeSurface(live, live)` answered `unchanged`, and
     * `targetsAboutThePreviousRound` was `null` for a change that had both a previous and a latest round.
     *
     * So the ordering is not a claim about timestamps: **the live record is the latest by construction**, because it is what the
     * previous pass was replaced with. This case seeds the shape that broke it — a history record whose `recordedAt` is later
     * than the live record's — and asserts the pairing.
     */
    it('keeps the live record last, so the share pairs it with its own predecessor', async () => {
        const root = await mkdtemp(join(tmpdir(), 'kata-rounds-'));
        roots.push(root);
        const { mkdir, writeFile } = await import('node:fs/promises');
        const dir = join(root, '.kata/tasks/t');
        await mkdir(dir, { recursive: true });
        // The live record inherits the timestamp of the pass it replaced, so it looks *earlier* than a later round.
        await writeFile(join(dir, 'adversarial-review-history.json'), JSON.stringify([
            { revisionId: 'revision-b', createdAt: '2026-09-24T01:10:00.000Z', findings: [{ id: 'f1' }] },
        ]));
        await writeFile(join(dir, 'adversarial-review.json'), JSON.stringify(
            { revisionId: 'revision-a', createdAt: '2026-09-23T13:45:00.000Z', findings: [{ id: 'f2' }] },
        ));
        const report = await reportRounds(root, 't');
        expect(report.rounds).toHaveLength(2);
        // The live round is last despite carrying the earlier timestamp — which is the whole point.
        expect(report.rounds.at(-1)?.revisionId).toBe('revision-a');
    });

    it('counts a revision that appears in the history and live as one round, not two', async () => {
        const root = await mkdtemp(join(tmpdir(), 'kata-rounds-'));
        roots.push(root);
        const { mkdir, writeFile } = await import('node:fs/promises');
        const dir = join(root, '.kata/tasks/t');
        await mkdir(dir, { recursive: true });
        // Measured on this task: the history held the replaced copy of `becb49c9303042ca` while the live record was the same
        // revision with an appended finding, and comparing whole records counted four entries for three rounds.
        await writeFile(join(dir, 'adversarial-review-history.json'), JSON.stringify([
            { revisionId: 'revision-a', createdAt: '2026-09-23T13:45:00.000Z', findings: [{ id: 'f1' }] },
        ]));
        await writeFile(join(dir, 'adversarial-review.json'), JSON.stringify(
            { revisionId: 'revision-a', createdAt: '2026-09-23T13:45:00.000Z', findings: [{ id: 'f1' }, { id: 'f2' }] },
        ));
        const report = await reportRounds(root, 't');
        // One revision, one round — the appended finding does not make a second one.
        expect(report.rounds).toHaveLength(1);
    });
});
