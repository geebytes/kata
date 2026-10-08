import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCommand } from '../../src/workflow/orchestrator.js';
import { readLedger } from '../../src/store/ledger.js';
import { createTaskRevisionIfChanged } from '../../src/workflow/revision.js';
import { currentStatePath, reviewPath, taskDir } from '../../src/core/layout.js';

/**
 * **A review record answers a request, and the request is not the revision.**
 *
 * Measured in another checkout: a round's result was recorded for a revision; the ledger's claims were then restated, so the
 * next round answered a *different* question while the code — and therefore the sealed revision — stood still. Recording that
 * second round was refused, because the record's binding is content identity only (`revisionId`, the manifest hashes, the
 * frozen candidate) and the request it answered was nowhere in it.
 *
 * This guard pins the half that releases a blocked round: a record that answered **another** request does not block the
 * answer to this one. The same-request refusal and its remedy live in `the-refusal-names-the-reachable-remedy.test.ts`,
 * because two criteria that name one test file collapse into one check and one of them then has no evidence.
 */
const NOW = '2026-10-08T00:00:00.000Z';
const taskId = 'record-answers-a-request';
const roots: string[] = [];
let root: string;
/** The workspace the CLI resolves, restored after each case — the result file must live inside it. */
const originalCwd = process.cwd();

afterEach(async () => {
    process.chdir(originalCwd);
    await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'kata-record-request-'));
    roots.push(root);
    // `--result-file` is resolved against the workspace, so the fixture *is* the workspace for this case.
    process.chdir(root);
    await mkdir(join(root, '.kata', 'tasks', taskId, 'review'), { recursive: true });
    await writeFile(join(root, 'subject.ts'), 'export const version = 1;\n');
    await writeFile(
        join(root, '.kata', 'tasks', taskId, 'task.json'),
        `${JSON.stringify({ id: taskId, title: 'T', acceptance: [{ id: 'AC-1', statement: 'x' }], ownedPaths: ['subject.ts'], createdAt: NOW, updatedAt: NOW })}\n`,
    );
    await writeFile(
        currentStatePath(root, taskId),
        `${JSON.stringify({ taskId, phase: 'review', actor: { id: 'fixture', role: 'reviewer' }, updatedAt: NOW })}\n`,
    );
});

/** A frozen ledger subject, which is what the review request is derived from. */
async function freezeSubject(revision: string): Promise<void> {
    await writeFile(
        join(taskDir(root, taskId), 'review', 'subject.json'),
        // The shape the review-subject schema declares: a revision and its path digests.
        `${JSON.stringify({ revision, pathDigests: { 'subject.ts': 'a'.repeat(64) }, declaredPaths: ['subject.ts'] })}\n`,
    );
    // The declaration in the result has to name claims the ledger holds, so the fixture holds one.
    await writeFile(
        join(taskDir(root, taskId), 'review', 'claims.json'),
        `${JSON.stringify([{ id: 'C1', statement: 's', riskClass: 'consistency', severity: 'major', dependsOn: ['path:subject.ts'], evidenceIds: [], challengeIds: [], status: 'open', at: NOW, reopens: 0 }])}\n`,
    );
}

/** A frozen subject with the digests the case wants, which is what a partial-change comparison needs. */
async function freezeSubjectWith(revision: string, pathDigests: Record<string, string>): Promise<void> {
    await writeFile(
        join(taskDir(root, taskId), 'review', 'subject.json'),
        `${JSON.stringify({ revision, pathDigests, declaredPaths: Object.keys(pathDigests) })}\n`,
    );
}

async function recordedRound(subjectRevision?: string): Promise<string> {
    const { revision } = await createTaskRevisionIfChanged({ root, taskId, ownedPaths: ['subject.ts'], checkIds: [] });
    await writeFile(
        reviewPath(root, taskId),
        `${JSON.stringify({
            revisionId: revision.id,
            manifestHash: revision.manifestHash,
            ...(subjectRevision ? { subjectRevision } : {}),
            findings: [{ id: 'R8-F1', taskId, acceptanceId: 'AC-1', severity: 'minor', path: 'subject.ts', message: 'm' }],
            status: 'pending',
            reviewRoute: 'adversarial',
        }, null, 2)}\n`,
    );
    return revision.id;
}

const RESULT = { taskId, status: 'pending', declaredCoverage: ['C1'], findings: [{ id: 'R9-F1', taskId, acceptanceId: 'AC-1', severity: 'major', path: 'subject.ts', message: 'm' }] };

