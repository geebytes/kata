import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runLedgerCommand } from '../../src/cli/ledger.js';
import { runCommand } from '../../src/workflow/orchestrator.js';
import { writeCurrentState } from '../../src/core/state.js';
import { freezeSubject, readLedger, writePlan, writePolicy, writeSubject } from '../../src/store/ledger.js';
import { buildReviewRequest } from '../../src/store/review-request.js';
import { writeTaskRecord } from '../helpers/task-fixture.js';

/**
 * **AC-3 — a request carries the boundary a claim closes over, and a finding can say whether it landed inside it.**
 *
 * A negative-classifier claim ("no shape of this kind") is a statement about a *judged domain*, and the domain has an edge:
 * a reviewer trying to falsify it can always produce a shape just outside the edge, which looks exactly like a counterexample
 * until someone states where the claim stops. There was nowhere to state it — `review-claim.schema.json` had no
 * `boundary`/`closure`/`scope`/`limit` field and `review-finding.schema.json` had no `insideDeclaredBoundary` — so the edge
 * lived in prose, and a reviewer's severity choice was the only signal of whether the finding was inside the claim or past
 * it. Measured downstream: 40 recorded findings, 14 consecutive `verify` passes, and the same criterion's boundary wording
 * filed as `major` five times, each one triggering a mandatory repair round.
 *
 * This is the *declaring* and *carrying* half: the claim states its boundary, the request hands it to the reviewer, and a
 * finding records where it landed. What routing does with an inside-boundary finding is a separate decision and is not
 * changed here.
 */
const changeId = 'declaration-boundary';
const roots: string[] = [];

afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/**
 * A workspace staged the way the workflow stages it: the boundary is declared **before** the freeze, because the subject
 * digests the claims — a claim declared afterwards moves the declared question and every recording is then refused (measured
 * here first: the fixture added its claim after freezing and the record was refused with "the sealed revision moved").
 */
async function tempRoot(beforeFreeze?: (root: string) => Promise<void>): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'kata-boundary-'));
    roots.push(root);
    await mkdir(join(root, '.kata', 'tasks', changeId), { recursive: true });
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src', 'a.ts'), 'export const holds = true;\n');
    await writeTaskRecord(root, {
        id: changeId,
        phase: 'hardVerify',
        acceptance: [{ id: 'AC-1', statement: 'The thing holds.' }],
        ownedPaths: ['src/a.ts'],
    });
    const { defaultPolicy } = await import('../../src/kernel/policy.js');
    await writePolicy(root, changeId, defaultPolicy());
    await beforeFreeze?.(root);
    const frozen = await freezeSubject({ root, paths: ['src/a.ts'] });
    if (!frozen.ok) throw new Error(frozen.error);
    await writeSubject(root, changeId, frozen.subject);
    await writePlan(root, changeId, {
        tier: 'strict',
        readingSets: [{ claimId: 'C-1', paths: ['src/a.ts'], truncated: false }],
        requiredEvidence: [{ claimId: 'C-1', types: [], minimumStrength: 0 }],
        discovery: { deadlineToolCalls: null },
    });
    // The task revision is what a review records against, and the ledger subject is not it: the sealer writes the pointer
    // (measured here — without it every recording was refused with "the sealed revision moved or became unavailable").
    const { createTaskRevisionIfChanged } = await import('../../src/workflow/revision.js');
    await createTaskRevisionIfChanged({ root, taskId: changeId, ownedPaths: ['src/a.ts'], checkIds: [] });
    await writeCurrentState(root, { taskId: changeId, phase: 'review', actor: { id: 'kata-reviewer', role: 'reviewer' }, updatedAt: '2026-10-09T00:00:00.000Z' });
    return root;
}

async function ledger(root: string, argv: string[]): Promise<Record<string, unknown>> {
    const chunks: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
        chunks.push(String(chunk));
        return true;
    });
    const previous = process.exitCode;
    process.exitCode = 0;
    try {
        await runLedgerCommand(argv, { root, changeId });
    } finally {
        spy.mockRestore();
        process.exitCode = previous;
    }
    const text = chunks.join('');
    const start = text.indexOf('{');
    return start < 0 ? {} : JSON.parse(text.slice(start)) as Record<string, unknown>;
}

