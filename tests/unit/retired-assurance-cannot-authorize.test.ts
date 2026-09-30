import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initLayout, reviewPath } from '../../src/core/layout.js';
import { createTask } from '../../src/core/task.js';
import { writeCurrentState } from '../../src/core/state.js';
import { runCommand } from '../../src/workflow/orchestrator.js';
import { createTaskRevisionIfChanged } from '../../src/workflow/revision.js';
import { meetsAssuranceFloor } from '../../src/kernel/policy.js';
import { defaultPolicy } from '../../src/kernel/policy.js';
import { appendChallenge, appendClaim, appendEvidence, freezeSubject, readLedger, recordVerdicts, reviewDir, writePlan, writeSubject } from '../../src/store/ledger.js';
import { planReview } from '../../src/producers/planner.js';
import { makeClaim, makeVerdict } from '../helpers/review.js';

/**
 * **A retired assurance value must not authorise anything, and must not be written back as if it were current.**
 *
 * Measured when the earlier refusal branch was deleted (round 1's F2): with a *passing* ledger whose `usage.assurance`
 * said `sandboxed`, `review --approve` returned `success: true` and wrote `"assurance": "sandboxed"` into a fresh
 * review record — a value no current adapter can produce, re-emitted by a current writer. The branch that returned it
 * was removed on the reasoning that a later round now replaces an earlier value; that reasoning covers *recording* and
 * not *deciding*, so the decision surface still has to answer the question the value is asked.
 *
 * **Why this file now drives the surface instead of grepping the source.** The first version of this case asserted that
 * `orchestrator.ts` contained the guard's text. An independent review measured the hole that leaves: deleting the whole
 * branch while leaving the string — or a comment — kept it green, so the rule it exists to protect had no evidence.
 * Both cases below build the state and read the outcome.
 */
