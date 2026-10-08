import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { judge } from '../../src/quality/judge.js';
import { readUpstreamSummary } from '../../src/workflow/navigation.js';
import { writeTaskRecord } from '../helpers/task-fixture.js';
import { checkPromotionProvenance } from '../../src/wiki/provenance-gate.js';

const roots: string[] = [];
afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('a judge record answers a question', () => {
    it('stamps the declared subject revision it judged', async () => {
        const root = await mkdtemp(join(tmpdir(), 'kata-judge-subject-'));
        roots.push(root);
        const taskId = 'judge-subject';
        await mkdir(join(root, '.kata', 'tasks', taskId), { recursive: true });

        await judge({
            root,
            taskId,
            acceptance: [{ id: 'AC-1', statement: 'the record binds its question' }],
            evidence: [],
            currentDiffHash: 'a'.repeat(64),
            subjectRevision: 'rev:declared-question',
        });

        const stored = JSON.parse(await readFile(join(root, '.kata', 'tasks', taskId, 'judge.json'), 'utf8')) as Record<string, unknown>;
        expect(stored.subjectRevision).toBe('rev:declared-question');
    });
});

    it('does not publish a judgement that answered an earlier declared question', async () => {
        const root = await mkdtemp(join(tmpdir(), 'kata-judge-stale-subject-'));
        roots.push(root);
        const taskId = 'judge-stale-subject';
        await mkdir(join(root, '.kata', 'tasks', taskId), { recursive: true });
        await writeFile(join(root, 'subject.ts'), 'export const current = true;\n');
        const { appendClaim, freezeSubject, readLedger, writeSubject } = await import('../../src/store/ledger.js');
        await appendClaim(root, taskId, {
            id: 'C1', statement: 'current question', riskClass: 'consistency', severity: 'major',
            dependsOn: ['path:subject.ts'], evidenceIds: [], challengeIds: [], status: 'open', at: '2026-10-08T00:00:00.000Z', reopens: 0,
        });
        const frozen = await freezeSubject({ root, paths: ['subject.ts'], claims: (await readLedger(root, taskId)).claims });
        expect(frozen.ok).toBe(true);
        if (frozen.ok) await writeSubject(root, taskId, frozen.subject);

        await judge({
            root,
            taskId,
            acceptance: [{ id: 'AC-1', statement: 'the record binds its question' }],
            evidence: [],
            currentDiffHash: 'a'.repeat(64),
            subjectRevision: 'rev:earlier-question',
        });

        const summary = await readUpstreamSummary(root, taskId);
        expect(summary.judgeResult).toBeUndefined();
        expect(summary).toMatchObject({ judgeStaleSubject: 'rev:earlier-question' });
    });

    it('refuses a provenance record whose PASS Judge answered an earlier question', async () => {
        const root = await mkdtemp(join(tmpdir(), 'kata-judge-provenance-subject-'));
        roots.push(root);
        const taskId = 'judge-provenance-subject';
        await mkdir(join(root, '.kata', 'tasks', taskId), { recursive: true });
        await writeFile(join(root, '.kata', 'tasks', taskId, 'task.json'), '{}\n');
        await writeFile(join(root, 'subject.ts'), 'export const current = true;\n');
        const { appendClaim, freezeSubject, readLedger, writeSubject } = await import('../../src/store/ledger.js');
        await appendClaim(root, taskId, {
            id: 'C1', statement: 'current question', riskClass: 'consistency', severity: 'major',
            dependsOn: ['path:subject.ts'], evidenceIds: [], challengeIds: [], status: 'open', at: '2026-10-08T00:00:00.000Z', reopens: 0,
        });
        const frozen = await freezeSubject({ root, paths: ['subject.ts'], claims: (await readLedger(root, taskId)).claims });
        if (frozen.ok) await writeSubject(root, taskId, frozen.subject);
        await writeFile(join(root, '.kata', 'tasks', taskId, 'judge.json'), `${JSON.stringify({ taskId, result: 'PASS', diffHash: 'a'.repeat(64), subjectRevision: 'rev:earlier-question', acceptance: [{ id: 'AC-1', result: 'PASS' }] })}\n`);

        const provenance = await checkPromotionProvenance(root, {
            id: 'record', statement: 'validated fact', scope: [], kind: 'implementation-note', sourceRefs: [], sourceHashes: {},
            validationTaskId: taskId, evidenceIds: ['E1'], status: 'candidate', lastVerifiedAt: '', createdAt: '', updatedAt: '',
        });
        expect(provenance.ok).toBe(false);
        expect(provenance.failures).toContainEqual(expect.objectContaining({ reason: 'validation_task_question_moved' }));
    });

    it('names an unreadable Judge record instead of calling it absent', async () => {
        const root = await mkdtemp(join(tmpdir(), 'kata-judge-unreadable-'));
        roots.push(root);
        const taskId = 'judge-unreadable';
        await mkdir(join(root, '.kata', 'tasks', taskId), { recursive: true });
        await writeFile(join(root, '.kata', 'tasks', taskId, 'task.json'), '{}\n');
        await writeFile(join(root, '.kata', 'tasks', taskId, 'judge.json'), '{not json}\n');
        const provenance = await checkPromotionProvenance(root, {
            id: 'record', statement: 'validated fact', scope: [], kind: 'implementation-note', sourceRefs: [], sourceHashes: {},
            validationTaskId: taskId, evidenceIds: ['E1'], status: 'candidate', lastVerifiedAt: '', createdAt: '', updatedAt: '',
        });
        expect(provenance).toMatchObject({ ok: false, failures: [expect.objectContaining({ reason: 'validation_task_judge_unreadable' })] });
    });

