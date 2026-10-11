import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initLayout, reviewPath, taskDir } from '../../src/core/layout.js';
import { createTask } from '../../src/core/task.js';
import { writeCurrentState } from '../../src/core/state.js';
import { appendClaim, restateClaim, writePlan, writePolicy } from '../../src/store/ledger.js';
import { runLedgerCommand } from '../../src/cli/ledger.js';
import { defaultPolicy } from '../../src/kernel/policy.js';
import { runCommand } from '../../src/workflow/orchestrator.js';
import { createTaskRevisionIfChanged } from '../../src/workflow/revision.js';
import { CometGuard } from '../../src/comet/guard.js';

/**
 * **A refusal has to name the road that works — and its claims about the mechanism have to be true.**
 *
 * Measured by replaying four historical rounds into one revision: the first was filed, the rest were refused with
 * *"A second round needs a different request: restate a claim … Re-entering review does not clear a recorded round, so it is
 * not offered as a remedy here."* Both halves were overtaken by this change — entering review **does** archive the record
 * standing now and open a new round, and that is the direct road for a second result over one revision. A refusal that
 * sends the operator down a road the mechanism no longer requires (and asserts something the mechanism contradicts) is the
 * defect this file exists to catch, and the positive control follows the printed remedy to prove it lands.
 */
const changeId = 'a-refusal-names-the-road-that-works';
let root: string;

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'kata-refusal-road-'));
    await initLayout(root);
    await createTask({ root, id: changeId, title: 'Refusal road', acceptance: [{ id: 'AC-1', statement: 'Filed.' }], ownedPaths: ['src/a.ts'] });
    await mkdir(join(root, 'src'), { recursive: true });
    await mkdir(join(root, 'tmp'), { recursive: true });
    await mkdir(join(root, '.kata', 'evidence'), { recursive: true });
    await writeFile(join(root, 'src', 'a.ts'), 'export const holds = true;\n');
    await writePolicy(root, changeId, defaultPolicy());
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
    // Through the real verbs, so the frozen subject carries the question — a hand-frozen subject leaves the request
    // underivable and the round cannot be recorded at all (the same trap measured in the sibling selector).
    expect((await ledgerJson(['plan', '--change', changeId])).ok).toBe(true);
    expect((await ledgerJson(['freeze', '--change', changeId])).ok).toBe(true);
    await writeCurrentState(root, { taskId: changeId, phase: 'hardVerify', actor: { id: 'kata-agent', role: 'implementer' }, updatedAt: '2026-10-11T00:00:00.000Z' });
});

afterEach(async () => {
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
});

async function ledgerJson(argv: string[]): Promise<{ ok?: boolean; error?: string; revision?: string }> {
    const chunks: string[] = [];
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
        chunks.push(String(chunk));
        return true;
    });
    const previousExitCode = process.exitCode;
    try {
        await runLedgerCommand(argv, { root, changeId });
    } finally {
        stdout.mockRestore();
        process.exitCode = previousExitCode;
    }
    const line = chunks.join('').trim().split('\n').filter((entry) => entry.trim().startsWith('{')).at(-1);
    return line ? (JSON.parse(line) as { ok?: boolean; error?: string; revision?: string }) : {};
}

async function seal(): Promise<void> {
    await createTaskRevisionIfChanged({ root, taskId: changeId, ownedPaths: ['src/a.ts'], checkIds: [] });
    const sealed = JSON.parse(await readFile(join(root, '.kata', 'tasks', changeId, 'current-revision.json'), 'utf8')) as { id: string };
    await writeFile(join(root, '.kata', 'evidence', `${changeId}-test.json`), `${JSON.stringify({
        id: 'evidence-1', taskId: changeId, checkId: 'check-1', checkSource: 'configured', name: 'test', kind: 'test',
        command: 'true', environment: 'test', exitCode: 0, passed: true, checkInput: 'a'.repeat(64), coveredAcceptanceIds: [],
        startedAt: '2026-10-11T00:00:00.000Z', finishedAt: '2026-10-11T00:00:01.000Z', diffHash: 'd'.repeat(64), log: '', logBytes: 0,
        revisionId: sealed.id,
    })}\n`);
}

async function record(id: string, file: string): Promise<{ success?: boolean; error?: string }> {
    await writeFile(join(root, 'tmp', file), `${JSON.stringify({
        findings: [{ id, taskId: changeId, severity: 'major', message: `${id} found something real.`, acceptanceId: 'AC-1', reproduction: { findingId: id, ranChecks: [], missingTest: true } }],
        declaredCoverage: ['C-1'],
    })}\n`);
    return runCommand('review', changeId, root, { reviewResultFile: `tmp/${file}` }) as Promise<{ success?: boolean; error?: string }>;
}

