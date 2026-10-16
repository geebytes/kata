import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initLayout, reviewPath } from '../../src/core/layout.js';
import { runCommand } from '../../src/workflow/orchestrator.js';
import { buildChangeRecord, writeChangeRecord } from '../../src/quality/change-record.js';
import { reviewRoundsPath } from '../../src/quality/repair.js';
import { createTaskRevisionIfChanged } from '../../src/workflow/revision.js';

/**
 * **The closure obligation is compared against the work, not only against its own prose.**
 *
 * The packet demands seven named fields and the review validator refuses a `repair` conclusion without them — and until the
 * seal read them again, that was the whole mechanism: a repair could declare one `sourceOfTruth`, fix one call site, declare
 * an `effectivenessTest` and never run it, and seal. Measured on this line of work: five rounds, three classes, three sites,
 * every round reporting itself as a class-level fix, because "what would close this class" was a sentence in a record that no
 * later command consulted.
 *
 * The seal is where the arrow meets the work, so the check lives there. What it enforces is the four fields that can be
 * checked — the declared surface was touched, the inventory exists, the effectiveness test ran and passed, the exit is a real
 * word — and the prose (`states`, `sourceOfTruth`, `invariant`) is deliberately left to the class-level review rather than
 * pretended to be verified by a substring.
 */
const taskId = 'an-obligation-is-checked';
const passingCheck = { kind: 'test' as const, command: process.execPath, args: ['-e', 'process.exit(0)'] };