/**
 * **Every reader of a judge record, not only the ones that were easy to find.**
 *
 * Round 1 found three more: `proposeFromPassedTask` and `distillPassedTaskKnowledge` (the archive/distill boundary) checked
 * only `taskId` and `result`, and `authorizeJudgeRepair` opened a repair on a FAIL that answered a question the task no
 * longer asks. The first two also folded an unreadable `judge.json` into "not judged", which is the AC-4 collapse at the
 * same read.
 */
describe('every reader of a judge record binds it to the question it answered', () => {
    /**
     * A task whose declared question is frozen, so a judge record can be compared against it.
     *
     * `claims: false` leaves the ledger with no claims at all. That is not decoration: the repair authorization below is
     * also reachable through the *ledger's* deficits, which is a separate and legitimate route, so a fixture with an open
     * claim would be authorized by the ledger and would prove nothing about the judge record.
     */
    const withCurrentQuestion = async (root: string, taskId: string, options: { claims?: boolean } = {}) => {
        await mkdir(join(root, '.kata', 'tasks', taskId), { recursive: true });
        await writeTaskRecord(root, { id: taskId, phase: 'archive' });
        await writeFile(join(root, 'subject.ts'), 'export const current = true;\n');
        const { appendClaim, freezeSubject, readLedger, writeSubject } = await import('../../src/store/ledger.js');
        if (options.claims !== false) {
            await appendClaim(root, taskId, {
                id: 'C1', statement: 'current question', riskClass: 'consistency', severity: 'major',
                dependsOn: ['path:subject.ts'], evidenceIds: [], challengeIds: [], status: 'open', at: '2026-10-08T00:00:00.000Z', reopens: 0,
            });
        }
        const frozen = await freezeSubject({ root, paths: ['subject.ts'], claims: (await readLedger(root, taskId)).claims });
        if (frozen.ok) await writeSubject(root, taskId, frozen.subject);
    };

    it('defers wiki distillation when the PASS answered an earlier question', async () => {
        const root = await mkdtemp(join(tmpdir(), 'kata-wiki-stale-judge-'));
        roots.push(root);
        const taskId = 'wiki-stale-judge';
        await withCurrentQuestion(root, taskId);
        await writeFile(join(root, '.kata', 'tasks', taskId, 'judge.json'), `${JSON.stringify({ taskId, result: 'PASS', subjectRevision: 'rev:earlier-question', acceptance: [{ id: 'AC-1', result: 'PASS' }] })}\n`);
        const { distillPassedTaskKnowledge } = await import('../../src/wiki/provenance.js');
        const result = await distillPassedTaskKnowledge(root, taskId);
        expect(result.decision).toBe('deferred');
        // Narrowed before the field is read: the union says `reason` exists only on the deferred arm, so the assertion
        // reads the arm it just asserted rather than the whole union.
        expect(result.decision === 'deferred' ? result.reason : '').toMatch(/not its current declared question/);
    });

    it('refuses to propose a wiki candidate from a PASS that answered an earlier question', async () => {
        const root = await mkdtemp(join(tmpdir(), 'kata-wiki-propose-stale-'));
        roots.push(root);
        const taskId = 'wiki-propose-stale';
        await withCurrentQuestion(root, taskId);
        await writeFile(join(root, '.kata', 'tasks', taskId, 'judge.json'), `${JSON.stringify({ taskId, result: 'PASS', subjectRevision: 'rev:earlier-question', acceptance: [{ id: 'AC-1', result: 'PASS' }] })}\n`);
        const { proposeFromPassedTask } = await import('../../src/wiki/provenance.js');
        await expect(proposeFromPassedTask(root, taskId, { statement: 's', scope: [], kind: 'implementation-note', sourceRefs: [], sourceHashes: {} })).rejects.toThrow(/not its current declared question/);
    });

    it('refuses to open a judge repair from a FAIL that answered an earlier question', async () => {
        const root = await mkdtemp(join(tmpdir(), 'kata-judge-repair-stale-'));
        roots.push(root);
        const taskId = 'judge-repair-stale';
        await withCurrentQuestion(root, taskId, { claims: false });
        await writeFile(join(root, '.kata', 'tasks', taskId, 'judge.json'), `${JSON.stringify({ taskId, result: 'FAIL', subjectRevision: 'rev:earlier-question', acceptance: [{ id: 'AC-1', result: 'FAIL', repairScope: 'failing_evidence' }] })}\n`);
        const { authorizeJudgeRepair } = await import('../../src/workflow/repair-entry.js');
        const authorization = await authorizeJudgeRepair(root, taskId);
        expect(authorization.authorized).toBe(false);
    });
});

