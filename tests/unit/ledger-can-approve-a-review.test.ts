import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initLayout, reviewPath } from '../../src/core/layout.js';
import { createTask } from '../../src/core/task.js';
import { writeCurrentState } from '../../src/core/state.js';
import { runCommand } from '../../src/workflow/orchestrator.js';
import {
    appendChallenge,
    appendClaim,
    appendEvidence,
    ensureAssurance,
    freezeSubject,
    recordVerdicts,
    reviewDir,
    writeSubject,
} from '../../src/store/ledger.js';
import { makeClaim, makeEvidence, makeVerdict } from '../helpers/review.js';

/**
 * **The ledger can hold a review approval, and the old route still holds the ones it must.**
 *
 * This is the decision the plan called D1: a change whose claims and evidence are recorded is decided by the kernel over
 * content kata verified itself, so a round-shaped pass about it is no longer what the approval rests on. Three things are
 * pinned here, and the middle one is the reason the change is safe to make. A change with a passing ledger is approved and
 * the record says which route did it; a change with **no** ledger still needs the independent pass, so nothing that was
 * refused before is now allowed; and every way the ledger can be wrong — not passing, describing content that has moved,
 * or existing but unreadable — refuses, naming what it found.
 */
describe('the evidence ledger can hold a review approval', () => {
    const roots: string[] = [];
    afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

    async function reviewTask(id: string): Promise<string> {
        const root = await mkdtemp(join(tmpdir(), 'kata-ledger-review-'));
        roots.push(root);
        await initLayout(root);
        await createTask({
            root,
            id,
            title: 'Ledger approval',
            acceptance: [{ id: 'AC-1', statement: 'The export is present.' }],
            // A path the policy floors at the strict tier, because that is where the assurance floor and the risk-space
            // contract bite — and those are the parts of this route worth testing.
            ownedPaths: ['src/workflow/ledger-review.ts'],
            workflowProfile: {
                version: 1,
                isolationMode: 'current_worktree',
                developmentMode: 'tdd',
                reviewMode: 'strict',
                comet: { projectInit: 'not_requested', openStatus: 'acknowledged' },
            },
        });
        await mkdir(join(root, 'src', 'workflow'), { recursive: true });
        await writeFile(join(root, 'src', 'workflow', 'ledger-review.ts'), 'export const x = 1;\n');
        await writeCurrentState(root, {
            taskId: id,
            phase: 'review',
            actor: { id: 'kata-agent', role: 'reviewer' },
            updatedAt: new Date().toISOString(),
        });
        return root;
    }

    /**
     * A ledger that passes at the strict tier, which means three things beyond "the evidence is green": every class the
     * tier's risk space requires has a claim, the assurance was observed, and at least one counterexample was raised and
     * did not reproduce. A fixture that skipped any of them would be testing a weaker route than the one shipped.
     */
    async function passLedger(root: string, id: string, options: { assurance?: 'observed' | 'none' } = {}): Promise<void> {
        const path = 'src/workflow/ledger-review.ts';
        const subject = await freezeSubject({ root, paths: [path] });
        expect(subject.ok).toBe(true);
        if (!subject.ok) return;
        await writeSubject(root, id, subject.subject);
        await ensureAssurance(root, id, options.assurance ?? 'observed');
        const classes = ['consistency', 'boundary', 'failure_mode'] as const;
        const verdicts = [];
        for (const [index, riskClass] of classes.entries()) {
            const evidenceId = `E${index + 1}`;
            await appendClaim(root, id, makeClaim({
                id: `C${index + 1}`,
                severity: 'major',
                riskClass,
                evidenceIds: [evidenceId],
                dependsOn: [`path:${path}`],
            }));
            await appendEvidence(root, id, makeEvidence({ id: evidenceId, ref: path, assertion: 'contains:export' }));
            verdicts.push(makeVerdict({ evidenceId, subjectRevision: subject.subject.revision }));
        }
        await recordVerdicts(root, id, verdicts);
        await appendChallenge(root, id, {
            id: 'X1',
            claimId: 'C1',
            command: 'exit 1',
            failsOn: subject.subject.revision,
            state: 'withdrawn',
            at: '2026-09-27T00:00:00.000Z',
            resolution: { at: '2026-09-27T00:01:00.000Z', observed: 'exit 0 when checked against the frozen subject' },
            // **The reproduction, without which this is not a challenge.** The command failed while the defect was
            // present; the resolution above records that it now passes. Counting a challenge that never failed is how
            // the discovery floor was satisfiable by `challenge add --command 'exit 0'`.
            reproduced: true,
        });
    }

    const approve = (root: string, id: string) => runCommand('review', id, root, {
        approve: true,
        reviewEvidence: 'the ledger decides it; see the claim set',
        confirmHostModel: true,
    });

    it('refuses when the change has no ledger, and says what to record', async () => {
        // The old route (an independent round-shaped pass) is closed: two answers to "was this reviewed" is the class this
        // session spent its time removing, and which one a change got depended on which files happened to exist. The
        // refusal names the remedy rather than the old gate, because the old gate is no longer a gate.
        const root = await reviewTask('no-ledger-task');
        const result = await approve(root, 'no-ledger-task');
        expect(result.success).toBe(false);
        expect(String(result.error)).toContain('requires an evidence ledger');
        expect(String(result.error)).toContain('ledger freeze');
        // And the diagnostics name the state, so a caller can tell "nothing recorded" from "recorded and unreadable".
        expect((result.diagnostics as { ledger?: { state?: string } } | undefined)?.ledger?.state).toBe('absent');
    });

    it('approves on the ledger and records which route did it', async () => {
        const root = await reviewTask('ledger-task');
        await passLedger(root, 'ledger-task');

        const result = await approve(root, 'ledger-task');
        expect(result.error).toBeUndefined();
        expect(result.success).toBe(true);

        const record = JSON.parse(await readFile(reviewPath(root, 'ledger-task'), 'utf8')) as {
            status: string;
            reviewRoute: string;
            ledgerReview: { subjectRevision: string; tier: string; assurance: string; claims: number; limits: string[] };
        };
        expect(record.status).toBe('approved');
        expect(record.reviewRoute).toBe('ledger');
        expect(record.ledgerReview.tier).toBe('strict');
        expect(record.ledgerReview.assurance).toBe('observed');
        expect(record.ledgerReview.claims).toBe(3);
        expect(record.ledgerReview.subjectRevision).toMatch(/^rev:[0-9a-f]{16}$/u);
        // The limit is recorded rather than implied: this route does not establish who wrote the claims.
        expect(record.ledgerReview.limits.join(' ')).toContain('not who wrote the claims');
    });

    it('refuses when the ledger does not pass, naming the kernel\'s reason', async () => {
        const root = await reviewTask('failing-ledger-task');
        const subject = await freezeSubject({ root, paths: ['src/workflow/ledger-review.ts'] });
        if (!subject.ok) return;
        await writeSubject(root, 'failing-ledger-task', subject.subject);
        await ensureAssurance(root, 'failing-ledger-task', 'observed');
        await appendClaim(root, 'failing-ledger-task', makeClaim({
            id: 'C1',
            severity: 'major',
            evidenceIds: ['E1'],
            dependsOn: ['path:src/workflow/ledger-review.ts'],
        }));

        const result = await approve(root, 'failing-ledger-task');
        expect(result.success).toBe(false);
        expect(String(result.error)).toContain('evidence ledger does not pass');
        expect(String(result.error)).toContain('claim_unsupported');
    });

    it('refuses a ledger whose subject has moved, naming the path', async () => {
        const root = await reviewTask('drifted-ledger-task');
        await passLedger(root, 'drifted-ledger-task');
        await writeFile(join(root, 'src', 'workflow', 'ledger-review.ts'), 'export const x = 2;\n');

        const result = await approve(root, 'drifted-ledger-task');
        expect(result.success).toBe(false);
        expect(String(result.error)).toContain('has moved since it was frozen');
        expect(String(result.error)).toContain('src/workflow/ledger-review.ts');
    });

    it('refuses a ledger that exists and cannot be read', async () => {
        const root = await reviewTask('broken-ledger-task');
        await mkdir(reviewDir(root, 'broken-ledger-task'), { recursive: true });
        await writeFile(join(reviewDir(root, 'broken-ledger-task'), 'claims.json'), '{ not json');

        const result = await approve(root, 'broken-ledger-task');
        expect(result.success).toBe(false);
        expect(String(result.error)).toContain('cannot be judged by the evidence ledger');
        expect(String(result.error)).toContain('claims.json');
    });

    it('refuses a ledger whose evidence nobody watched being produced, at the strict floor', async () => {
        const root = await reviewTask('unobserved-ledger-task');
        // `src/workflow/**` is floored at strict, and strict requires that kata observed the evidence, so a ledger
        // carrying `none` cannot hold the approval even though every verdict in it passes.
        await passLedger(root, 'unobserved-ledger-task', { assurance: 'none' });

        const result = await approve(root, 'unobserved-ledger-task');
        expect(result.success).toBe(false);
        expect(String(result.error)).toContain('assurance');
    });
});
