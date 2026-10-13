import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildReviewRequest } from '../../src/store/review-request.js';
import { appendClaim, appendEvidence, ensureAssurance, freezeSubject, writePlan, writePolicy, writeSubject } from '../../src/store/ledger.js';
import { createTask, writeTaskClassification, type TaskClassificationRecord } from '../../src/core/task.js';
import { initLayout } from '../../src/core/layout.js';
import { defaultPolicy } from '../../src/kernel/policy.js';
import { createTaskRevisionIfChanged } from '../../src/workflow/revision.js';
import { makeEvidence } from '../helpers/review.js';
import type { Claim } from '../../src/kernel/types.js';

describe('a review request carries the classification recorded on the task', () => {
    const roots: string[] = [];
    afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

    it('carries the persisted judgement and facts verbatim, rather than re-deriving or dropping them', async () => {
        const root = await mkdtemp(join(tmpdir(), 'kata-classification-request-'));
        roots.push(root);
        await initLayout(root);
        const changeId = 'classification-request';
        await mkdir(join(root, 'src', 'kernel'), { recursive: true });
        await writeFile(join(root, 'src', 'kernel', 'risk.ts'), 'export const risk = true;\n');
        await createTask({
            root,
            id: changeId,
            title: 'Classification request fixture',
            acceptance: [{ id: 'AC-1', statement: 'the request carries the recorded judgement' }],
            ownedPaths: ['src/kernel/risk.ts'],
            workflowProfile: {
                version: 1,
                isolationMode: 'current_worktree',
                developmentMode: 'tdd',
                reviewMode: 'std',
                comet: { projectInit: 'not_requested', openStatus: 'acknowledged' },
            },
        });

        const record = {
            version: 1,
            taskId: changeId,
            by: 'agent',
            tier: 'security',
            floor: 'high',
            reasons: ['identity and trust-boundary questions are in scope'],
            riskClasses: ['privilege'],
            facts: {
                declaredPaths: ['src/kernel/risk.ts'],
                matched: [{ pattern: 'src/kernel/**', path: 'src/kernel/risk.ts', floor: 'high' }],
                wideChange: false,
            },
            lane: 'std',
            laneTier: 'standard',
            laneBelow: true,
        };
        await writeTaskClassification(root, changeId, record as TaskClassificationRecord);

        await writePolicy(root, changeId, defaultPolicy());
        const frozen = await freezeSubject({ root, paths: ['src/kernel/risk.ts'] });
        if (!frozen.ok) throw new Error(frozen.error);
        await writeSubject(root, changeId, frozen.subject);
        await createTaskRevisionIfChanged({ root, taskId: changeId, ownedPaths: ['src/kernel/risk.ts'], checkIds: [] });
        await ensureAssurance(root, changeId, 'observed');
        const claim: Claim = {
            id: 'C1', statement: 'the request remains bound to its classification', riskClass: 'privilege', severity: 'major',
            dependsOn: ['path:src/kernel/risk.ts'], evidenceIds: ['E1'], challengeIds: [], status: 'open',
            at: '2026-10-11T00:00:00.000Z', reopens: 0,
        };
        await appendClaim(root, changeId, claim);
        await appendEvidence(root, changeId, makeEvidence({
            id: 'E1', type: 'executable_falsifier', command: 'grep -q risk src/kernel/risk.ts',
            mutation: { file: 'src/kernel/risk.ts', find: 'risk = true', replace: 'risk = false' },
        }));
        await writePlan(root, changeId, {
            tier: 'security',
            readingSets: [{ claimId: 'C1', paths: ['src/kernel/risk.ts'], truncated: false }],
            requiredEvidence: [{ claimId: 'C1', types: ['executable_falsifier'], minimumStrength: 3 }],
            discovery: { deadlineToolCalls: 200 },
        });

        const built = await buildReviewRequest({ root, changeId });
        expect(built.ok, JSON.stringify(built)).toBe(true);
        if (!built.ok) return;
        expect(built.request.classification).toEqual(record);
    });
});
