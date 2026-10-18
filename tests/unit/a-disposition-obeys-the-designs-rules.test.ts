import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { findingDispositionProblems } from '../../src/quality/finding-dispositions.js';
import { initLayout, reviewPath } from '../../src/core/layout.js';
import { writeCurrentState } from '../../src/core/state.js';
import { runCommand } from '../../src/workflow/orchestrator.js';
import { createTaskRevisionIfChanged } from '../../src/workflow/revision.js';
import { appendClaim, freezeSubject, writePlan } from '../../src/store/ledger.js';
import { writeTaskRecord } from '../helpers/task-fixture.js';

/**
 * **A disposition is a claim about a finding, and the rules for it were enforced by nothing.**
 *
 * `docs/design/2026-09-18-finding-lifecycle-and-proportional-reverification.md` §F1.3 states them: a `blocking`/`major`
 * finding **refuses both `defer` and `accept`** ("非 0 退出，消息指向必须修"), `minor`/`note` allow both, and `deferred`
 * requires a `reason`; §I1's own failure table repeats it ("用 `accept` 掩盖真缺陷 | `blocking`/`major` 拒绝 accept"). The
 * command that enforced it was `kata-cli findings defer|accept|carry`, removed with the route it belonged to — and the
 * result-file path that replaced it validates the *severity* and the *class* of each finding and never the disposition.
 *
 * The gap is not theoretical: `schemas/review-finding.schema.json` still documents the vocabulary, `isOpenFinding` reads
 * it, and a `blocking` finding could be filed `accepted` with no reason at all — the one shape §I1 names as "burying a real
 * defect with `accept`". These cases are the rules, asked of the one function that answers them.
 */
describe('the rules a finding disposition has to obey', () => {
    const finding = (overrides: Record<string, unknown>): Record<string, unknown> => ({
        id: 'F-1',
        taskId: 'the-change',
        severity: 'minor',
        message: 'something',
        ...overrides,
    });

    it('leaves an undisposed finding alone: absent means open, which is the schema`s own reading', () => {
        expect(findingDispositionProblems([finding({})])).toEqual([]);
        expect(findingDispositionProblems([finding({ disposition: 'open' })])).toEqual([]);
        // `fixed` is the closing value and needs no explanation: the round says it repaired it.
        expect(findingDispositionProblems([finding({ disposition: 'fixed' })])).toEqual([]);
    });

    it('refuses to defer or accept a finding that blocks the merge', () => {
        // The design's I1: both values are refused for these severities, and the refusal has to name the way out.
        for (const severity of ['blocking', 'major']) {
            for (const disposition of ['deferred', 'accepted']) {
                const problems = findingDispositionProblems([finding({ severity, disposition, dispositionReason: 'we ran out of time' })]);
                expect(problems.length, `${severity}/${disposition} must be refused`).toBe(1);
                expect(problems[0]).toContain('F-1');
                expect(problems[0]).toContain(severity);
                expect(problems[0]).toContain('must be repaired');
                // The reason does not unlock it: this is not a missing-explanation problem.
                expect(problems[0]).not.toContain('dispositionReason');
            }
        }
    });

    it('requires a reason for every value that leaves the problem in place', () => {
        for (const disposition of ['deferred', 'accepted', 'routed']) {
            const problems = findingDispositionProblems([finding({ disposition })]);
            expect(problems.length, `${disposition} without a reason must be refused`).toBe(1);
            expect(problems[0]).toContain('dispositionReason');
            // A blank reason is not a reason: the field exists so a reader can answer "why is this still here".
            expect(findingDispositionProblems([finding({ disposition, dispositionReason: '   ' })]).length).toBe(1);
            expect(findingDispositionProblems([finding({ disposition, dispositionReason: 'because the boundary is declared elsewhere' })])).toEqual([]);
        }
    });

    it('refuses a value outside the vocabulary, naming the word rather than the list', () => {
        const problems = findingDispositionProblems([finding({ disposition: 'wontfix' })]);
        expect(problems.length).toBe(1);
        expect(problems[0]).toContain('wontfix');
    });

    it('reports every problem it finds, not only the first', () => {
        const problems = findingDispositionProblems([
            finding({ id: 'F-1', severity: 'major', disposition: 'accepted' }),
            finding({ id: 'F-2', severity: 'minor', disposition: 'deferred' }),
            finding({ id: 'F-3', disposition: 'fixed' }),
        ]);
        expect(problems.length).toBe(2);
        expect(problems.join(' | ')).toContain('F-1');
        expect(problems.join(' | ')).toContain('F-2');
    });

    it('reads the vocabulary from the one place that owns it', async () => {
        const { DISPOSITIONS, CLOSING_DISPOSITIONS } = await import('../../src/quality/review-ladder.js');
        // Not a second list: the values the validator accepts are the values the ladder reads, and the closing value is the
        // ladder's own. A second copy is how one lifecycle field acquires two readings.
        expect(DISPOSITIONS).toContain('routed');
        expect(CLOSING_DISPOSITIONS).toEqual(['fixed']);
        for (const disposition of DISPOSITIONS) {
            const problems = findingDispositionProblems([finding({ disposition, dispositionReason: 'a reason long enough to count' })]);
            // Only the two merge-blocking severities refuse a value outright; every other value is accepted *with* a reason.
            expect(problems.filter((problem) => problem.includes('must be repaired')), `${disposition} should not be refused outright for a minor finding`).toEqual([]);
        }
    });
});

