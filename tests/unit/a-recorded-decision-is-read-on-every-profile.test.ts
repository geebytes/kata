import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initLayout, reviewPath, taskPath } from '../../src/core/layout.js';
import { runCommand } from '../../src/workflow/orchestrator.js';
import { buildChangeRecord, writeChangeRecord } from '../../src/quality/change-record.js';
import { reviewRoundsPath } from '../../src/quality/repair.js';
import { createTaskRevisionIfChanged } from '../../src/workflow/revision.js';

/**
 * **A refusal prints a road that runs from the state that refused, on every profile.**
 *
 * Measured as an independent finding on this line of work (`gate-r10-F3`): when a closure contract names no check at all, the
 * seal refuses and prints the only two roads that exist — have a round name the check it means, or record a decision naming
 * `obligation:<class>`. The second road was **unexecutable on the std profile**, because the seal preflight read the
 * recorded decisions only inside its `requiresMatrix` branch: the operator recorded exactly what the refusal asked for and
 * the same refusal came back, unchanged, forever.
 *
 * That is the class this repository names `refusal-cannot-be-executed` — a defect about the mechanism's own message, not
 * about the change it was refusing — and it is a stop-line candidate, so it is fixed here rather than re-reported.
 *
 * The fix is a **read**, not a new gate: the decision is read, merged and validated on every profile, while the
 * matrix-specific consumers (path coverage, CodeGraph disposition) stay where they were. The property asserted below is the
 * one the design asks for: the same contract and the same decision answer the same way, whichever profile the task runs.
 */

const taskId = 'a-decision-is-read-on-every-profile';
const passingCheck = { kind: 'test' as const, command: process.execPath, args: ['-e', 'process.exit(0)'] };

/** The decision the refusal asks for, in the shape the reader accepts. */
const decision = (defectClass: string) => [{
    path: `obligation:${defectClass}`,
    reason: 'the declared effectivenessTest is a description rather than a check; the round that wrote it cannot name one here',
    approvedBy: 'the-owner',
    createdAt: '2026-01-04T00:00:00.000Z',
}];

