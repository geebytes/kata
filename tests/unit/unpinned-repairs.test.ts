import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// AC-5. Two repairs were measured as **unpinned** on 2026-09-22: reverting each left the full suite completely green
// (`docs/design/2026-09-21-adversarial-execution-control-optimization.md` §19). These are the tests that should have
// existed. Neither is a new behaviour — both pin behaviour that is already correct, which is precisely what was missing.
//
// R1 mattered most: it was the `blocking` finding whose consequence was that a reviewer following the brief verbatim
// could record nothing, and one real pass was destroyed that way. No test held the repair.

describe('a repair that was measured as unpinned', () => {
    it("R1: every field the issued brief prescribes is accepted by the writer", async () => {
        const { initLayout } = await import('../../src/core/layout.js');
        const { createTask } = await import('../../src/core/task.js');
        const { createTaskRevision } = await import('../../src/workflow/revision.js');
        const { buildAdversarialBrief, writeAdversarialRecord } = await import('../../src/quality/adversarial.js');

        const root = await mkdtemp(join(tmpdir(), 'kata-unpinned-r1-'));
        try {
            await initLayout(root);
            await createTask({ root, id: 'unpinned-r1', title: 'R1', ownedPaths: ['src/a.ts'], acceptance: [{ id: 'AC-1', statement: 'x' }] });
            await mkdir(join(root, 'src'), { recursive: true });
            await writeFile(join(root, 'src/a.ts'), 'export const a = 1;\n', 'utf8');
            await createTaskRevision({ root, taskId: 'unpinned-r1', ownedPaths: ['src/a.ts'], checkIds: [] });

            const brief = await buildAdversarialBrief(root, 'unpinned-r1', 'review');
            const start = brief.text.indexOf('## Required result');
            const fence = brief.text.indexOf('```json', start);
            const close = brief.text.indexOf('```', fence + 7);
            const template = JSON.parse(brief.text.slice(fence + 7, close)) as Record<string, unknown>;

            // Build the record out of the template's own keys, so *any* field the template prescribes — including one the
            // writer has since retired — has to be accepted. That is the round-trip that was never tested.
            const values: Record<string, unknown> = {
                node: 'review',
                status: 'recorded',
                revisionId: brief.revisionId,
                executedInFreshContext: true,
                contextNote: 'a context that did not author the change',
                briefSha256: brief.sha256,
                hypotheses: [{
                    id: 'h1',
                    claim: 'the acceptance criterion is only satisfied by the shape of the test',
                    targets: ['AC-1'],
                    method: 'source-read',
                    outcome: 'refuted',
                    observation: { kind: 'source', ref: 'src/a.ts', observed: 'the assertion exercises the behaviour' },
                }],
                attempts: [{ hypothesis: 'x', method: 'y', outcome: 'refuted' }],
                findings: [],
                // Supplied so that a `verdict` re-appearing in the template reddens for the *right* reason: the schema
                // accepts this value, and the writer's retired-field refusal is what rejects the record. With an
                // unknown-string placeholder the schema rejected it first, which would have hidden the retirement.
                verdict: 'no_defect_found',
                createdAt: '2026-09-22T00:00:00.000Z',
            };

            const prescribed = Object.keys(template);
            expect(prescribed.length).toBeGreaterThan(0);
            const record: Record<string, unknown> = {};
            for (const key of prescribed) record[key] = values[key] ?? 'a field the writer does not know';

            await expect(writeAdversarialRecord(root, 'unpinned-r1', record as never)).resolves.toBeDefined();
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it('R10: a corpus case whose reproduction requires a refusal does not answer "no defect found"', async () => {
        const { admissibilityCorpus } = await import('../../src/eval/admissibility-corpus.js');
        const corpus = admissibilityCorpus();

        const guardCase = corpus.find((entry) => entry.id === 'guard-penalises-an-honest-inconclusive');
        expect(guardCase).toBeDefined();
        // Its reproduction requires the pass to be *refused*; the refusal is the guard working, so a correct verifier
        // answers with the state that declines to certify. Declaring `no_defect_found` here contradicts the case's own
        // text — which is what the case said before it was corrected, and nothing noticed when it was put back.
        expect(guardCase!.reproduction).toMatch(/refus/i);
        expect(guardCase!.expectedVerdict).toBe('inconclusive');


        // Deliberately *not* generalised into "any case whose reproduction mentions a refusal". Two guard-false-negative
        // cases (`guard-refuses-a-declared-test-citation`, `guard-refuses-a-refuted-with-no-observation`) describe a
        // refusal that is itself the defect, on an otherwise clean revision — so `no_defect_found` is their correct
        // answer. The general rule is false, and it was written here first and failed on exactly those two before being
        // checked against the corpus.
        expect(corpus.some((entry) => entry.id === 'guard-refuses-a-declared-test-citation')).toBe(true);
    });
});

/**
 * AC-6 of `kata-gate-surface`: a later pass cannot delete an earlier pass's statement.
 *
 * `wcc3-f8` measured the opposite: the node record is a single slot, so the pass that writes last decides what is still
 * open — and two findings raised between the seals were gone from every source the seal reads. Measured again while closing
 * `wiring-coverage-check`: round 2's findings survived only in a file written by hand, because round 3's record replaced
 * them.
 */
describe('a pass does not erase the findings of the pass before it', () => {
    it('keeps a finding that the next pass does not re-raise', async () => {
        const { mkdir, mkdtemp, rm } = await import('node:fs/promises');
        const { tmpdir } = await import('node:os');
        const { join } = await import('node:path');
        const root = await mkdtemp(join(tmpdir(), 'kata-pass-history-'));
        try {
            const { initLayout } = await import('../../src/core/layout.js');
            const { createTask } = await import('../../src/core/task.js');
            const { createTaskRevision } = await import('../../src/workflow/revision.js');
            const { writeAdversarialRecord } = await import('../../src/quality/adversarial.js');
            const { readTrackedFindings } = await import('../../src/quality/finding-disposition.js');

            await initLayout(root);
            await mkdir(join(root, 'src'), { recursive: true });
            await createTask({ root, id: 'pass-history', title: 'pass-history', ownedPaths: ['src/x.ts'], acceptance: [{ id: 'AC-1', statement: 'x' }] } as never);
            await createTaskRevision({ root, taskId: 'pass-history', ownedPaths: ['src/x.ts'], checkIds: [] });

            const base = {
                node: 'review' as const,
                status: 'recorded' as const,
                revisionId: 'revision-one',
                manifestHash: 'hash-one',
                executedInFreshContext: true,
                contextNote: 'a fixture',
                hypotheses: [],
                attempts: [],
            };
            await writeAdversarialRecord(root, 'pass-history', {
                ...base,
                createdAt: '2026-09-23T01:00:00.000Z',
                findings: [{ id: 'raised-then-dropped', taskId: 'pass-history', severity: 'major', message: 'raised by the first pass' }],
            } as never);
            // The second pass does not mention it — which is exactly how a finding used to disappear.
            await writeAdversarialRecord(root, 'pass-history', {
                ...base,
                createdAt: '2026-09-23T02:00:00.000Z',
                findings: [],
            } as never);

            const tracked = await readTrackedFindings(root, 'pass-history');
            const ids = tracked.map((finding) => finding.id);
            expect(ids).toContain('raised-then-dropped');
            // One finding is one finding: the slot and the history both carry it, and it appears once.
            expect(ids.filter((id) => id === 'raised-then-dropped')).toHaveLength(1);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    }, 60000);
});

/**
 * `kgs3-f1`, the blocking finding from the second independent round — and it was a defect in the AC-6 repair itself.
 *
 * `readTrackedFindings` pushes the live node record first and each history entry after it, and the dedup loop kept the
 * **later** copy, so a history entry overwrote the live record. Measured consequence: every disposition written through a
 * command was invisible to every reader, and the sealed change record inherited the stale value — which is why
 * `findings list` reported nine findings open while the record itself said one was fixed.
 */
describe('the tracked view reports the disposition the live record holds', () => {
    it('does not let a history entry overwrite the live record', async () => {
        const { mkdtemp, mkdir, rm } = await import('node:fs/promises');
        const { tmpdir } = await import('node:os');
        const { join } = await import('node:path');
        const root = await mkdtemp(join(tmpdir(), 'kata-live-wins-'));
        try {
            const { initLayout } = await import('../../src/core/layout.js');
            const { createTask } = await import('../../src/core/task.js');
            const { createTaskRevision } = await import('../../src/workflow/revision.js');
            const { writeAdversarialRecord } = await import('../../src/quality/adversarial.js');
            const { readTrackedFindings } = await import('../../src/quality/finding-disposition.js');

            await initLayout(root);
            await mkdir(join(root, 'src'), { recursive: true });
            await createTask({ root, id: 'live-wins', title: 'live-wins', ownedPaths: ['src/x.ts'], acceptance: [{ id: 'AC-1', statement: 'x' }] } as never);
            await createTaskRevision({ root, taskId: 'live-wins', ownedPaths: ['src/x.ts'], checkIds: [] });

            const base = {
                node: 'review' as const,
                status: 'recorded' as const,
                revisionId: 'revision-one',
                manifestHash: 'hash-one',
                executedInFreshContext: true,
                contextNote: 'a fixture',
                hypotheses: [],
                attempts: [],
            };
            // The first pass reports it open; the second, which replaces the record, reports it fixed. The history keeps
            // the open copy — and it must not win.
            await writeAdversarialRecord(root, 'live-wins', {
                ...base,
                createdAt: '2026-09-23T01:00:00.000Z',
                findings: [{ id: 'now-fixed', taskId: 'live-wins', severity: 'major', message: 'raised by the first pass' }],
            } as never);
            await writeAdversarialRecord(root, 'live-wins', {
                ...base,
                createdAt: '2026-09-23T02:00:00.000Z',
                findings: [{ id: 'now-fixed', taskId: 'live-wins', severity: 'major', message: 'repaired', disposition: 'fixed' }],
            } as never);

            const tracked = await readTrackedFindings(root, 'live-wins');
            const found = tracked.find((finding) => finding.id === 'now-fixed');
            expect(found?.disposition).toBe('fixed');
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    }, 60000);
});

/**
 * `kgs3-f2`, claim one: the read-back guard added for `kgs-f1` was said to be **unsatisfiable for any finding that lives in
 * an adversarial node record** — because the read-back returned the history's copy with the old disposition. That is a
 * consequence of `kgs3-f1`'s inverted precedence rather than an independent defect, and with the precedence fixed the guard
 * should be satisfiable. That claim was reached by reading the code, and this makes it a measurement.
 */
describe('a disposition on a finding in the adversarial record reads back', () => {
    it('does not throw for a finding that lives in a node record', async () => {
        const { mkdtemp, mkdir, rm } = await import('node:fs/promises');
        const { tmpdir } = await import('node:os');
        const { join } = await import('node:path');
        const root = await mkdtemp(join(tmpdir(), 'kata-node-readback-'));
        try {
            const { initLayout } = await import('../../src/core/layout.js');
            const { createTask } = await import('../../src/core/task.js');
            const { createTaskRevision } = await import('../../src/workflow/revision.js');
            const { writeAdversarialRecord } = await import('../../src/quality/adversarial.js');
            const { applyDisposition, readTrackedFindings } = await import('../../src/quality/finding-disposition.js');

            await initLayout(root);
            await mkdir(join(root, 'src'), { recursive: true });
            await createTask({ root, id: 'node-readback', title: 'node-readback', ownedPaths: ['src/x.ts'], acceptance: [{ id: 'AC-1', statement: 'x' }] } as never);
            await createTaskRevision({ root, taskId: 'node-readback', ownedPaths: ['src/x.ts'], checkIds: [] });

            await writeAdversarialRecord(root, 'node-readback', {
                node: 'review',
                status: 'recorded',
                revisionId: 'revision-one',
                manifestHash: 'hash-one',
                executedInFreshContext: true,
                contextNote: 'a fixture',
                createdAt: '2026-09-23T01:00:00.000Z',
                hypotheses: [],
                attempts: [],
                findings: [{ id: 'in-a-node-record', taskId: 'node-readback', severity: 'minor', message: 'a minor finding' }],
            } as never);

            // A **second** pass, so the first record lands in the history carrying the old disposition — which is the
            // condition the finding describes. Measured: without it the fixture had no history, the dedup had nothing to
            // choose between, and the case passed under the mutation that restores the defect.
            await writeAdversarialRecord(root, 'node-readback', {
                node: 'review',
                status: 'recorded',
                revisionId: 'revision-one',
                manifestHash: 'hash-one',
                executedInFreshContext: true,
                contextNote: 'a fixture',
                createdAt: '2026-09-23T02:00:00.000Z',
                hypotheses: [],
                attempts: [],
                findings: [{ id: 'in-a-node-record', taskId: 'node-readback', severity: 'minor', message: 'a minor finding' }],
            } as never);

            // The write must land and the guard must accept it: a minor finding may be deferred, and the read-back has to
            // see the new disposition rather than the history's copy.
            const written = await applyDisposition(root, 'node-readback', 'adversarial-review', 'in-a-node-record', {
                disposition: 'deferred',
                reason: 'not now',
                by: 'user',
                at: '2026-09-23T03:00:00.000Z',
            });
            expect(written).toBe(true);
            const tracked = await readTrackedFindings(root, 'node-readback');
            expect(tracked.find((finding) => finding.id === 'in-a-node-record')?.disposition).toBe('deferred');
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    }, 60000);
});