/**
 * **A binding that cannot be checked is not a binding that holds — round 3's major, at every reader.**
 *
 * Each of the six readers wrote the same `record.subjectRevision && current && record.subjectRevision !== current` chain, and
 * `&&` short-circuits: when the *current* question cannot be derived (a damaged `review/subject.json`, a `claims.json` nobody
 * can read), the comparison is skipped and the record is accepted. Measured by round 3: a Judge PASS stamped
 * `rev:earlier-question` was refused with a readable subject and **accepted** once the subject was corrupted — the binding
 * silently disappeared, in the permissive direction, at all six sites at once.
 *
 * One derivation answers it now (`questionBinding` / `answersCurrentQuestion`), and `unknown` is refused.
 */
describe('a question that cannot be derived refuses rather than accepts', () => {
    it('refuses a stale Judge PASS once the frozen subject is damaged', async () => {
        const root = await mkdtemp(join(tmpdir(), 'kata-damaged-subject-'));
        roots.push(root);
        const taskId = 'damaged-subject';
        await mkdir(join(root, '.kata', 'tasks', taskId), { recursive: true });
        await writeTaskRecord(root, { id: taskId, phase: 'archive' });
        await writeFile(join(root, 'subject.ts'), 'export const current = true;\n');
        const { appendClaim, freezeSubject, readLedger, writeSubject } = await import('../../src/store/ledger.js');
        await appendClaim(root, taskId, {
            id: 'C1', statement: 'current question', riskClass: 'consistency', severity: 'major',
            dependsOn: ['path:subject.ts'], evidenceIds: [], challengeIds: [], status: 'open', at: '2026-10-08T00:00:00.000Z', reopens: 0,
        });
        const frozen = await freezeSubject({ root, paths: ['subject.ts'], claims: (await readLedger(root, taskId)).claims });
        if (frozen.ok) await writeSubject(root, taskId, frozen.subject);
        await writeFile(join(root, '.kata', 'tasks', taskId, 'judge.json'), `${JSON.stringify({ taskId, result: 'PASS', diffHash: 'a'.repeat(64), subjectRevision: 'rev:earlier-question', acceptance: [{ id: 'AC-1', result: 'PASS' }] })}\n`);

        // With a readable question the record is refused for answering another one.
        const readable = await checkPromotionProvenance(root, {
            id: 'record', statement: 'validated fact', scope: [], kind: 'implementation-note', sourceRefs: [], sourceHashes: {},
            validationTaskId: taskId, evidenceIds: ['E1'], status: 'candidate', lastVerifiedAt: '', createdAt: '', updatedAt: '',
        });
        expect(readable.failures).toContainEqual(expect.objectContaining({ reason: 'validation_task_question_moved' }));

        // **Now the question cannot be derived.** The record still carries one, so the answer must be a refusal — not the
        // silence the `&&` chain produced.
        await mkdir(join(root, '.kata', 'tasks', taskId, 'review'), { recursive: true });
        await writeFile(join(root, '.kata', 'tasks', taskId, 'review', 'subject.json'), '{not json}\n');
        const damaged = await checkPromotionProvenance(root, {
            id: 'record', statement: 'validated fact', scope: [], kind: 'implementation-note', sourceRefs: [], sourceHashes: {},
            validationTaskId: taskId, evidenceIds: ['E1'], status: 'candidate', lastVerifiedAt: '', createdAt: '', updatedAt: '',
        });
        expect(damaged.ok).toBe(false);
        expect(damaged.failures).toContainEqual(expect.objectContaining({ reason: 'validation_task_question_moved' }));
    });
});