describe('a recorded decision is read on every profile', () => {
    const roots: string[] = [];

    afterEach(async () => {
        await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
    });

    async function repo(reviewMode: 'std' | 'strict'): Promise<string> {
        const root = await mkdtemp(join(tmpdir(), 'kata-decision-'));
        roots.push(root);
        await initLayout(root);
        execFileSync('git', ['init', '--quiet'], { cwd: root });
        execFileSync('git', ['config', 'user.email', 'kata@example.test'], { cwd: root });
        execFileSync('git', ['config', 'user.name', 'Kata Test'], { cwd: root });
        await writeFile(join(root, 'owned.ts'), 'export const holds = true;\n', 'utf8');
        await writeFile(join(root, 'test.mjs'), 'process.exit(0);\n', 'utf8');
        execFileSync('git', ['add', '-A'], { cwd: root });
        execFileSync('git', ['commit', '--quiet', '-m', 'baseline'], { cwd: root });
        await runCommand('open', taskId, root, {
            title: 'A decision is read on every profile',
            acceptance: [{ id: 'AC-1', statement: 'The recorded decision releases the contract it names.' }],
            ownedPaths: ['owned.ts', 'test.mjs'],
        });
        await runCommand('design', taskId, root);
        if (reviewMode === 'strict') {
            // **The profile is part of the task's own record, and strict is not only a review mode.** `requiresMatrix` is true
            // for it, so a strict task without an acceptance matrix is refused for that reason before any obligation is read —
            // which is how the first version of this case measured the wrong refusal. The matrix is declared here so the two
            // profiles are compared on the fact this test is about.
            const raw = JSON.parse(await readFile(taskPath(root, taskId), 'utf8')) as { workflowProfile?: Record<string, unknown> };
            await writeFile(taskPath(root, taskId), `${JSON.stringify({
                ...raw,
                workflowProfile: { ...(raw.workflowProfile ?? {}), reviewMode: 'strict' },
                acceptanceMatrix: {
                    version: 1,
                    rows: [{
                        acceptanceId: 'AC-1',
                        implementationPaths: ['owned.ts'],
                        testPaths: ['test.mjs'],
                        evidence: [{ id: 'ac-1', kind: 'test', command: `${process.execPath} -e process.exit(0)`, testSelector: 'test.mjs' }],
                        verificationLevel: 'unit',
                    }],
                },
            }, null, 2)}\n`);
        }
        return root;
    }

    /**
     * A sealed revision with a root-cause conclusion recorded against it, whose contract names no check — the state whose
     * refusal carries the decision road.
     */
    async function withUnverifiableContract(root: string): Promise<void> {
        const sealed = await createTaskRevisionIfChanged({
            root, taskId, ownedPaths: ['owned.ts', 'test.mjs'], checkIds: ['test'],
        });
        const record = await buildChangeRecord({
            root,
            taskId,
            revisionId: sealed.revision.id,
            ownedPaths: ['owned.ts', 'test.mjs'],
            evidence: [{ id: 'evidence-1', checkId: 'test', exitCode: 0, passed: true }],
            claimFailures: [],
            findings: [],
            ...(sealed.revision.contentDigests ? { contentDigests: sealed.revision.contentDigests } : {}),
        });
        const written = await writeChangeRecord(root, taskId, record);
        if (typeof written !== 'string') throw new Error(`the change record was refused: ${written.refused.join('; ')}`);
        await writeFile(reviewRoundsPath(root, taskId), [
            JSON.stringify({
                at: '2026-01-01T00:00:00.000Z', revisionId: sealed.revision.id, manifestHash: sealed.revision.manifestHash,
                blockingIds: ['F-1'], blockingCount: 1,
                findings: [{ id: 'F-1', severity: 'major', class: 'instrument-unsound', origin: 'original' }],
            }),
            JSON.stringify({
                at: '2026-01-02T00:00:00.000Z', revisionId: sealed.revision.id, manifestHash: sealed.revision.manifestHash,
                blockingIds: ['F-2'], blockingCount: 1,
                findings: [{ id: 'F-2', severity: 'major', class: 'instrument-unsound', origin: 'repair' }],
            }),
        ].join('\n') + '\n');
        await writeFile(reviewPath(root, taskId), `${JSON.stringify({
            revisionId: sealed.revision.id,
            manifestHash: sealed.revision.manifestHash,
            reviewedRevisionId: sealed.revision.id,
            recordedAt: '2026-01-03T00:00:00.000Z',
            reviewKind: 'root_cause',
            recurrenceAnalysis: {
                triggerClasses: ['instrument-unsound'],
                conclusion: 'instrument_unsound',
                evidence: ['review-rounds.jsonl:1-2'],
                nextAction: 'repair',
                closureObligation: {
                    states: ['the class is decided per call site', 'the class is decided by one derivation'],
                    sourceOfTruth: 'theOneDerivation',
                    inventory: ['owned.ts:1'],
                    invariant: 'every site asks the one derivation',
                    repairSurface: ['owned.ts'],
                    // **A description, not a check.** Nothing this seal runs can confirm it, which is the state whose refusal
                    // names the decision road rather than a repair.
                    effectivenessTest: 'the two readers agree about which revision is current',
                    ifRecursAgain: 'rewrite_mechanism',
                },
            },
            findings: [],
            status: 'pending',
        })}\n`);
    }

    for (const reviewMode of ['std', 'strict'] as const) {
        it(`prints a decision road the ${reviewMode} profile actually accepts`, async () => {
            const root = await repo(reviewMode);
            await withUnverifiableContract(root);
            await writeFile(join(root, 'owned.ts'), 'export const holds = "repaired";\n', 'utf8');

            // 1. Without a decision, the seal refuses and asks for one. The road is named in the refusal itself.
            const refused = await runCommand('build', taskId, root, { seal: true, checks: [passingCheck] });
            expect(refused.success).toBe(false);
            const unmet = (refused.diagnostics?.closureObligations as Array<{ unmet: string[] }>)[0]?.unmet.join(' | ') ?? '';
            expect(unmet).toContain('Decide it');
            expect(unmet).toContain(`obligation:instrument-unsound`);

            // 2. The road, taken exactly as printed: the decision recorded by the operator who was asked for it.
            const decided = await runCommand('build', taskId, root, {
                seal: true,
                checks: [passingCheck],
                waivers: decision('instrument-unsound'),
            });
            expect(decided.success, JSON.stringify(decided.diagnostics ?? decided)).toBe(true);

            // 3. **And it is a gap, never a pass.** Where the seal reports the contract at all, the sentence is the decision
            // that released it — with the approver and the reason — and never the claim that the mechanism verified it. (A seal
            // that is the first to satisfy a contract publishes the reading; a later one may not re-open it, and both are
            // honest — what must never appear is "the effectiveness test ran and passed".)
            const checks = (decided.diagnostics?.closureObligations ?? []) as Array<{ satisfied: string[]; unmet: string[]; recordedGaps: string[] }>;
            for (const check of checks) {
                expect(check.unmet).toEqual([]);
                expect(check.satisfied.join(' | ')).not.toContain('effectiveness test ran and passed');
            }
            const gaps = checks.flatMap((check) => check.recordedGaps).join(' | ');
            if (checks.length > 0) expect(gaps).toContain('Decided by the-owner');
        });
    }

    it('reads the decision from the task record too, so it does not have to be supplied on every seal', async () => {
        const root = await repo('std');
        await withUnverifiableContract(root);
        await writeFile(join(root, 'owned.ts'), 'export const holds = "repaired";\n', 'utf8');

        // Supplied once, it is persisted; the next seal finds it without the flag — which is what "recorded" has to mean for
        // a road that is printed on a refusal an operator reads once.
        const first = await runCommand('build', taskId, root, { seal: true, checks: [passingCheck], waivers: decision('instrument-unsound') });
        expect(first.success, JSON.stringify(first.diagnostics ?? first)).toBe(true);

        // **And it was persisted, not merely accepted.** The second seal is given no flag, and the contract it would otherwise
        // refuse is released by the record the first one wrote — which is what "recorded" has to mean for a road printed on a
        // refusal an operator reads once.
        await writeFile(join(root, 'owned.ts'), 'export const holds = "repaired again";\n', 'utf8');
        const second = await runCommand('build', taskId, root, { seal: true, checks: [passingCheck] });
        expect(second.success, JSON.stringify(second.diagnostics ?? second)).toBe(true);
        const persisted = JSON.parse(await readFile(join(root, '.kata/tasks', taskId, 'waivers.json'), 'utf8')) as { waivers: Array<{ path: string }> };
        expect(persisted.waivers.map((entry) => entry.path)).toContain('obligation:instrument-unsound');
    });
});