describe('a claim declares the boundary it closes over', () => {
    it('keeps the declaration on the claim and hands it to the reviewer', async () => {
        let declared: Record<string, unknown> = {};
        const root = await tempRoot(async (workspace) => {
            declared = await ledger(workspace, ['claim', 'add', '--id', 'C-1', '--statement', 'no fixture reads the live store', '--risk-class', 'boundary', '--severity', 'major', '--depends-on', 'path:src/a.ts', '--boundary', 'the fixtures under tests/unit that write a task record; a fixture that writes outside them is past this claim']);
        });

        expect(declared.ok, JSON.stringify(declared)).toBe(true);
        const claim = (await readLedger(root, changeId)).claims.find((entry) => entry.id === 'C-1');
        // The declaration is part of the claim, not a note beside it: a boundary that lives in prose is one no reader can
        // hold a reviewer to.
        expect(claim?.boundary).toContain('tests/unit');

        const built = await buildReviewRequest({ root, changeId });
        expect(built.ok, JSON.stringify(built)).toBe(true);
        if (!built.ok) return;
        // **Carried, not summarised.** The reviewer reads the boundary the author wrote, on the claim it belongs to.
        expect(built.request.claims.find((entry) => entry.claimId === 'C-1')?.boundary).toBe(claim?.boundary);
    });

    it('leaves a claim without a declaration without one, rather than inventing a default', async () => {
        const root = await tempRoot(async (workspace) => {
            const added = await ledger(workspace, ['claim', 'add', '--id', 'C-1', '--statement', 'the export holds', '--risk-class', 'consistency', '--severity', 'major', '--depends-on', 'path:src/a.ts']);
            expect(added.ok, JSON.stringify(added)).toBe(true);
        });

        const claim = (await readLedger(root, changeId)).claims.find((entry) => entry.id === 'C-1');

        // An absent boundary means "none declared", which is a different statement from an empty one, and a default would
        // silently make every claim closed over something nobody chose.
        expect(claim).not.toHaveProperty('boundary');
        const built = await buildReviewRequest({ root, changeId });
        expect(built.ok).toBe(true);
        if (!built.ok) return;
        expect(built.request.claims.find((entry) => entry.claimId === 'C-1')).not.toHaveProperty('boundary');
    });

    it('refuses a declaration that says nothing', async () => {
        let blank: Record<string, unknown> = {};
        await tempRoot(async (workspace) => {
            blank = await ledger(workspace, ['claim', 'add', '--id', 'C-1', '--statement', 'the export holds', '--risk-class', 'consistency', '--severity', 'major', '--depends-on', 'path:src/a.ts', '--boundary', '   ']);
        });

        expect(blank.ok).toBe(false);
        expect(String(blank.error)).toContain('--boundary');
    });
});

describe('a finding records where it landed', () => {
    it('keeps the field on the record when the reviewer states it', async () => {
        const root = await tempRoot(async (workspace) => {
            await ledger(workspace, ['claim', 'add', '--id', 'C-1', '--statement', 'the export holds', '--risk-class', 'consistency', '--severity', 'major', '--depends-on', 'path:src/a.ts']);
        });
        await mkdir(join(root, 'tmp'), { recursive: true });
        await writeFile(join(root, 'tmp', 'result.json'), `${JSON.stringify({
            findings: [
                { id: 'F-1', taskId: changeId, severity: 'major', acceptanceId: 'AC-1', insideDeclaredBoundary: false, message: 'the export does not hold' },
                { id: 'F-2', taskId: changeId, severity: 'minor', acceptanceId: 'AC-1', insideDeclaredBoundary: true, message: 'a shape past the declaration' },
            ],
        })}\n`);

        const recorded = await runCommand('review', changeId, root, { reviewResultFile: 'tmp/result.json' });

        expect(recorded.success, JSON.stringify(recorded)).toBe(true);
        const record = JSON.parse(await readFile(join(root, '.kata', 'tasks', changeId, 'review.json'), 'utf8')) as { findings: Array<{ id: string; insideDeclaredBoundary?: boolean }> };
        // **Both answers are kept, and they are distinguishable.** A finding inside the declaration is still a finding — the
        // record does not drop it and does not silently treat it as outside; what routing does with the difference is a
        // separate decision.
        expect(record.findings.map((finding) => [finding.id, finding.insideDeclaredBoundary])).toEqual([['F-1', false], ['F-2', true]]);
    });

    it('accepts a finding that says nothing about the boundary, because the claim may declare none', async () => {
        const root = await tempRoot(async (workspace) => {
            await ledger(workspace, ['claim', 'add', '--id', 'C-1', '--statement', 'the export holds', '--risk-class', 'consistency', '--severity', 'major', '--depends-on', 'path:src/a.ts']);
        });
        await mkdir(join(root, 'tmp'), { recursive: true });
        await writeFile(join(root, 'tmp', 'result.json'), `${JSON.stringify({ findings: [{ id: 'F-1', taskId: changeId, severity: 'major', acceptanceId: 'AC-1', message: 'no statement about the boundary' }] })}\n`);

        const recorded = await runCommand('review', changeId, root, { reviewResultFile: 'tmp/result.json' });

        expect(recorded.success, JSON.stringify(recorded)).toBe(true);
        const record = JSON.parse(await readFile(join(root, '.kata', 'tasks', changeId, 'review.json'), 'utf8')) as { findings: Array<Record<string, unknown>> };
        expect(record.findings[0]).not.toHaveProperty('insideDeclaredBoundary');
    });

    it('refuses a value that is not a statement about the boundary', async () => {
        const root = await tempRoot();
        await mkdir(join(root, 'tmp'), { recursive: true });
        await writeFile(join(root, 'tmp', 'result.json'), `${JSON.stringify({ findings: [{ id: 'F-1', taskId: changeId, severity: 'minor', insideDeclaredBoundary: 'yes', message: 'not a boolean' }] })}\n`);

        const recorded = await runCommand('review', changeId, root, { reviewResultFile: 'tmp/result.json' });

        expect(recorded.success).toBe(false);
        expect(String(recorded.error)).toContain('insideDeclaredBoundary');
    });
});
