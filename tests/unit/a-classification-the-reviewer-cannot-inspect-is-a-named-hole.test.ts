import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initLayout, taskDir } from '../../src/core/layout.js';
import { createTask, writeTaskClassification, type TaskClassificationRecord } from '../../src/core/task.js';
import { buildReviewRequest } from '../../src/store/review-request.js';
import { appendClaim, appendEvidence, ensureAssurance, freezeSubject, writePlan, writePolicy, writeSubject } from '../../src/store/ledger.js';
import { createTaskRevisionIfChanged } from '../../src/workflow/revision.js';
import { defaultPolicy } from '../../src/kernel/policy.js';
import type { Claim, Evidence } from '../../src/kernel/types.js';

const roots: string[] = [];
afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const makeEvidence = (overrides: Partial<Evidence>): Evidence => ({
    id: 'E1', type: 'executable_falsifier', command: 'true',
    mutation: { file: 'src/risk.ts', find: 'a', replace: 'b' }, ...overrides,
} as Evidence);

async function fixtureWithRequest(changeId: string): Promise<{ root: string; built: Awaited<ReturnType<typeof buildReviewRequest>> }> {
    const root = await mkdtemp(join(tmpdir(), 'kata-classification-hole-'));
    roots.push(root);
    await initLayout(root);
    await createTask({
        root,
        id: changeId,
        title: 'The hole is named, not filled in',
        acceptance: [{ id: 'AC-1', statement: 'an unreadable classification arrives as a named hole' }],
        ownedPaths: ['src/risk.ts'],
        workflowProfile: {
            version: 1, isolationMode: 'current_worktree', developmentMode: 'tdd', reviewMode: 'std',
            comet: { projectInit: 'not_requested', openStatus: 'acknowledged' },
        },
    });
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src', 'risk.ts'), 'export const risk = true;\n', 'utf8');
    await writePolicy(root, changeId, defaultPolicy());
    const frozen = await freezeSubject({ root, paths: ['src/risk.ts'] });
    if (!frozen.ok) throw new Error(frozen.error);
    await writeSubject(root, changeId, frozen.subject);
    await createTaskRevisionIfChanged({ root, taskId: changeId, ownedPaths: ['src/risk.ts'], checkIds: [] });
    await ensureAssurance(root, changeId, 'observed');
    const claim: Claim = {
        id: 'C1', statement: 'the request remains bound to its classification', riskClass: 'privilege', severity: 'major',
        dependsOn: ['path:src/risk.ts'], evidenceIds: ['E1'], challengeIds: [], status: 'open',
        at: '2026-10-13T00:00:00.000Z', reopens: 0,
    };
    await appendClaim(root, changeId, claim);
    await appendEvidence(root, changeId, makeEvidence({}));
    await writePlan(root, changeId, {
        tier: 'strict',
        readingSets: [{ claimId: 'C1', paths: ['src/risk.ts'], truncated: false }],
        requiredEvidence: [{ claimId: 'C1', types: ['executable_falsifier'], minimumStrength: 3 }],
        discovery: { deadlineToolCalls: 200 },
    });
    return { root, built: await buildReviewRequest({ root, changeId }) };
}

/**
 * AC-7's second half: **a classification the reviewer cannot inspect is carried as a named hole, not filled in.**
 *
 * A review round measured the claim as first written ("the request refuses when the recorded classification is unreadable") to
 * be false: `classificationForRequest` returns `{unreadable}`, and the request issues its contract with that hole named. The
 * design says why — "the reviewer could not be told which lane this change runs under" is a fact about the brief, while
 * reporting `standard` there would be inventing a tier — and this case keeps the distinction the design draws, so a future
 * change cannot make an absent record read as a default lane or as no classification at all.
 */
describe('an unreadable classification is a named hole on the request', () => {
    it('carries {unreadable} when the record is absent, rather than omitting the field or substituting a tier', async () => {
        const { built } = await fixtureWithRequest('classification-absent');
        expect(built.ok, JSON.stringify(built)).toBe(true);
        if (!built.ok) return;
        const carried = built.request.classification as { unreadable?: string } | undefined;
        expect(carried, 'the field is present, so a reviewer sees that a classification exists to inspect').toBeDefined();
        expect(carried?.unreadable, 'and it says which record is missing, not just that something is').toMatch(/classification\.json/);
        expect(carried?.unreadable, 'the change it is about').toMatch(/classification-absent/);
    });

    it('carries {unreadable} when the record exists but cannot be parsed', async () => {
        const { root, built } = await fixtureWithRequest('classification-damaged');
        void built;
        await writeFile(join(taskDir(root, 'classification-damaged'), 'classification.json'), '{ this is not json', 'utf8');
        const rebuilt = await buildReviewRequest({ root, changeId: 'classification-damaged' });
        expect(rebuilt.ok, JSON.stringify(rebuilt)).toBe(true);
        if (!rebuilt.ok) return;
        const carried = rebuilt.request.classification as { unreadable?: string } | undefined;
        expect(carried?.unreadable, 'damage is named as damage, the same three-state read the rest of the repository uses').toMatch(/unreadable/);
    });

    it('carries the record itself when it is usable, so the hole is not the normal path', async () => {
        const { root, built } = await fixtureWithRequest('classification-usable');
        void built;
        const record: TaskClassificationRecord = {
            version: 1, taskId: 'classification-usable', by: 'agent', tier: 'strict', floor: 'high',
            reasons: ['schema and identity are in scope'], riskClasses: ['privilege'],
            facts: { declaredPaths: ['src/risk.ts'], matched: [], wideChange: false },
            lane: 'std', laneTier: 'standard', laneBelow: true,
        } as TaskClassificationRecord;
        await writeTaskClassification(root, 'classification-usable', record);
        const rebuilt = await buildReviewRequest({ root, changeId: 'classification-usable' });
        expect(rebuilt.ok, JSON.stringify(rebuilt)).toBe(true);
        if (!rebuilt.ok) return;
        expect(rebuilt.request.classification, 'the recorded judgement travels verbatim, including the lane below it').toEqual(record);
        expect(JSON.stringify(rebuilt.request.classification), 'and it is not a hole').not.toMatch(/unreadable/);
    });
});
