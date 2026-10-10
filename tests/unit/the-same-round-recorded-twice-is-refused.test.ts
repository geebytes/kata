import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initLayout, reviewPath, taskDir } from '../../src/core/layout.js';
import { createTask } from '../../src/core/task.js';
import { writeCurrentState } from '../../src/core/state.js';
import { appendClaim, freezeSubject, writePlan, writePolicy, writeSubject } from '../../src/store/ledger.js';
import { defaultPolicy } from '../../src/kernel/policy.js';
import { runCommand } from '../../src/workflow/orchestrator.js';
import { createTaskRevisionIfChanged } from '../../src/workflow/revision.js';

/**
 * **Only the same round is refused, and the refusal says which state it is.**
 *
 * Two things are refused and nothing else: recording the *same* round twice (a conclusion recorded twice is not a second
 * conclusion), and entering review over an **approved** record (an accepted conclusion is not displaced by looking again).
 * Everything else — a second round over one revision, content that moved, a request that moved — is a *replacement*, and the
 * replaced round is archived rather than refused.
 *
 * Before this contract, "a result is already recorded for this revision, for this request" was the answer to all of them,
 * and the way out was to move the question: measured on a real change, where recording round 10 required restating a claim
 * for no reason other than to open the slot.
 */
const changeId = 'only-the-same-round-refused';
let root: string;

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'kata-same-round-'));
    await initLayout(root);
    await createTask({ root, id: changeId, title: 'Same round', acceptance: [{ id: 'AC-1', statement: 'Refused.' }], ownedPaths: ['src/a.ts'] });
    await mkdir(join(root, 'src'), { recursive: true });
    await mkdir(join(root, 'tmp'), { recursive: true });
    await mkdir(join(root, '.kata', 'evidence'), { recursive: true });
    await writeFile(join(root, 'src', 'a.ts'), 'export const holds = true;\n');
    await writePolicy(root, changeId, defaultPolicy());
    const frozen = await freezeSubject({ root, paths: ['src/a.ts'] });
    if (!frozen.ok) throw new Error(frozen.error);
    await writeSubject(root, changeId, frozen.subject);
    await appendClaim(root, changeId, {
        id: 'C-1', statement: 'The export is present.', riskClass: 'consistency', severity: 'major',
        dependsOn: ['path:src/a.ts'], evidenceIds: [], challengeIds: [], status: 'open', at: '2026-10-11T00:00:00.000Z', reopens: 0,
    });
    await writePlan(root, changeId, {
        tier: 'strict',
        readingSets: [{ claimId: 'C-1', paths: ['src/a.ts'], truncated: false }],
        requiredEvidence: [{ claimId: 'C-1', types: [], minimumStrength: 0 }],
        discovery: { deadlineToolCalls: null },
    });
    await writeCurrentState(root, { taskId: changeId, phase: 'hardVerify', actor: { id: 'kata-agent', role: 'implementer' }, updatedAt: '2026-10-11T00:00:00.000Z' });
    await createTaskRevisionIfChanged({ root, taskId: changeId, ownedPaths: ['src/a.ts'], checkIds: [] });
    const sealed = JSON.parse(await readFile(join(root, '.kata', 'tasks', changeId, 'current-revision.json'), 'utf8')) as { id: string };
    await writeFile(join(root, '.kata', 'evidence', `${changeId}-test.json`), `${JSON.stringify({
        id: 'evidence-1', taskId: changeId, checkId: 'check-1', checkSource: 'configured', name: 'test', kind: 'test',
        command: 'true', environment: 'test', exitCode: 0, passed: true, checkInput: 'a'.repeat(64), coveredAcceptanceIds: [],
        startedAt: '2026-10-11T00:00:00.000Z', finishedAt: '2026-10-11T00:00:01.000Z', diffHash: 'd'.repeat(64), log: '', logBytes: 0,
        revisionId: sealed.id,
    })}\n`);
});

afterEach(async () => {
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
});

async function record(id: string, file: string): Promise<{ success?: boolean; error?: string }> {
    await writeFile(join(root, 'tmp', file), `${JSON.stringify({
        findings: [{ id, taskId: changeId, severity: 'major', message: `${id} found something real.`, acceptanceId: 'AC-1', reproduction: { findingId: id, ranChecks: [], missingTest: true } }],
        declaredCoverage: ['C-1'],
    })}\n`);
    return runCommand('review', changeId, root, { reviewResultFile: `tmp/${file}` }) as Promise<{ success?: boolean; error?: string }>;
}

