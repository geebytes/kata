import { describe, expect, it } from 'vitest';
import { renderAdversarialBrief, compileReviewIr, issueAdversarialBrief, type AdversarialBriefInput } from '../../src/quality/adversarial.js';

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { adversarialBriefPath, initLayout } from '../../src/core/layout.js';
import { createTask } from '../../src/core/task.js';
import { createTaskRevision } from '../../src/workflow/revision.js';
/**
 * §3.3: the retrieval layer serves the **hypothesis**, not the file — and it starts by not paying for the same sentence
 * twice.
 *
 * Three measured defects from §1.1 are fixed here, as *consequences* of having one immutable review input rather than as
 * prose edits:
 *
 *   1. **The header contradicted the delta.** `Paths under review` listed the raw owned set (24 paths on one 909-character
 *      line) while the delta section named 6. A reviewer told "these 24 are under review" and "only these 6 changed"
 *      re-derives the 18 that did not — which is exactly the cost the delta exists to avoid, defeated at the top of the
 *      file.
 *   2. **The same finding was rendered twice in full.** Measured: `seal-persists-refused-owned-paths` appeared as 1,131
 *      characters under *Findings by class* and again as 1,095 under *This is a delta pass* — ~1,095 characters of pure
 *      duplication per round. Kata already stores findings once and renders a stable id; the id plus severity plus
 *      disposition is what a reader needs.
 *   3. **There was no single immutable input.** The Markdown brief was assembled field by field at render time, so what a
 *      caller read and what a reviewer was handed could differ. `ReviewIR` is compiled from the same source as the text,
 *      so the two cannot disagree — and it is the thing an executor is driven by.
 */