describe('a seal has to satisfy the closure contract a root-cause round wrote', () => {
    const roots: string[] = [];

    afterEach(async () => {
        await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
    });

    async function repo(): Promise<string> {
        const root = await mkdtemp(join(tmpdir(), 'kata-obligation-'));
        roots.push(root);
        await initLayout(root);
        execFileSync('git', ['init', '--quiet'], { cwd: root });
        execFileSync('git', ['config', 'user.email', 'kata@example.test'], { cwd: root });
        execFileSync('git', ['config', 'user.name', 'Kata Test'], { cwd: root });
        await writeFile(join(root, 'owned.ts'), 'export const holds = true;\n', 'utf8');
        await writeFile(join(root, 'untouched.ts'), 'export const other = true;\n', 'utf8');
        await writeFile(join(root, 'test.mjs'), 'process.exit(0);\n', 'utf8');
        execFileSync('git', ['add', '-A'], { cwd: root });
        execFileSync('git', ['commit', '--quiet', '-m', 'baseline'], { cwd: root });
        await runCommand('open', taskId, root, {
            title: 'An obligation is checked',
            acceptance: [{ id: 'AC-1', statement: 'The seal satisfies the contract.' }],
            ownedPaths: ['owned.ts', 'untouched.ts', 'test.mjs'],
        });
        await runCommand('design', taskId, root);
        return root;
    }

    /** A task sealed once, with a root-cause conclusion recorded against that revision — the state a repair starts from. */
    async function withRecordedObligation(input: {
        root: string;
        obligation: Record<string, unknown>;
        conclusion?: string;
        nextAction?: string;
    }): Promise<{ revisionId: string; manifestHash: string }> {
        const sealed = await createTaskRevisionIfChanged({
            root: input.root,
            taskId,
            ownedPaths: ['owned.ts', 'untouched.ts', 'test.mjs'],
            checkIds: ['test'],
        });
        const record = await buildChangeRecord({
            root: input.root,
            taskId,
            revisionId: sealed.revision.id,
            ownedPaths: ['owned.ts', 'untouched.ts', 'test.mjs'],
            evidence: [{ id: 'evidence-1', checkId: 'test', exitCode: 0, passed: true }],
            claimFailures: [],
            findings: [],
            ...(sealed.revision.contentDigests ? { contentDigests: sealed.revision.contentDigests } : {}),
        });
        const written = await writeChangeRecord(input.root, taskId, record);
        if (typeof written !== 'string') throw new Error(`the change record was refused: ${written.refused.join('; ')}`);
        // The rounds the conclusion is about: a class recurring inside a repair, which is what the packet fires on.
        await writeFile(reviewRoundsPath(input.root, taskId), [
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
        await writeFile(reviewPath(input.root, taskId), `${JSON.stringify({
            revisionId: sealed.revision.id,
            manifestHash: sealed.revision.manifestHash,
            reviewedRevisionId: sealed.revision.id,
            recordedAt: '2026-01-03T00:00:00.000Z',
            reviewKind: 'root_cause',
            recurrenceAnalysis: {
                triggerClasses: ['instrument-unsound'],
                conclusion: input.conclusion ?? 'instrument_unsound',
                evidence: ['review-rounds.jsonl:1-2'],
                nextAction: input.nextAction ?? 'repair',
                closureObligation: input.obligation,
            },
            findings: [],
            status: 'pending',
        })}\n`);
        return { revisionId: sealed.revision.id, manifestHash: sealed.revision.manifestHash };
    }

    const obligationFor = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
        states: ['the class is decided per call site', 'the class is decided by one derivation'],
        sourceOfTruth: 'theOneDerivation',
        inventory: ['owned.ts:1'],
        invariant: 'every site asks the one derivation',
        repairSurface: ['owned.ts'],
        effectivenessTest: 'test.mjs',
        ifRecursAgain: 'rewrite_mechanism',
        ...overrides,
    });

    it('refuses a repair that did not touch the surface its own contract named', async () => {
        const root = await repo();
        await withRecordedObligation({ root, obligation: obligationFor() });

        // The repair changes `untouched.ts` — real work, nowhere near the class the round contracted to close.
        await writeFile(join(root, 'untouched.ts'), 'export const other = false;\n', 'utf8');
        const result = await runCommand('build', taskId, root, { seal: true, checks: [passingCheck] });

        expect(result.success).toBe(false);
        expect(result.diagnostics?.reason).toBe('closure_obligation_unmet');
        const unmet = (result.diagnostics?.closureObligations as Array<{ unmet: string[] }>)[0].unmet.join(' | ');
        expect(unmet).toContain('touched none of its declared repairSurface');
        expect(result.error).toContain('closure contract');
    });

    it('refuses a contract whose inventory or effectiveness test is not real', async () => {
        const root = await repo();
        // An inventory naming a site that does not exist, and an effectiveness test no check in this seal ran.
        await withRecordedObligation({
            root,
            obligation: obligationFor({ inventory: ['src/invented.ts:1'], effectivenessTest: 'tests/unit/never-ran.test.ts' }),
        });
        await writeFile(join(root, 'owned.ts'), 'export const holds = false;\n', 'utf8');

        const result = await runCommand('build', taskId, root, { seal: true, checks: [passingCheck] });

        expect(result.success).toBe(false);
        const unmet = (result.diagnostics?.closureObligations as Array<{ unmet: string[] }>)[0].unmet.join(' | ');
        expect(unmet).toContain('inventory names sites that do not exist');
        expect(unmet).toContain('effectivenessTest');
    });

    it('refuses a surface the change does not declare, and accepts the repair that satisfies all four readings', async () => {
        const root = await repo();
        // A path this change does not own cannot be its repair: the obligation is a statement about work, and an undeclared
        // path is work nobody recorded.
        await withRecordedObligation({ root, obligation: obligationFor({ repairSurface: ['not-owned.ts'] }) });
        await writeFile(join(root, 'owned.ts'), 'export const holds = false;\n', 'utf8');
        const undeclared = await runCommand('build', taskId, root, { seal: true, checks: [passingCheck] });
        expect(undeclared.success).toBe(false);
        expect((undeclared.diagnostics?.closureObligations as Array<{ unmet: string[] }>)[0].unmet.join(' | '))
            .toContain('does not declare');

        // **A refusal is not a way past the gate.** The refused seal already minted its revision — the check needs the content
        // it hashed — so re-running meets a new base revision. The obligation is owed by the change, not by one attempt, so it
        // is still enforced: the surface it names is untouched, and this second attempt is refused for that reason.
        const retry = await runCommand('build', taskId, root, { seal: true, checks: [passingCheck] });
        expect(retry.success).toBe(false);
        expect(retry.diagnostics?.reason).toBe('closure_obligation_unmet');

        // **The remedy the refusal names, taken.** A contract that names a path this change does not own cannot be satisfied by
        // any seal, so the way forward is a corrected conclusion — a new root-cause round's answer, recorded here the way that
        // round would record it — not another attempt at the same seal.
        await withRecordedObligation({ root, obligation: obligationFor() });
        // And the repair that satisfies it: the surface moved away from the content that conclusion was written about.
        await writeFile(join(root, 'owned.ts'), 'export const holds = "repaired";\n', 'utf8');
        const satisfied = await runCommand('build', taskId, root, { seal: true, checks: [passingCheck] });
        expect(satisfied.success, JSON.stringify(satisfied.diagnostics ?? satisfied)).toBe(true);
        const checks = satisfied.diagnostics?.closureObligations as Array<{ defectClass: string; satisfied: string[]; unmet: string[] }>;
        expect(checks).toHaveLength(1);
        expect(checks[0].defectClass).toBe('instrument-unsound');
        expect(checks[0].unmet).toEqual([]);
        expect(checks[0].satisfied.join(' | ')).toContain('effectiveness test ran and passed');
        expect(checks[0].satisfied.join(' | ')).toContain('repairSurface');
    });

    it('asks nothing of a change with no obligation, and nothing twice', async () => {
        const root = await repo();
        // No declaration at all: the ordinary change, which must not pay for a mechanism it never used.
        const plain = await runCommand('build', taskId, root, { seal: true, checks: [passingCheck] });
        expect(plain.success, JSON.stringify(plain)).toBe(true);
        expect(plain.diagnostics?.closureObligations).toBeUndefined();

        // A conclusion that does not ask for a repair contracts nothing, so the seal it precedes is not judged by it.
        await withRecordedObligation({
            root,
            obligation: obligationFor(),
            conclusion: 'claim_scope_error',
            nextAction: 'restate_claim',
        });
        const notRepairing = await runCommand('build', taskId, root, { seal: true, checks: [passingCheck] });
        expect(notRepairing.success, JSON.stringify(notRepairing)).toBe(true);
        expect(notRepairing.diagnostics?.closureObligations).toBeUndefined();
    });
});