describe('only the same round is refused', () => {
    it('refuses the same round recorded twice, without opening a round in between', async () => {
        expect((await runCommand('review', changeId, root, { confirmHostModel: true })).success).toBe(true);
        expect((await record('F-1', 'round-1.json')).success).toBe(true);
        // No second entry: the same round is being recorded again, which is the one case a refusal is for.
        const again = await record('F-1', 'round-1.json');
        expect(again.success).toBe(false);
        expect(again.error, JSON.stringify(again).slice(0, 200)).toContain('already recorded');
        // The refusal names the state it is in, so its remedy is not a guess.
        expect(again.error).toMatch(/this revision, for this request/);
    });

    it('does not refuse a second round once the entry has opened one', async () => {
        expect((await runCommand('review', changeId, root, { confirmHostModel: true })).success).toBe(true);
        expect((await record('F-1', 'round-1.json')).success).toBe(true);
        expect((await runCommand('review', changeId, root, { confirmHostModel: true })).success).toBe(true);
        const second = await record('F-2', 'round-2.json');
        expect(second.success, JSON.stringify(second).slice(0, 200)).toBe(true);
    });

    it('refuses to enter review over an approved round that reported nothing', async () => {
        // **The clean-pass shape, and the one the two predicates disagreed about.** A round that finds nothing is recorded
        // with `findings: []` and `reviewRoute: 'adversarial'` — a recorded round, not a placeholder — and the gate can
        // accept it. The pre-transition check once required a non-empty finding list while the belt asked "is this an
        // accepted record", so that record alone still moved the task when review was re-entered (measured by an independent
        // round). An empty round is not the same as no round: `reviewRoute` is what tells them apart.
        expect((await runCommand('review', changeId, root, { confirmHostModel: true })).success).toBe(true);
        await writeFile(join(root, 'tmp', 'clean.json'), `${JSON.stringify({ findings: [], declaredCoverage: ['C-1'] })}\n`);
        expect((await runCommand('review', changeId, root, { reviewResultFile: 'tmp/clean.json' })).success).toBe(true);
        const recorded = JSON.parse(await readFile(reviewPath(root, changeId), 'utf8')) as Record<string, unknown>;
        expect(recorded.reviewRoute, 'a round that reported nothing is still a round').toBe('adversarial');
        await writeFile(reviewPath(root, changeId), `${JSON.stringify({ ...recorded, status: 'approved', reviewEvidence: 'a clean pass: nothing to repair and the ledger passes' }, null, 2)}\n`);
        await writeCurrentState(root, { taskId: changeId, phase: 'hardVerify', actor: { id: 'kata-agent', role: 'implementer' }, updatedAt: '2026-10-11T00:00:00.000Z' });
        const stateFile = join(root, '.kata', 'tasks', changeId, 'current-state.json');
        const before = await readFile(stateFile, 'utf8');

        const reentry = await runCommand('review', changeId, root, { confirmHostModel: true });
        expect(reentry.success, JSON.stringify(reentry).slice(0, 220)).toBe(false);
        expect(reentry.error).toMatch(/approved review record/);
        expect(await readFile(stateFile, 'utf8'), 'a refused entry must not move the task').toBe(before);
    });

    it('lets a change that was approved and then repaired be reviewed again', async () => {
        // **The deadlock an earlier version created**: the refusal was revision-blind, so an approved record refused
        // re-entry even after the content had moved and been re-sealed — and its own printed remedy ("change the content")
        // was inert, because the only transition into `review` sat below the refusal (measured by an independent round).
        // An acceptance answers the content it was recorded against; once that content is gone, the entry may proceed and
        // the record is archived on the way in.
        expect((await runCommand('review', changeId, root, { confirmHostModel: true })).success).toBe(true);
        expect((await record('F-1', 'round-1.json')).success).toBe(true);
        const recorded = JSON.parse(await readFile(reviewPath(root, changeId), 'utf8')) as Record<string, unknown>;
        await writeFile(reviewPath(root, changeId), `${JSON.stringify({ ...recorded, status: 'approved', reviewEvidence: 'accepted for this content' }, null, 2)}\n`);

        // The repair: content moves, the change is re-sealed.
        await writeFile(join(root, 'src', 'a.ts'), 'export const holds = false;\n');
        await createTaskRevisionIfChanged({ root, taskId: changeId, ownedPaths: ['src/a.ts'], checkIds: [] });

        const reentry = await runCommand('review', changeId, root, { confirmHostModel: true });
        expect(reentry.success, JSON.stringify(reentry).slice(0, 240)).toBe(true);
        // And the acceptance is moved into the history rather than erased: the round it described stays readable.
        const rows = (await readFile(join(taskDir(root, changeId), 'review-history.jsonl'), 'utf8')).trim().split('\n').filter(Boolean)
            .map((line) => JSON.parse(line) as { findings?: Array<{ id?: string }>; status?: string });
        expect(rows.map((row) => (row.findings ?? []).map((finding) => finding.id))).toEqual([['F-1']]);
        expect(rows[0]?.status).toBe('approved');
    });

    it('does not refuse an approved record the router itself calls invalid', async () => {
        // **Two readers of one word.** `navigation.ts` reads an approved record with no `reviewEvidence` as
        // `invalidReviewApproval` and tells the operator to re-run `/kata-review`; the entry's earlier predicate called that
        // same record accepted and refused — so following the router's advice hit a wall (measured by an independent round).
        // One reading now: an approval carries the evidence it was accepted with, and one that does not is not accepted.
        expect((await runCommand('review', changeId, root, { confirmHostModel: true })).success).toBe(true);
        expect((await record('F-1', 'round-1.json')).success).toBe(true);
        const recorded = JSON.parse(await readFile(reviewPath(root, changeId), 'utf8')) as Record<string, unknown>;
        await writeFile(reviewPath(root, changeId), `${JSON.stringify({ ...recorded, status: 'approved' }, null, 2)}\n`);

        const reentry = await runCommand('review', changeId, root, { confirmHostModel: true });
        expect(reentry.success, JSON.stringify(reentry).slice(0, 240)).toBe(true);
    });

    it('refuses an approved record the product would not mint, because every other reader calls it approved', async () => {
        // The placeholder shape with `status: 'approved'` is not a state any writer produces — but `navigation.ts`, the
        // judge, archive and `recordsAConclusion` all ask only "approved, with the evidence it was accepted with", so the
        // entry asks the same question rather than a fourth one (measured by an independent round: a clause nothing
        // exercised and no sibling reader shared).
        expect((await runCommand('review', changeId, root, { confirmHostModel: true })).success).toBe(true);
        const placeholder = JSON.parse(await readFile(reviewPath(root, changeId), 'utf8')) as Record<string, unknown>;
        await writeFile(reviewPath(root, changeId), `${JSON.stringify({ ...placeholder, status: 'approved', reviewEvidence: 'approved' }, null, 2)}\n`);

        const reentry = await runCommand('review', changeId, root, { confirmHostModel: true });
        expect(reentry.success, JSON.stringify(reentry).slice(0, 240)).toBe(false);
        expect(reentry.error).toMatch(/approved review record/);
    });

    it('refuses to enter review over an approved record, and says what to do instead', async () => {
        expect((await runCommand('review', changeId, root, { confirmHostModel: true })).success).toBe(true);
        expect((await record('F-1', 'round-1.json')).success).toBe(true);
        // The gate accepts the conclusion: the record becomes the accepted answer for this content. The *state* is staged
        // rather than driven, because driving the approval needs a passing ledger (which is a property of the ledger, not of
        // this case) — and this case is about what the entry does when the record it finds is approved.
        const recorded = JSON.parse(await readFile(reviewPath(root, changeId), 'utf8')) as Record<string, unknown>;
        // **A real approval carries the evidence it was accepted with** — `review --approve --review-evidence` writes it,
        // and the router reads an approved record without it as `invalidReviewApproval`. Staging the status alone made the
        // fixture a state the product does not produce (measured while aligning the two readers).
        await writeFile(reviewPath(root, changeId), `${JSON.stringify({ ...recorded, status: 'approved', reviewEvidence: 'the round found one major and the ledger passes' }, null, 2)}\n`);
        const record1 = JSON.parse(await readFile(reviewPath(root, changeId), 'utf8')) as { status?: string };
        expect(record1.status).toBe('approved');

        // **Nothing moves on a refusal** (R1-F3): the state the entry would have transitioned is read before and after, and
        // it is byte-identical — the guard used to run after the transition, so the refusal was emitted with the task already
        // re-entered (measured by the round that found it).
        // The phase is staged back to `hardVerify` so a transition would be *visible*: with the task already in `review`,
        // re-entering writes the same phase and the assertion below could not tell a moved state from an unmoved one — the
        // first version of this case was green under the mutation for exactly that reason (measured while re-aiming E5).
        await writeCurrentState(root, { taskId: changeId, phase: 'hardVerify', actor: { id: 'kata-agent', role: 'implementer' }, updatedAt: '2026-10-11T00:00:00.000Z' });
        const stateFile = join(root, '.kata', 'tasks', changeId, 'current-state.json');
        const beforeRefusal = await readFile(stateFile, 'utf8');
        const reentry = await runCommand('review', changeId, root, { confirmHostModel: true });
        expect(reentry.success, JSON.stringify(reentry).slice(0, 220)).toBe(false);
        expect(reentry.error).toMatch(/approved review record/);
        expect(await readFile(stateFile, 'utf8'), 'a refused entry must not move the task').toBe(beforeRefusal);
        // And the accepted conclusion is still where it was: the refusal writes nothing.
        const record2 = JSON.parse(await readFile(reviewPath(root, changeId), 'utf8')) as { status?: string; findings?: Array<{ id?: string }> };
        expect(record2.status).toBe('approved');
        expect(record2.findings?.map((finding) => finding.id)).toEqual(['F-1']);
    });
});