async function writeResultFile(): Promise<string> {
    // Written at the fixture root and named **relative**, because the CLI resolves the flag against the workspace and
    // refuses a path outside it.
    await writeFile(join(root, 'result.json'), `${JSON.stringify(RESULT, null, 2)}\n`);
    return 'result.json';
}

describe('the question is part of the subject, not only the content', () => {
    it('changes the subject when a claim is restated, so a recorded result stops speaking for this request', async () => {
        // **The real chain, not a hand-written subject.** The first fixture in this file wrote `subject.json` itself, with a
        // revision inconsistent with its own digests, which bypassed the freeze chain and hid the defect an independent
        // round then reproduced: `subjectRevision` was `rev:<digest of path digests>`, so restating a claim — the reported
        // case, where the question changes and the code does not — left the subject identical and the second recording
        // refused. This case drives the same chain the CLI does.
        const { appendClaim, freezeSubject, restateClaim, writeSubject, readLedger } = await import('../../src/store/ledger.js');

        await appendClaim(root, taskId, {
            id: 'C1', statement: 'the first question', riskClass: 'consistency', severity: 'major',
            dependsOn: ['path:subject.ts'], evidenceIds: [], challengeIds: [], status: 'open', at: NOW, reopens: 0,
        });
        const frozen = await freezeSubject({ root, paths: ['subject.ts'], claims: (await readLedger(root, taskId)).claims });
        expect(frozen.ok).toBe(true);
        if (frozen.ok) await writeSubject(root, taskId, frozen.subject);
        const before = (await readLedger(root, taskId)).subjectAsDeclared?.revision;

        await restateClaim(root, taskId, 'C1', 'a different question about the same content');
        const after = (await readLedger(root, taskId)).subjectAsDeclared?.revision;

        // The content did not move; the question did. A subject that answers only "which content" cannot tell the two apart.
        expect(after).not.toBe(before);
    });
});

describe('the record answers the request it was made for', () => {
    it('lets a round be recorded when the recorded result answered another subject', async () => {
        await recordedRound('rev:aaaa00000000aaaa');
        await freezeSubject('rev:bbbb11111111bbbb');

        const recorded = await runCommand('review', taskId, root, { reviewResultFile: await writeResultFile() });
        expect(recorded.success, String(recorded.error)).toBe(true);
        const record = JSON.parse(await readFile(reviewPath(root, taskId), 'utf8')) as { findings?: Array<{ id?: string }>; subjectRevision?: string };
        expect(record.findings?.map((finding) => finding.id)).toEqual(['R9-F1']);
        // The replacement names the request it answered, so the next round can tell the same way.
        // The recorded request is the subject as declared now: the fixture's own revision is a hand-written value,
        // while the record carries what the ledger derives from the frozen digests and the current claims.
        expect(record.subjectRevision).toBe((await readLedger(root, taskId)).subjectAsDeclared?.revision);
        // And the conclusion it replaced is kept, named, where history is kept: AC-1 forbids a silent replacement, and an
        // independent round measured exactly that (`release success=true | history rows=0`) before this was written.
        const history = JSON.parse(
            (await readFile(join(taskDir(root, taskId), 'review-history.jsonl'), 'utf8')).trim().split('\n').at(-1) ?? '{}',
        ) as { findings?: Array<{ id?: string }>; supersededBy?: string };
        expect(history.findings?.map((finding) => finding.id)).toEqual(['R8-F1']);
        expect(history.supersededBy).toBe(record.subjectRevision);
    });

    it('keeps blocking when the record predates the subject binding, because we cannot know what it answered', async () => {
        await recordedRound();
        await freezeSubject('rev:bbbb11111111bbbb');

        const recorded = await runCommand('review', taskId, root, { reviewResultFile: await writeResultFile() });
        expect(recorded.success).toBe(false);
        expect(String(recorded.error)).toContain('already recorded');
    });
});

describe('the question-bearing identity settles', () => {
    it('does not move on a second freeze, so a record cannot be released by freezing repeatedly', async () => {
        // An independent round found that in the questionless state the printed remedy (re-freeze) releases a same-question
        // record, because the identity genuinely moves once when the subject learns to carry the question. That transition is
        // intended — and it must be **once**: if a freeze kept moving the identity, "re-freeze" would be a way to discard a
        // recorded round at will.
        const { appendClaim, freezeSubject: freezeThroughStore, writeSubject, planDigestOf, readLedger: read } = await import('../../src/store/ledger.js');
        await appendClaim(root, taskId, {
            id: 'C1', statement: 'the question', riskClass: 'consistency', severity: 'major',
            dependsOn: ['path:subject.ts'], evidenceIds: [], challengeIds: [], status: 'open', at: NOW, reopens: 0,
        });
        const freezeOnce = async () => {
            const frozen = await freezeThroughStore({ root, paths: ['subject.ts'], claims: (await read(root, taskId)).claims, planDigest: await planDigestOf(root, taskId) });
            if (frozen.ok) await writeSubject(root, taskId, frozen.subject);
            return (await read(root, taskId)).subjectAsDeclared?.revision;
        };
        const first = await freezeOnce();
        const second = await freezeOnce();
        expect(second).toBe(first);
    });
});