/**
 * And the rule is **gated**, not merely defined: the path a finding enters the repository through must refuse the payload.
 *
 * The distinction matters here more than usual — a validator nobody calls is the shape this repository keeps finding, and
 * this rule already spent a year as documentation with no enforcement (the command that enforced it was removed with its
 * route). These cases drive the entry itself, so deleting the wiring reddens them.
 */
describe('the review entry refuses a payload that breaks them', () => {
    const taskId = 'disposition-rules';
    const roots: string[] = [];
    afterEach(async () => {
        await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
    });

    async function seeded(): Promise<string> {
        const root = await mkdtemp(join(tmpdir(), 'kata-disposition-rules-'));
        roots.push(root);
        await initLayout(root);
        await mkdir(join(root, 'src'), { recursive: true });
        await writeFile(join(root, 'src', 'thing.ts'), 'export const holds = true;\n');
        // The task directory has to exist before the record is written into it, which is the one thing the helper does not do.
        await mkdir(join(root, '.kata', 'tasks', taskId), { recursive: true });
        await writeTaskRecord(root, {
            id: taskId, phase: 'review', title: 'Disposition rules',
            acceptance: [{ id: 'AC-1', statement: 'x' }], ownedPaths: ['src/thing.ts'],
        });
        await appendClaim(root, taskId, {
            id: 'C1', statement: 'the claim this round answers', riskClass: 'consistency', severity: 'major',
            dependsOn: ['path:src/thing.ts'], evidenceIds: [], challengeIds: [], status: 'open',
            at: '2026-10-18T00:00:00.000Z', reopens: 0,
        });
        const frozen = await freezeSubject({ root, paths: ['src/thing.ts'] });
        expect(frozen.ok).toBe(true);
        await writePlan(root, taskId, {
            tier: 'strict',
            readingSets: [{ claimId: 'C1', paths: ['src/thing.ts'], truncated: false }],
            requiredEvidence: [{ claimId: 'C1', types: [], minimumStrength: 0 }],
            discovery: { deadlineToolCalls: null },
        });
        await createTaskRevisionIfChanged({ root, taskId, ownedPaths: ['src/thing.ts'], checkIds: [] });
        await writeCurrentState(root, {
            taskId, phase: 'review', actor: { id: 'kata-reviewer', role: 'reviewer' }, updatedAt: '2026-10-18T00:00:00.000Z',
        });
        return root;
    }

    async function record(root: string, findings: unknown[], name: string): Promise<{ success: boolean; error?: string }> {
        await mkdir(join(root, 'tmp'), { recursive: true });
        await writeFile(join(root, 'tmp', name), `${JSON.stringify({ findings, declaredCoverage: ['C1'] })}\n`);
        const result = await runCommand('review', taskId, root, { reviewResultFile: `tmp/${name}` });
        return { success: result.success, error: result.error };
    }

    const finding = (overrides: Record<string, unknown>): Record<string, unknown> => ({
        id: 'F-1', taskId, severity: 'minor', message: 'something', class: 'instrument-unsound', ...overrides,
    });

    it('refuses a merge-blocking finding disposed away, and writes no record', async () => {
        const root = await seeded();
        const refused = await record(root, [finding({ severity: 'major', disposition: 'accepted', dispositionReason: 'ran out of time' })], 'accepted-major.json');

        expect(refused.success, JSON.stringify(refused)).toBe(false);
        expect(String(refused.error)).toContain('disposition rules');
        expect(String(refused.error)).toContain('must be repaired');
        // Nothing was filed: the round is refused, not recorded with a caveat.
        await expect(readFile(reviewPath(root, taskId), 'utf8')).rejects.toThrow();
    });

    it('refuses a disposition with no reason, and files the same finding once the reason is there', async () => {
        const root = await seeded();
        const refused = await record(root, [finding({ disposition: 'deferred' })], 'deferred-no-reason.json');
        expect(refused.success).toBe(false);
        expect(String(refused.error)).toContain('dispositionReason');

        const accepted = await record(root, [finding({ disposition: 'deferred', dispositionReason: 'the declared boundary covers it elsewhere' })], 'deferred-with-reason.json');
        expect(accepted.error, JSON.stringify(accepted)).toBeUndefined();
        expect(accepted.success).toBe(true);
        const review = JSON.parse(await readFile(reviewPath(root, taskId), 'utf8')) as { findings: Array<Record<string, unknown>> };
        expect(review.findings[0]?.disposition).toBe('deferred');
    });
});
