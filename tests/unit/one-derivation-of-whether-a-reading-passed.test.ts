import { afterEach, describe, expect, it } from 'vitest';
import { isPassing } from '../../src/quality/evidence.js';
import { readUpstreamSummary } from '../../src/workflow/navigation.js';
import { evaluateAcceptanceAdequacy } from '../../src/quality/evidence-adequacy.js';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { evidenceDir } from '../../src/core/layout.js';
import { writeTaskRecord } from '../helpers/task-fixture.js';

/**
 * **AC-5 — one answer to "did this reading pass".**
 *
 * A check may declare the exit code that proves it: `expectExitCode: 1` is a check whose sentence is "this fails as it
 * should". Three readers answered the question three ways — the claim evaluator honoured the declaration, the seal's
 * predicate asked `exitCode === 0`, and the router's `failingEvidence` asked `exitCode !== 0` — so one envelope was a
 * proved sentence, a failing check, and a piece of failing evidence at the same time. The router's answer is the one with
 * teeth: `failingEvidence > 0` routes the operator to `/kata-build` to repair a check that already did what it declared.
 *
 * These cases pin the declared contract at each face, and pin that an envelope written before the field existed is still
 * read the old way rather than re-classified.
 */
const roots: string[] = [];

async function tempRoot(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'kata-one-pass-rule-'));
    roots.push(root);
    return root;
}

afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('one derivation of whether a reading passed', () => {
    it('honours the exit code the check declared, and falls back for an envelope written before the field existed', () => {
        // The declared contract: exitCode === (expectExitCode ?? 0).
        expect(isPassing({ exitCode: 1, expectExitCode: 1 })).toBe(true);
        expect(isPassing({ exitCode: 0, expectExitCode: 1 })).toBe(false);
        expect(isPassing({ exitCode: 1, expectExitCode: 0 })).toBe(false);
        expect(isPassing({ exitCode: 0 })).toBe(true);
        expect(isPassing({ exitCode: 1 })).toBe(false);
        // A stamped verdict wins over the arithmetic, which is what the field is for.
        expect(isPassing({ exitCode: 1, expectExitCode: 0, passed: true })).toBe(true);
    });

    it('is the rule the adequacy evaluator reads, so one envelope cannot be passed and failed at once', () => {
        const envelope = {
            id: 'evidence-1',
            taskId: 'one-pass-rule',
            kind: 'test' as const,
            command: 'npm test',
            exitCode: 1,
            expectExitCode: 1,
            diffHash: 'd'.repeat(64),
            at: '2026-10-09T00:00:00.000Z',
        };
        const adequacy = evaluateAcceptanceAdequacy({
            acceptance: [{ id: 'AC-1', statement: 'It holds.' }],
            evidence: [{ ...envelope, coveredAcceptanceIds: ['AC-1'] } as never],
            currentDiffHash: envelope.diffHash,
        });
        // The evaluator and the shared predicate must agree: this is the check `failingEvidence` is counted from.
        expect(isPassing(envelope)).toBe(true);
        expect(JSON.stringify(adequacy)).not.toContain('failing_evidence');
    });

    it('counts a declared non-zero exit as passing evidence, not as a failure to repair', async () => {
        const root = await tempRoot();
        const taskId = 'one-pass-rule';
        await mkdir(join(root, '.kata', 'tasks', taskId), { recursive: true });
        await writeTaskRecord(root, { id: taskId, phase: 'hardVerify', acceptance: [{ id: 'AC-1', statement: 'It holds.' }] });
        await mkdir(evidenceDir(root), { recursive: true });
        await writeFile(join(evidenceDir(root), `${taskId}-declared.json`), `${JSON.stringify({
            id: 'evidence-declared',
            taskId,
            checkId: 'declared',
            checkSource: 'configured',
            name: 'declared',
            kind: 'test',
            command: 'npm test',
            exitCode: 1,
            expectExitCode: 1,
            passed: true,
            diffHash: 'd'.repeat(64),
            at: '2026-10-09T00:00:00.000Z',
        })}\n`);

        const summary = await readUpstreamSummary(root, taskId);

        // Measured before the fix: `failingEvidence: 1` for this envelope, because the count asked `exitCode !== 0`.
        expect(summary.failingEvidence).toBe(0);
    });

    it('still counts an ordinary failure as failing evidence, so the count is not simply zero', async () => {
        const root = await tempRoot();
        const taskId = 'one-pass-rule';
        await mkdir(join(root, '.kata', 'tasks', taskId), { recursive: true });
        await writeTaskRecord(root, { id: taskId, phase: 'hardVerify', acceptance: [{ id: 'AC-1', statement: 'It holds.' }] });
        await mkdir(evidenceDir(root), { recursive: true });
        await writeFile(join(evidenceDir(root), `${taskId}-broken.json`), `${JSON.stringify({
            id: 'evidence-broken',
            taskId,
            checkId: 'broken',
            checkSource: 'configured',
            name: 'broken',
            kind: 'test',
            command: 'npm test',
            exitCode: 1,
            passed: false,
            diffHash: 'd'.repeat(64),
            at: '2026-10-09T00:00:00.000Z',
        })}\n`);

        const summary = await readUpstreamSummary(root, taskId);

        expect(summary.failingEvidence).toBe(1);
    });
});