describe('the plan does not depend on the frozen snapshot', () => {
    it('plans the same thing whatever the frozen subject says', async () => {
        // **The frozen subject carries the identity, so the plan must not be measured against it.** Comparing against it made
        // the plan a function of a snapshot the plan itself moves: with several declared paths, a partial edit followed by a
        // bare re-plan moved plan.json and therefore the declared subject (rev:c1a8fc622c9f44c1 → rev:ddd1bdda07ff9f30),
        // releasing a recorded round that answered the current question — measured by an independent round. The comparison is
        // now against the sealed revision's content, which freezing does not move.
        //
        // The fixture declares **two** paths and makes the frozen subject disagree about exactly one of them: with a single
        // path the changed subset always equals the whole set and the guard is blind to the difference (the same blindness
        // that let the previous two rounds through).
        const { runLedgerCommand } = await import('../../src/cli/ledger.js');
        const { readPlanState } = await import('../../src/store/ledger.js');
        const { createTaskRevisionIfChanged, readCurrentTaskRevisionState } = await import('../../src/workflow/revision.js');
        await writeFile(join(root, 'other.ts'), 'export const other = 1;\n');
        await writeFile(
            join(root, '.kata', 'tasks', taskId, 'task.json'),
            `${JSON.stringify({ id: taskId, title: 'T', acceptance: [{ id: 'AC-1', statement: 'x' }], ownedPaths: ['subject.ts', 'other.ts'], createdAt: NOW, updatedAt: NOW })}\n`,
        );
        await createTaskRevisionIfChanged({ root, taskId, ownedPaths: ['subject.ts', 'other.ts'], checkIds: [] });
        const sealed = await readCurrentTaskRevisionState(root, taskId);
        const sealedDigests = sealed.kind === 'current' ? (sealed.revision as { pathDigests?: Record<string, string> }).pathDigests ?? {} : {};

        const planNow = async () => {
            await runLedgerCommand(['plan', '--change', taskId], { root, changeId: taskId } as never);
            const state = await readPlanState(root, taskId);
            return state.kind === 'usable' ? JSON.stringify(state.value) : `unreadable: ${state.kind}`;
        };
        // A frozen subject that disagrees about one of the two paths — the partial-change shape.
        await freezeSubjectWith(`rev:${'1'.repeat(16)}`, { ...sealedDigests, 'subject.ts': 'f'.repeat(64) });
        const withFrozenDisagreement = await planNow();
        // No frozen subject at all: nothing to compare against, so every declared path is the changed set.
        await rm(join(taskDir(root, taskId), 'review', 'subject.json'), { force: true });
        const withoutFrozenSubject = await planNow();
        expect(withFrozenDisagreement).toBe(withoutFrozenSubject);
    });
});

describe('the plan does not depend on the seal pointer', () => {
    it('plans the same thing after a seal over content that was already reviewed', async () => {
        // **Sealing content that was already reviewed reuses the revision, so pointing at "the current seal" made the
        // reference move for a reason that is neither content nor declaration.** The changed set flipped from the delta to
        // the all-paths fallback, plan.json moved, the declared subject moved with it (rev:497eed1b9cb63a13 →
        // rev:94fe02d13260191a) and a recorded round that answered the current question was released — measured by an
        // independent round. The reference is now the most recent stored content that is not the current content, so a seal
        // over the same content is not a reference at all.
        const { runLedgerCommand } = await import('../../src/cli/ledger.js');
        const { readPlanState } = await import('../../src/store/ledger.js');
        const { createTaskRevisionIfChanged } = await import('../../src/workflow/revision.js');
        await writeFile(join(root, 'other.ts'), 'export const other = 1;\n');
        await writeFile(
            join(root, '.kata', 'tasks', taskId, 'task.json'),
            `${JSON.stringify({ id: taskId, title: 'T', acceptance: [{ id: 'AC-1', statement: 'x' }], ownedPaths: ['subject.ts', 'other.ts'], createdAt: NOW, updatedAt: NOW })}\n`,
        );
        const seal = () => createTaskRevisionIfChanged({ root, taskId, ownedPaths: ['subject.ts', 'other.ts'], checkIds: [] });
        await seal();
        const planNow = async () => {
            await runLedgerCommand(['plan', '--change', taskId], { root, changeId: taskId } as never);
            const state = await readPlanState(root, taskId);
            return state.kind === 'usable' ? JSON.stringify(state.value) : `unreadable: ${state.kind}`;
        };
        // One path changes, so the reference has a delta to measure.
        await writeFile(join(root, 'subject.ts'), 'export const version = 2;\n');
        const beforeSeal = await planNow();
        // The seal catches up with the content — the no-op-from-the-reviewer's-view case.
        await seal();
        const afterSeal = await planNow();
        expect(afterSeal).toBe(beforeSeal);
    });
});