/**
 * **A damaged question field is not an absent one — round 4 measured the difference.**
 *
 * `questionBinding` asked `typeof recordSubjectRevision !== 'string'` for "this record predates the field", so a record whose
 * `subjectRevision` was the number `42` — damaged, not missing — read as `unbound` and was **accepted**: the round measured
 * `readUpstreamSummary` publishing `judgeResult: "PASS"` for it. Only the field's absence means "written before the field
 * existed"; any other non-string is damage, and damage refuses.
 */
describe('a question field of the wrong type refuses', () => {
    it('does not publish a judgement whose question field is not a string', async () => {
        const root = await mkdtemp(join(tmpdir(), 'kata-typed-question-'));
        roots.push(root);
        const taskId = 'typed-question';
        await mkdir(join(root, '.kata', 'tasks', taskId), { recursive: true });
        await writeTaskRecord(root, { id: taskId, phase: 'review' });
        await writeFile(join(root, 'subject.ts'), 'export const current = true;\n');
        const { appendClaim, freezeSubject, readLedger, writeSubject } = await import('../../src/store/ledger.js');
        await appendClaim(root, taskId, {
            id: 'C1', statement: 'current question', riskClass: 'consistency', severity: 'major',
            dependsOn: ['path:subject.ts'], evidenceIds: [], challengeIds: [], status: 'open', at: '2026-10-08T00:00:00.000Z', reopens: 0,
        });
        const frozen = await freezeSubject({ root, paths: ['subject.ts'], claims: (await readLedger(root, taskId)).claims });
        if (frozen.ok) await writeSubject(root, taskId, frozen.subject);
        // A judgement that answers *something*, recorded as a number rather than a revision string.
        await writeFile(join(root, '.kata', 'tasks', taskId, 'judge.json'), `${JSON.stringify({ taskId, result: 'PASS', diffHash: 'a'.repeat(64), subjectRevision: 42, acceptance: [{ id: 'AC-1', result: 'PASS' }] })}\n`);

        const summary = await readUpstreamSummary(root, taskId);
        // The record answered a question and the answer cannot be compared: it must not be published as current.
        expect(summary.judgeResult).toBeUndefined();
        expect(summary.judgeStaleSubject).toBeDefined();
    });
});