describe('§3.3 the review input is compiled once, and the brief stops paying twice', () => {
    const base: AdversarialBriefInput = {
        taskId: 'ir-task',
        node: 'verify',
        revisionId: 'revision-9',
        acceptance: [{ id: 'AC-1', statement: 'the thing holds' }],
        evidence: [],
        ownedPaths: ['src/a.ts', 'src/b.ts', 'src/c.ts', 'docs/note.md'],
        delta: {
            from: 'revision-8',
            changedPaths: ['src/a.ts', 'src/b.ts'],
            added: ['src/a.ts'],
            modified: ['src/b.ts'],
            removed: [],
        },
    };

    it('states the delta in the header instead of the raw owned set when the round is a delta', () => {
        const text = renderAdversarialBrief(base);

        // The header names what this pass is actually about.
        expect(text).toMatch(/Paths under review:.*src\/a\.ts/);
        expect(text).toMatch(/Paths under review:.*src\/b\.ts/);
        // …and does not open with a path the delta already excluded, which is the contradiction §1.1 measured.
        expect(text).not.toMatch(/Paths under review:.*docs\/note\.md/);
    });

    it('still names the whole owned set when the round is full, because then it is the truth', () => {
        const text = renderAdversarialBrief({ ...base, delta: undefined });

        expect(text).toMatch(/Paths under review:.*docs\/note\.md/);
    });

    it('renders a finding once and refers to it by id thereafter', () => {
        const text = renderAdversarialBrief({
            ...base,
            findingHistory: [{
                id: 'seal-persists-refused-owned-paths',
                class: 'durability',
                severity: 'major',
                message: 'the seal persists artefacts before rejecting an escaped owned path',
                // **Open**, because a repaired finding is now named by id only: its prose is not something the next pass
                // needs to read again, and carrying it was 29.5% of the brief measured on a real round. A fixed finding
                // here would make this case assert the old behaviour rather than the rule.
                disposition: 'open',
            }],
        });

        // The full message appears exactly once, not twice.
        const occurrences = text.split('the seal persists artefacts before rejecting an escaped owned path').length - 1;
        expect(occurrences).toBe(1);
        // And the id is what a reader follows for the rest.
        expect(text).toContain('seal-persists-refused-owned-paths');
    });

    it('compiles a Review IR from the same source as the text, so the two cannot disagree', () => {
        const text = renderAdversarialBrief(base);
        const ir = compileReviewIr(base);

        // Identity: the IR carries the same revision and criteria the text was rendered from.
        expect(ir.revisionId).toBe('revision-9');
        expect(ir.criteria).toEqual([{ id: 'AC-1', statement: 'the thing holds' }]);
        // Scope: the same set the header states.
        expect(ir.scope.kind).toBe('delta');
        expect(ir.scope.kind === 'delta' && ir.scope.changedPaths).toEqual(['src/a.ts', 'src/b.ts']);
        // Budget: the envelope is on the IR too, so an executor reads one object.
        expect(ir.budget.maxHypotheses).toBeGreaterThan(0);
        // And a stable hash, so a receipt can bind to this exact input.
        expect(ir.hash).toMatch(/^[0-9a-f]{64}$/);
        expect(text.length).toBeGreaterThan(0);
    });

    it('hashes the IR by content, so an unchanged input yields an unchanged hash', () => {
        const first = compileReviewIr(base);
        const second = compileReviewIr({ ...base, ownedPaths: [...base.ownedPaths] });

        expect(second.hash).toBe(first.hash);
        expect(compileReviewIr({ ...base, revisionId: 'revision-10' }).hash).not.toBe(first.hash);
    });

    it('persists the exact compiled IR with the issued brief, so an executor receives immutable input rather than a later re-render', async () => {
        const root = await mkdtemp(join(tmpdir(), 'kata-issued-ir-'));
        try {
            await initLayout(root);
            await createTask({ root, id: 'ir-issue', title: 'IR issue', ownedPaths: ['src/'], acceptance: [{ id: 'AC-1', statement: 'the input is persistent' }] });
            await mkdir(join(root, 'src'), { recursive: true });
            await writeFile(join(root, 'src/a.ts'), 'export const a = 1;\n', 'utf8');
            const revision = await createTaskRevision({ root, taskId: 'ir-issue', ownedPaths: ['src/a.ts'], checkIds: [] });
            const issued = await issueAdversarialBrief(root, 'ir-issue', 'verify');
            const stored = JSON.parse(await readFile(adversarialBriefPath(root, 'ir-issue', 'verify', revision.id), 'utf8')) as { briefs: Array<{ ir?: { hash?: string }; candidateFreeze?: { hash?: string }; runRequest?: { reviewIrSha256?: string; candidateFreezeSha256?: string; runId?: string } }> };
            expect(issued.ir.hash).toMatch(/^[0-9a-f]{64}$/);
            expect(issued.runRequest?.reviewIrSha256).toBe(issued.ir.hash);
            expect(issued.candidateFreeze.hash).toMatch(/^[0-9a-f]{64}$/);
            expect(issued.runRequest?.candidateFreezeSha256).toBe(issued.candidateFreeze.hash);
            expect(stored.briefs[0]?.candidateFreeze?.hash).toBe(issued.candidateFreeze.hash);
            expect(stored.briefs[0]?.runRequest?.candidateFreezeSha256).toBe(issued.candidateFreeze.hash);
            expect(stored.briefs[0]?.ir?.hash).toBe(issued.ir.hash);
            expect(stored.briefs[0]?.runRequest?.reviewIrSha256).toBe(issued.ir.hash);
            expect(stored.briefs[0]?.runRequest?.runId).toBe(issued.runRequest?.runId);
            // Re-reading/retrying an unchanged issue is not another review run: reuse the nonce instead of making
            // fresh-context capacity look available twice or charging the executor for a phantom run.
            const retried = await issueAdversarialBrief(root, 'ir-issue', 'verify');
            expect(retried.runRequest?.runId).toBe(issued.runRequest?.runId);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it('carries the acceptance contract — criteria, checks, selectors and assertions — even in a cold round', () => {
        // §1.3.4 item 1, the strongest single lever: the reviewer's most valuable question is "does this evidence actually
        // test this criterion", and a cold round currently cannot ask it — the criteria are withheld along with the
        // author's claims, so the reviewer reconstructs them from the diff first. Withholding the *requirements* is not
        // independence, it is an uninformed reviewer (a Fagan reviewer without the checklist).
        const text = renderAdversarialBrief({
            ...base,
            mode: 'cold',
            acceptanceContract: [{
                id: 'AC-1',
                statement: 'the thing holds',
                checks: [{
                    id: 'unit',
                    command: 'vitest',
                    selector: 'tests/unit/thing.test.ts',
                    asserts: 'the exported guard refuses an escaped path',
                }],
            }],
        });

        // The criterion text is present in a cold round…
        expect(text).toContain('the thing holds');
        // …together with the command that answers it, the selector it runs and what the assertion asserts.
        expect(text).toContain('vitest');
        expect(text).toContain('tests/unit/thing.test.ts');
        expect(text).toContain('the exported guard refuses an escaped path');
        // And it is labelled as the gate's own contract, not as an author claim — the distinction the cold round exists for.
        expect(text).toMatch(/acceptance contract|gate's own contract/i);
    });

    it('puts the same acceptance contract on the Review IR, so an executor receives the criteria rather than re-deriving them', () => {
        const ir = compileReviewIr({
            ...base,
            mode: 'cold',
            acceptanceContract: [{
                id: 'AC-1',
                statement: 'the thing holds',
                checks: [{ id: 'unit', command: 'vitest', selector: 'tests/unit/thing.test.ts', asserts: 'refuses an escaped path' }],
            }],
        });

        expect(ir.acceptanceContract).toEqual([{
            id: 'AC-1',
            statement: 'the thing holds',
            checks: [{ id: 'unit', command: 'vitest', selector: 'tests/unit/thing.test.ts', asserts: 'refuses an escaped path' }],
        }]);
        // Identity must cover it: an executor binds to the IR hash, so two different contracts cannot share one hash.
        const withoutContract = compileReviewIr({ ...base, mode: 'cold' });
        expect(ir.hash).not.toBe(withoutContract.hash);
    });
});