describe('the identity does not depend on itself', () => {
    it('plans the same thing whatever the identity is, so planning cannot move the identity', async () => {
        // **A fixed-point equation has no solution.** The plan's sampling seed used to embed `subject.revision`, and the
        // subject hashes the plan, so planning moved the identity and the identity moved the plan: `ledger plan` was never
        // idempotent (three runs on an unchanged ledger produced three declared subjects) and merely re-running it released a
        // recorded round that answered the current question. An independent round measured both faces of it.
        const { planReview } = await import('../../src/producers/planner.js');
        const { defaultPolicy } = await import('../../src/kernel/policy.js');
        const policy = defaultPolicy();
        const claim = { id: 'C1', statement: 'the question', riskClass: 'consistency', severity: 'major', dependsOn: ['path:subject.ts'], evidenceIds: [], challengeIds: [], status: 'open', at: NOW, reopens: 0 };
        const base = { claims: [claim as never], policy, tier: 'strict' as never, changedPaths: ['subject.ts', 'other.ts'], contentPaths: ['subject.ts', 'other.ts'] };
        const first = planReview({ ...base, subject: { revision: `rev:${'a'.repeat(16)}`, pathDigests: { 'subject.ts': 'a'.repeat(64) } } as never });
        const second = planReview({ ...base, subject: { revision: `rev:${'b'.repeat(16)}`, pathDigests: { 'subject.ts': 'a'.repeat(64) } } as never });
        expect(second.sampling).toEqual(first.sampling);
        // **And the diff must not move the sampling either.** `changedPaths` is the diff against the frozen snapshot, so a
        // partial content change would write a seed over the subset while the next plan wrote one over every path — the plan
        // moved, the subject moved with it, and a recorded round was released by a bare re-plan. An independent round measured
        // exactly that, and this guard was blind to it because it declared a single path.
        const partial = planReview({ ...base, changedPaths: ['subject.ts'], subject: { revision: `rev:${'a'.repeat(16)}`, pathDigests: { 'subject.ts': 'a'.repeat(64) } } as never });
        expect(partial.sampling).toEqual(first.sampling);
    });
});

describe('the plan is part of the question', () => {
    it('moves the subject when only the plan changed, so the request and the identity agree', async () => {
        // The request's reading sets and required evidence come from `plan.json`; changing the plan changes what is asked
        // while the claims and the content stand still. Measured by an independent round: `subjectMoved=false
        // requestChanged=true`, and the record that answered the old request kept blocking.
        const { appendClaim, freezeSubject: freezeThroughStore, writeSubject, writePlan, readLedger: read } = await import('../../src/store/ledger.js');
        const { hashContent } = await import('../../src/core/hash.js');
        await appendClaim(root, taskId, {
            id: 'C1', statement: 'the question', riskClass: 'consistency', severity: 'major',
            dependsOn: ['path:subject.ts'], evidenceIds: [], challengeIds: [], status: 'open', at: NOW, reopens: 0,
        });
        const planOf = (types: string[]) => ({
            version: 1,
            claims: [{ claimId: 'C1', requiredEvidence: [{ types, minimumStrength: 2 }], readingSet: ['subject.ts'] }],
        });
        const planDigest = async () => hashContent(JSON.stringify(JSON.parse(await readFile(join(taskDir(root, taskId), 'review', 'plan.json'), 'utf8'))));

        await writePlan(root, taskId, planOf(['static_witness']) as never);
        const first = await freezeThroughStore({ root, paths: ['subject.ts'], claims: (await read(root, taskId)).claims, planDigest: await planDigest() });
        if (first.ok) await writeSubject(root, taskId, first.subject);
        const before = (await read(root, taskId)).subjectAsDeclared?.revision;

        await writePlan(root, taskId, planOf(['executable_falsifier']) as never);
        const after = (await read(root, taskId)).subjectAsDeclared?.revision;
        expect(after).not.toBe(before);
    });
});
