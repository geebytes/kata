import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { judge } from '../../src/quality/judge.js';
import { readUpstreamSummary } from '../../src/workflow/navigation.js';
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