const historyRows = async (): Promise<Array<{ findings?: Array<{ id?: string }>; status?: string }>> =>
    (await readFile(join(taskDir(root, changeId), 'review-history.jsonl'), 'utf8')).trim().split('\n').filter(Boolean)
        .map((line) => JSON.parse(line) as { findings?: Array<{ id?: string }>; status?: string });

describe('a refusal names the road that works', () => {
    it('sends the operator to re-entering review, and no longer claims re-entry is inert', async () => {
        await seal();
        expect((await runCommand('review', changeId, root, { confirmHostModel: true })).success).toBe(true);
        expect((await record('F-1', 'round-1.json')).success).toBe(true);

        const second = await record('F-2', 'round-2.json');
        expect(second.success, 'a second result in one round is refused').toBe(false);
        const message = String(second.error);
        expect(message, 'the refused road must be named').toContain(`kata-cli review --change ${changeId}`);
        expect(message, 'and it must stop asserting the opposite of what the entry does')
            .not.toMatch(/does not clear a recorded round/i);
        // The remedy it does keep is the one for a *different* problem, and the message says so.
        expect(message).toMatch(/If the question itself is what should move/i);
    });

    it('names a road this state allows, and the named road actually lands', async () => {
        // **Two majors in two rounds, one shape**: the message named a road that refuses where it fires (`kata-cli archive`
        // cannot run from `review`; `build --seal` enters the repair entry and stops at `implement`). An independent round
        // also made the sharper point about the *selector*: asserting that the string appears certifies nothing, because a
        // road that refuses satisfies a presence check. So this case follows the named road and asserts where it lands.
        await seal();
        expect((await runCommand('review', changeId, root, { confirmHostModel: true })).success).toBe(true);
        expect((await record('F-1', 'round-1.json')).success).toBe(true);
        const recorded = JSON.parse(await readFile(reviewPath(root, changeId), 'utf8')) as Record<string, unknown>;
        await writeFile(reviewPath(root, changeId), `${JSON.stringify({ ...recorded, status: 'approved', reviewEvidence: 'accepted for this content' }, null, 2)}\n`);

        const second = await record('F-2', 'round-2.json');
        expect(second.success).toBe(false);
        const message = String(second.error);
        // The branch that fires is the accepted-record one, and it says what it will not do as well as what it will.
        expect(message, 'the accepted branch is the one that fires here').toContain('it was accepted');
        expect(message, 'the named road is the one this state allows').toContain('--result-file');
        expect(message, 'and the roads that refuse are named as refusing, not offered').toContain('do **not** work from this state');

        // **Follow it, literally.** Move the question (the road's first half), then record the result directly.
        await restateClaim(root, changeId, 'C-1', 'The export is present, and stays present.');
        expect((await ledgerJson(['freeze', '--change', changeId])).ok, 'the re-freeze the message names').toBe(true);
        const landed = await record('F-3', 'round-3.json');
        expect(landed.success, JSON.stringify(landed).slice(0, 240)).toBe(true);

        // And the acceptance was archived by that road — the fact the message and the design doc (B14) now state.
        const rows = await historyRows();
        expect(rows.map((row) => (row.findings ?? []).map((finding) => finding.id))).toEqual([['F-1']]);
        expect(rows[0]?.status, 'the accepted conclusion is archived, not erased').toBe('approved');
    });

    it('says what is true of the shape it actually fires for (a legacy record the entry does not accept)', async () => {
        // **R9-F1**: branch 4 fires for a *pending* legacy record too — one the entry does **not** treat as accepted — and
        // its absolute clause ("no verb available in this state clears that by itself") was false there: re-entry does clear
        // it. The branch now asks the entry's predicate and says what holds per shape; this case follows the pending one.
        await seal();
        expect((await runCommand('review', changeId, root, { confirmHostModel: true })).success).toBe(true);
        expect((await record('F-1', 'round-1.json')).success).toBe(true);
        const recorded = JSON.parse(await readFile(reviewPath(root, changeId), 'utf8')) as Record<string, unknown>;
        delete recorded.subjectRevision;
        await writeFile(reviewPath(root, changeId), `${JSON.stringify({ ...recorded, status: 'pending' }, null, 2)}\n`);

        const second = await record('F-2', 'round-2.json');
        expect(second.success).toBe(false);
        const message = String(second.error);
        expect(message, 'the pending shape is not an accepted conclusion').toContain('does not treat it as an accepted conclusion');
        expect(message, 'and the road for it is re-entry, not the repair entry').toContain(`kata-cli review --change ${changeId}`);
        // **Follow it**: re-entry archives the pending record and the new round lands.
        expect((await runCommand('review', changeId, root, { confirmHostModel: true })).success).toBe(true);
        expect((await record('F-3', 'round-3.json')).success, 'the road the message names must land').toBe(true);
        const rows = await historyRows();
        expect(rows.map((row) => (row.findings ?? []).map((finding) => finding.id))).toEqual([['F-1']]);
    });

    it('does not name a re-seal that does not happen from this state (an accepted legacy record)', async () => {
        // **R8-F1**: the branch for a record with no `subjectRevision` named `kata-cli build --seal` as the re-seal road —
        // while its sibling branch states, as a reason, that from `review` that command does not re-seal at all. Same
        // defect, one branch over. The text now names the route that exists (the repair entry) and says what the seal costs.
        await seal();
        expect((await runCommand('review', changeId, root, { confirmHostModel: true })).success).toBe(true);
        expect((await record('F-1', 'round-1.json')).success).toBe(true);
        const recorded = JSON.parse(await readFile(reviewPath(root, changeId), 'utf8')) as Record<string, unknown>;
        delete recorded.subjectRevision;
        // **The shape this case is about is the one the entry treats as accepted** — round 9 measured that a *pending*
        // legacy record has a different true road (re-entry, held by the next case), so this one carries the acceptance.
        await writeFile(reviewPath(root, changeId), `${JSON.stringify({ ...recorded, status: 'approved', reviewEvidence: 'accepted for this content' }, null, 2)}\n`);

        const second = await record('F-2', 'round-2.json');
        expect(second.success).toBe(false);
        const message = String(second.error);
        expect(message, 'a legacy record is the shape that fires').toContain('predates the request binding');
        expect(message, 'the route that exists is the repair entry').toContain(`kata-cli build --change ${changeId}`);
        expect(message, 'and the claim about `build --seal` from here is the measured one').toContain('does not re-seal');
        expect(message, 'the entry is named as the archiver').toContain('the entry archives the old record');
    });

    it('refuses before the guard runs, so an accepted record leaves no side effect', async () => {
        // **Why the prologue check is not a duplicate of the belt.** Both ask the same question, but the prologue asks it
        // *before* the caller-supplied guard runs: a guard with a side effect (here, a marker file) must not have run when
        // the record already stands accepted. Without that property the prologue would be a second copy of the belt for no
        // reason — which is exactly what the falsifier audit measured after the sequencing repair: disabling the prologue no
        // longer changed any outcome, because the belt caught the state anyway.
        await seal();
        expect((await runCommand('review', changeId, root, { confirmHostModel: true })).success).toBe(true);
        expect((await record('F-1', 'round-1.json')).success).toBe(true);
        const recorded = JSON.parse(await readFile(reviewPath(root, changeId), 'utf8')) as Record<string, unknown>;
        await writeFile(reviewPath(root, changeId), `${JSON.stringify({ ...recorded, status: 'approved', reviewEvidence: 'accepted for this content' }, null, 2)}\n`);

        const marker = join(root, 'tmp', 'guard-ran.txt');
        const guard = new CometGuard(async (action, _change, phase) => {
            if (action === 'check' && phase === 'review') await writeFile(marker, 'the guard ran\n');
            return { passed: true, phase };
        });

        const refused = await runCommand('review', changeId, root, { guard, confirmHostModel: true }) as { success?: boolean; error?: string };
        expect(refused.success, 'an accepted record stops the entry').toBe(false);
        expect(String(refused.error), 'with the accepted-record refusal').toContain('approved review record');
        const ran = await readFile(marker, 'utf8').catch(() => null);
        expect(ran, 'and the guard never ran, because the refusal is decided before it').toBe(null);
    });

    it('the in-lock belt names a road too, and a selector can reach it', async () => {
        // **R10-F1 falsified a boundary I had recorded**: I wrote that the belt's copy of the entry message "has no selector
        // that can observe it", and that is false — `options.guard` runs its `check` inside `cmdReview` **after** the
        // pre-transition refusal and **before** the lock, so a guard can accept the standing record on the way through and
        // the belt then fires where a reader can see it. A recorded boundary that is reachable, with an instrument that
        // covers only the other copy, is exactly the kind of claim this change exists to refuse.
        await seal();
        expect((await runCommand('review', changeId, root, { confirmHostModel: true })).success).toBe(true);
        expect((await record('F-1', 'round-1.json')).success).toBe(true);

        // The guard accepts the record mid-flight, after the pre-transition check has already passed.
        const guard = new CometGuard(async (action, _change, phase) => {
            if (action === 'check' && phase === 'review') {
                const standing = JSON.parse(await readFile(reviewPath(root, changeId), 'utf8')) as Record<string, unknown>;
                await writeFile(reviewPath(root, changeId), `${JSON.stringify({ ...standing, status: 'approved', reviewEvidence: 'accepted in flight' }, null, 2)}\n`);
            }
            return { passed: true, phase };
        });

        // **The entry path, not the result path**: the belt lives in the entry's lock callback, so the command that reaches
        // it is `review` without a result file (with one, the result path refuses first, with its own text).
        const stateBefore = await readFile(join(root, '.kata', 'tasks', changeId, 'current-state.json'));
        const belt = await runCommand('review', changeId, root, { guard, confirmHostModel: true }) as { success?: boolean; error?: string };
        expect(belt.success, 'the belt refuses when the record became accepted inside the lock').toBe(false);
        const message = String(belt.error);
        expect(message, 'and its text holds the same rule as the other copy').toContain('Archiving is not available from this state');
        expect(message, 'the belt copy must not offer the road that refuses either').not.toContain('or archive the change');
        // **And the refusal wrote nothing.** The move used to happen above this callback, so the belt's refusal left the
        // task in `review` — the invariant this entry asserts for its other copy, false on this path. Round 11's major was
        // exactly that, and it became reachable only once round 10 made this copy observable. The transition now runs
        // inside the same lock, after this check, so the state file is untouched.
        const stateAfter = await readFile(join(root, '.kata', 'tasks', changeId, 'current-state.json'));
        expect(stateAfter.equals(stateBefore), 'a refusal must not move the task, on either copy').toBe(true);
    });

    it('does not claim an acceptance the entry itself would not treat as one', async () => {
        // **R7-F1's shape**: `approved` **without** the evidence it was accepted with. Every reader calls that invalid
        // (`navigation.ts` answers `invalidReviewApproval`), the entry does *not* refuse re-entry over it — and a branch keyed
        // on the status alone therefore claimed an acceptance that does not exist and called re-entry refused when the entry
        // accepts it. The refusal and the entry now ask one predicate, and this case follows the road that answer implies.
        await seal();
        expect((await runCommand('review', changeId, root, { confirmHostModel: true })).success).toBe(true);
        expect((await record('F-1', 'round-1.json')).success).toBe(true);
        const recorded = JSON.parse(await readFile(reviewPath(root, changeId), 'utf8')) as Record<string, unknown>;
        await writeFile(reviewPath(root, changeId), `${JSON.stringify({ ...recorded, status: 'approved' }, null, 2)}\n`);

        const second = await record('F-2', 'round-2.json');
        expect(second.success).toBe(false);
        const message = String(second.error);
        expect(message, 'no acceptance exists in this shape').not.toContain('it was accepted');
        expect(message, 'and the entry does accept re-entry here, so the road is re-entry').toContain(`kata-cli review --change ${changeId}`);

        // **Follow it**: the entry succeeds, and the second round lands with the first archived.
        expect((await runCommand('review', changeId, root, { confirmHostModel: true })).success).toBe(true);
        expect((await record('F-3', 'round-3.json')).success, 'the road the message names must land').toBe(true);
        const rows = await historyRows();
        expect(rows.map((row) => (row.findings ?? []).map((finding) => finding.id))).toEqual([['F-1']]);
    });

    it('lands: following the printed remedy files the next round and archives the first', async () => {
        await seal();
        expect((await runCommand('review', changeId, root, { confirmHostModel: true })).success).toBe(true);
        expect((await record('F-1', 'round-1.json')).success).toBe(true);

        // **The remedy, followed literally**: enter review again.
        expect((await runCommand('review', changeId, root, { confirmHostModel: true })).success).toBe(true);
        expect((await record('F-2', 'round-2.json')).success).toBe(true);

        const rows = await historyRows();
        expect(rows.map((row) => (row.findings ?? []).map((finding) => finding.id))).toEqual([['F-1']]);
        const standing = JSON.parse(await readFile(reviewPath(root, changeId), 'utf8')) as { findings?: Array<{ id?: string }> };
        expect(standing.findings?.map((finding) => finding.id)).toEqual(['F-2']);
    });
});