describe('a retired assurance value cannot authorise a decision', () => {
    const roots: string[] = [];
    afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

    const path = 'src/workflow/retired-assurance.ts';
    const ALT_PATH = 'src/app/report.ts';

    async function taskWithArchiveSafeLedger(id: string, assurance: 'observed' | 'sandboxed', options: { ownedPaths?: string[] } = {}): Promise<string> {
        const root = await mkdtemp(join(tmpdir(), 'kata-retired-assurance-'));
        roots.push(root);
        await initLayout(root);
        await createTask({
            root,
            id,
            title: 'Retired assurance',
            acceptance: [{ id: 'AC-1', statement: 'The export is present.' }],
            ownedPaths: options.ownedPaths ?? [path],
        });
        const subjectPath = options.ownedPaths?.[0] ?? path;
        await mkdir(join(root, subjectPath.split('/').slice(0, -1).join('/')), { recursive: true });
        await writeFile(join(root, subjectPath), 'export const x = 1;\n');
        await writeCurrentState(root, {
            taskId: id,
            phase: 'review',
            actor: { id: 'kata-agent', role: 'reviewer' },
            updatedAt: '2026-09-30T00:00:00.000Z',
        });

        const subject = await freezeSubject({ root, paths: [subjectPath] });
        expect(subject.ok).toBe(true);
        if (!subject.ok) return root;
        await writeSubject(root, id, subject.subject);
        // The request has to speak for a sealed revision, so the fixture seals before it plans.
        await createTaskRevisionIfChanged({ root, taskId: id, ownedPaths: [subjectPath], checkIds: [] });
        // **The historical value, written the way history wrote it.** `ensureAssurance` now refuses a retired value, so
        // the fixture puts the bytes there directly — which is exactly the state a change sealed before the retirement
        // is in, and the state the guard has to answer.
        await mkdir(reviewDir(root, id), { recursive: true });
        await writeFile(
            join(reviewDir(root, id), 'usage.json'),
            `${JSON.stringify({ usage: {}, assurance }, null, 2)}\n`,
        );

        for (const [index, riskClass] of (['consistency', 'boundary', 'failure_mode'] as const).entries()) {
            const evidenceId = `E${index + 1}`;
            await appendClaim(root, id, makeClaim({
                id: `C${index + 1}`,
                severity: 'major',
                riskClass,
                evidenceIds: [evidenceId],
                dependsOn: [`path:${subjectPath}`],
            }));
            await appendEvidence(root, id, {
                id: evidenceId,
                type: 'executable_falsifier',
                command: `grep -q export ${subjectPath}`,
                mutation: { file: subjectPath, find: 'export', replace: 'broken' },
            });
            await recordVerdicts(root, id, [makeVerdict({ evidenceId, subjectRevision: subject.subject.revision })]);
        }
        await appendChallenge(root, id, {
            id: 'X1',
            claimId: 'C1',
            command: 'exit 1',
            failsOn: subject.subject.revision,
            state: 'withdrawn',
            at: '2026-09-30T00:00:00.000Z',
            resolution: { at: '2026-09-30T00:01:00.000Z', observed: 'exit 0 when checked against the frozen subject' },
            reproduced: true,
        });
        await writePlan(root, id, planReview({
            subject: subject.subject,
            claims: (await readLedger(root, id)).claims,
            policy: defaultPolicy(),
            tier: 'strict',
            changedPaths: [subjectPath],
            c0Tokens: null,
        }));
        return root;
    }

    it('does not satisfy a floor, even the floor it used to be at or above', () => {
        const policy = defaultPolicy();
        // `sandboxed` outranks `observed` in ASSURANCE_RANK because historical records still have to compare; that rank
        // is what let a value nobody can produce satisfy the floor of a tier that no longer accepts it.
        expect(meetsAssuranceFloor(policy, 'security', 'sandboxed')).toBe(false);
        expect(meetsAssuranceFloor(policy, 'security', 'observed')).toBe(true);
    });

    it('is refused by the approval surface rather than copied into a new review record', async () => {
        const root = await taskWithArchiveSafeLedger('retired-assurance-task', 'sandboxed');

        const result = await runCommand('review', 'retired-assurance-task', root, {
            approve: true,
            reviewEvidence: 'the ledger decides it; see the claim set',
            confirmHostModel: true,
        });

        // **The refusal, driven, not grepped.** The retirement is enforced at two layers and this asserts the one that
        // fires first: the *decision* layer refuses the retired value as a floor, before any record is written. The
        // message names the value and the floor, so a caller can tell this from "no evidence".
        expect(result.success).toBe(false);
        expect(String(result.error)).toContain('sandboxed');
        expect(String(result.error)).toContain('below the strict floor');
        // The guard downstream is belt-and-braces for the same fact; when the decision layer already refuses, the
        // sentence is this one — and the test above proves the refusal is about the value, not about missing evidence.
        expect((result.diagnostics as { ledger?: { legacyAssurance?: boolean } } | undefined)?.ledger?.legacyAssurance ?? false).toBe(false);

        // And it did not write the value it refused into a fresh record. A missing record is the expected state here;
        // a record that exists must not carry `sandboxed`.
        const record = await readFile(reviewPath(root, 'retired-assurance-task'), 'utf8').then(
            (raw) => JSON.parse(raw) as { status?: string; ledgerReview?: { assurance?: string } },
            () => null,
        );
        expect(record?.ledgerReview?.assurance).not.toBe('sandboxed');
        expect(record?.status).not.toBe('approved');
    });

    it('is stopped before the retired-value guard, so the guard is defensive rather than load-bearing', async () => {
        // **What this case measured, and why it is an assertion about reachability rather than a fabricated path.**
        // The guard downstream of the verdict check refuses a retired value by name. Reaching it needs the ledger to
        // *pass*, which needs a tier whose floor the retired rank satisfies (`none`, i.e. `standard`) — but
        // `policy.ledgerTierCeiling: 'strict'` means `resolveTier` never returns below `strict` on the ledger route, and
        // the `--tier` override exists only on `ledger decide`, not on `review --approve`. So a retired value is always
        // stopped *earlier*, by `assurance_below_tier`, and the guard is unreachable from the CLI.
        //
        // The two facts are pinned separately so neither can drift silently: the floor refuses the value (asserted in the
        // case above), and the ceiling keeps the guard out of reach (asserted here). If a later change lowers the ceiling
        // or widens the override, this case reddens and the guard acquires an owner.
        const root = await taskWithArchiveSafeLedger('unreachable-guard-task', 'sandboxed', { ownedPaths: [ALT_PATH] });

        const result = await runCommand('review', 'unreachable-guard-task', root, {
            approve: true,
            reviewEvidence: 'the ledger decides it; see the claim set',
            confirmHostModel: true,
        });

        expect(result.success).toBe(false);
        // Stopped by the floor's own sentence, not by the retired-value guard.
        expect(String(result.error)).toContain('below the strict floor');
        expect(String(result.error)).not.toContain('historical assurance');
        expect((result.diagnostics as { ledger?: { legacyAssurance?: boolean } } | undefined)?.ledger?.legacyAssurance ?? false).toBe(false);
    });

    it('approves the same ledger once the recorded round is observed, so the refusal is about the value', async () => {
        const root = await taskWithArchiveSafeLedger('observed-assurance-task', 'observed');

        const result = await runCommand('review', 'observed-assurance-task', root, {
            approve: true,
            reviewEvidence: 'the ledger decides it; see the claim set',
            confirmHostModel: true,
        });

        expect(result.error).toBeUndefined();
        expect(result.success).toBe(true);
    });
});
