import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { addTaskRelation } from '../../src/core/relations.js';
import { createTask, writeTaskClassification, type TaskClassificationRecord } from '../../src/core/task.js';
import { initLayout } from '../../src/core/layout.js';
import { defaultPolicy } from '../../src/kernel/policy.js';
import { appendClaim, appendEvidence, ensureAssurance, freezeSubject, writePlan, writePolicy, writeSubject } from '../../src/store/ledger.js';
import { runLedgerCommand } from '../../src/cli/ledger.js';
import { createTaskRevisionIfChanged } from '../../src/workflow/revision.js';
import { makeEvidence } from '../helpers/review.js';
import type { Claim } from '../../src/kernel/types.js';

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe('ledger run delivers the review round its mechanically readable package', () => {
    it('hands over relations, both axes, the declaration, and falsifiers mapped to the claims they should redden', async () => {
        const root = await mkdtemp(join(tmpdir(), 'kata-review-package-'));
        roots.push(root);
        await initLayout(root);
        await mkdir(join(root, 'src'), { recursive: true });
        await mkdir(join(root, 'tmp'), { recursive: true });
        await writeFile(join(root, 'src', 'a.ts'), 'export const holds = true;\n');
        const changeId = 'delivered-package';
        await createTask({
            root,
            id: changeId,
            title: 'Delivered review package',
            acceptance: [{ id: 'AC-1', statement: 'the request carries facts the reviewer otherwise re-derives' }],
            ownedPaths: ['src/a.ts'],
            workflowProfile: { version: 1, isolationMode: 'current_worktree', developmentMode: 'tdd', reviewMode: 'strict', comet: { projectInit: 'not_requested', openStatus: 'acknowledged' } },
        });
        await createTask({ root, id: 'package-peer', title: 'Related peer', acceptance: [{ statement: 'the peer exists' }], ownedPaths: [] });
        await addTaskRelation({ root, fromTaskId: changeId, toTaskId: 'package-peer', type: 'depends_on', reason: 'the review depends on the peer contract' });
        const classification = {
            version: 1,
            taskId: changeId,
            by: 'agent',
            tier: 'strict',
            floor: 'medium',
            reasons: ['the change touches workflow behavior'],
            riskClasses: ['consistency', 'boundary'],
            facts: { declaredPaths: ['src/a.ts'], matched: [], wideChange: false },
            lane: 'strict',
            laneTier: 'strict',
            laneBelow: false,
        } as TaskClassificationRecord;
        await writeTaskClassification(root, changeId, classification);

        await writePolicy(root, changeId, defaultPolicy());
        const frozen = await freezeSubject({ root, paths: ['src/a.ts'] });
        if (!frozen.ok) throw new Error(frozen.error);
        await writeSubject(root, changeId, frozen.subject);
        await createTaskRevisionIfChanged({ root, taskId: changeId, ownedPaths: ['src/a.ts'], checkIds: [] });
        await ensureAssurance(root, changeId, 'observed');
        const claim: Claim = {
            id: 'C-1', statement: 'the declared export holds', riskClass: 'boundary', severity: 'major',
            dependsOn: ['path:src/a.ts'], evidenceIds: ['E-1'], challengeIds: [], status: 'open',
            at: '2026-10-11T00:00:00.000Z', reopens: 0,
        };
        await appendClaim(root, changeId, claim);
        await appendEvidence(root, changeId, makeEvidence({
            id: 'E-1', type: 'executable_falsifier', command: 'grep -q holds src/a.ts',
            mutation: { file: 'src/a.ts', find: 'holds = true', replace: 'holds = false' },
        }));
        await writePlan(root, changeId, {
            tier: 'strict',
            readingSets: [{ claimId: 'C-1', paths: ['src/a.ts'], truncated: false }],
            requiredEvidence: [{ claimId: 'C-1', types: ['executable_falsifier'], minimumStrength: 3 }],
            discovery: { deadlineToolCalls: 100 },
        });

        await runLedgerCommand(['run', '--out', 'tmp/request.json'], { root, changeId });
        const request = JSON.parse(await readFile(join(root, 'tmp', 'request.json'), 'utf8')) as {
            reviewPackage?: {
                version: number;
                relations: Array<{ type: string; targetTaskId: string; reason?: string }>;
                axes: {
                    qualityEvidence: { tier: string; requirements: Array<{ claimId: string; types: string[]; minimumStrength: number }> };
                    executionAssurance: { achieved: string; floor: string; reviewers: number; quorumOn: string[] };
                    classification: unknown;
                    reviewLane: string;
                };
                declaration: { ownedPaths: string[]; acceptance: Array<{ id?: string; statement: string }> };
                falsifiers: Array<{ id: string; file: string; find: string; replace: string; command: string; expectedRedForClaims: string[] }>;
            };
        };
        expect(request.reviewPackage, 'the package is part of the delivered ledger run output, not a separate lookup').toBeDefined();
        expect(request.reviewPackage).toMatchObject({
            version: 1,
            relations: [{ type: 'depends_on', targetTaskId: 'package-peer', reason: 'the review depends on the peer contract' }],
            axes: {
                qualityEvidence: { tier: 'strict', requirements: [{ claimId: 'C-1', types: ['executable_falsifier'], minimumStrength: 3 }] },
                executionAssurance: { achieved: 'observed', floor: 'observed', reviewers: 1, quorumOn: ['disagreement', 'high_risk'] },
                // **The two axes nothing asserted until round 5 read them.** The classification clause was *read* but never
                // decided: a package reporting a hole in place of the record it holds stayed green, and so did one whose lane
                // axis was a constant. Both are asserted here now, and both carry a declared falsifier.
                classification: { version: 1, taskId: 'delivered-package', by: 'agent', tier: 'strict', floor: 'medium' },
                reviewLane: 'strict',
            },
            declaration: {
                ownedPaths: ['src/a.ts'],
                acceptance: [{ id: 'AC-1', statement: 'the request carries facts the reviewer otherwise re-derives' }],
            },
            falsifiers: [{
                id: 'E-1', file: 'src/a.ts', find: 'holds = true', replace: 'holds = false',
                command: 'grep -q holds src/a.ts', expectedRedForClaims: ['C-1'],
            }],
        });
    });
});
