import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initLayout, reviewPath } from '../../src/core/layout.js';
import { createTask } from '../../src/core/task.js';
import { writeCurrentState } from '../../src/core/state.js';
import { runLedgerCommand } from '../../src/cli/ledger.js';
import { reviewResultFileArg } from '../../src/cli/workflow.js';
import { appendClaim, freezeSubject, writePlan, writePolicy, writeSubject } from '../../src/store/ledger.js';
import { defaultPolicy } from '../../src/kernel/policy.js';
import { runCommand } from '../../src/workflow/orchestrator.js';

let root: string;
const changeId = 'review-cli-io';

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'kata-review-cli-io-'));
    await initLayout(root);
    await createTask({
        root,
        id: changeId,
        title: 'Review CLI I/O',
        acceptance: [{ id: 'AC-1', statement: 'The review I/O is executable.' }],
        ownedPaths: ['src/a.ts'],
    });
    await mkdir(join(root, 'src'), { recursive: true });
    await mkdir(join(root, 'tmp'), { recursive: true });
    await writeFile(join(root, 'src', 'a.ts'), 'export const holds = true;\n');
});

afterEach(async () => {
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
});

async function prepareRequest(): Promise<string> {
    await writePolicy(root, changeId, defaultPolicy());
    const frozen = await freezeSubject({ root, paths: ['src/a.ts'] });
    if (!frozen.ok) throw new Error(frozen.error);
    await writeSubject(root, changeId, frozen.subject);
    await appendClaim(root, changeId, {
        id: 'C-1',
        statement: 'The export is present.',
        riskClass: 'consistency',
        severity: 'major',
        dependsOn: ['path:src/a.ts'],
        evidenceIds: [],
        challengeIds: [],
        status: 'open',
        at: '2026-09-30T00:00:00.000Z',
        reopens: 0,
    });
    await writePlan(root, changeId, {
        tier: 'strict',
        readingSets: [{ claimId: 'C-1', paths: ['src/a.ts'], truncated: false }],
        requiredEvidence: [{ claimId: 'C-1', types: [], minimumStrength: 0 }],
        discovery: { deadlineToolCalls: null },
    });
    return frozen.subject.revision;
}

/** Run a ledger command and return what it printed, so a refusal is asserted rather than swallowed. */
async function ledger(argv: string[]): Promise<{ ok?: boolean; error?: string }> {
    const chunks: string[] = [];
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
        chunks.push(String(chunk));
        return true;
    });
    const previousExitCode = process.exitCode;
    try {
        await runLedgerCommand(argv, { root, changeId });
    } finally {
        stdout.mockRestore();
    }
    process.exitCode = previousExitCode;
    const line = chunks.join('').trim().split('\n').filter((entry) => entry.trim().startsWith('{')).at(-1);
    return line ? (JSON.parse(line) as { ok?: boolean; error?: string }) : {};
}

describe('review CLI I/O', () => {
    it('materializes the deterministic ReviewRequest at --out and never silently writes outside the workspace', async () => {
        const revision = await prepareRequest();

        await ledger(['run', '--out', 'tmp/request.json']);
        const request = JSON.parse(await readFile(join(root, 'tmp', 'request.json'), 'utf8')) as {
            changeId: string;
            subjectRevision: string;
            claims: Array<{ claimId: string; readingSet: string[] }>;
        };
        expect(request.changeId).toBe(changeId);
        expect(request.claims[0]).toMatchObject({ claimId: 'C-1', readingSet: ['src/a.ts'] });
        expect(request.subjectRevision).toBe(revision);

        await ledger(['run', '--out', '../escaped-request.json']);
        await expect(readFile(join(root, '..', 'escaped-request.json'), 'utf8')).rejects.toThrow();
    });

    it('takes a structured subagent result through the CLI and binds its findings to the review record', async () => {
        await writeCurrentState(root, {
            taskId: changeId,
            phase: 'review',
            actor: { id: 'kata-reviewer', role: 'reviewer' },
            updatedAt: '2026-09-30T00:00:00.000Z',
        });
        await writeFile(join(root, 'tmp', 'result.json'), `${JSON.stringify({
            findings: [{
                id: 'R-1',
                taskId: changeId,
                severity: 'blocking',
                message: 'the requested input was not produced',
                reproduction: { findingId: 'R-1', ranChecks: [], missingTest: true },
            }],
        })}\n`);
        await writeFile(join(root, 'tmp', 'wrong-task.json'), `${JSON.stringify({
            findings: [{
                id: 'R-foreign', taskId: 'other-task', severity: 'blocking', message: 'not this task',
            }],
        })}\n`);
        const foreign = await runCommand('review', changeId, root, { reviewResultFile: 'tmp/wrong-task.json' });
        expect(foreign.success).toBe(false);
        expect(foreign.error).toContain('not review-cli-io');



        expect(reviewResultFileArg(['review', '--result-file', 'tmp/result.json'])).toBe('tmp/result.json');
        const result = await runCommand('review', changeId, root, { reviewResultFile: 'tmp/result.json' });
        expect(result.success).toBe(true);

        const record = JSON.parse(await readFile(reviewPath(root, changeId), 'utf8')) as {
            status: string;
            findings: Array<{ id: string; message: string }>;
        };
        expect(record.status).toBe('pending');
        expect(record.findings).toEqual([{ id: 'R-1', taskId: changeId, severity: 'blocking', message: 'the requested input was not produced', reproduction: { findingId: 'R-1', ranChecks: [], missingTest: true } }]);
    });

    it('refuses an empty finding set unless the result explicitly declares full coverage', async () => {
        await writeCurrentState(root, {
            taskId: changeId,
            phase: 'review',
            actor: { id: 'kata-reviewer', role: 'reviewer' },
            updatedAt: '2026-09-30T00:00:00.000Z',
        });
        // A four-byte artefact must not be indistinguishable from "the subagent produced nothing".
        await writeFile(join(root, 'tmp', 'empty.json'), `${JSON.stringify({ findings: [] })}\n`);
        const empty = await runCommand('review', changeId, root, { reviewResultFile: 'tmp/empty.json' });
        expect(empty.success).toBe(false);
        expect(empty.error).toContain('declares coverage');
        await expect(readFile(reviewPath(root, changeId), 'utf8')).rejects.toThrow();

        // An explicit declaration of what was covered is the only way an empty set is a result.
        await writeFile(join(root, 'tmp', 'declared.json'), `${JSON.stringify({ findings: [], declaredCoverage: ['C-1'] })}\n`);
        const declared = await runCommand('review', changeId, root, { reviewResultFile: 'tmp/declared.json' });
        expect(declared.success).toBe(true);

        // Any record for this revision blocks a second recording, empty or not.
        const repeat = await runCommand('review', changeId, root, { reviewResultFile: 'tmp/declared.json' });
        expect(repeat.success).toBe(false);
        expect(repeat.error).toContain('already recorded');
    });

    it('refuses a malformed --result-file shape by name instead of degrading to the plain review path', async () => {
        expect(reviewResultFileArg(['review', '--result-file', '--approve'])).toBeUndefined();
        expect(reviewResultFileArg(['review', '--result-file'])).toBeUndefined();
        expect(reviewResultFileArg(['review', '--result-file'])).toBeUndefined();
    });

    it('refuses a symlinked path that leaves the workspace, for both the request and the result', async () => {
        const outside = await mkdtemp(join(tmpdir(), 'kata-review-outside-'));
        try {
            await prepareRequest();
            await symlink(outside, join(root, 'tmp', 'escape'));
            const escapedRequest = await ledger(['run', '--out', 'tmp/escape/request.json']);
            expect(escapedRequest.error).toContain('inside the workspace');
            expect(await readdir(outside)).toEqual([]);

            await writeCurrentState(root, {
                taskId: changeId,
                phase: 'review',
                actor: { id: 'kata-reviewer', role: 'reviewer' },
                updatedAt: '2026-09-30T00:00:00.000Z',
            });
            await writeFile(join(outside, 'result.json'), `${JSON.stringify({ findings: [{ id: 'R-1', taskId: changeId, severity: 'minor', message: 'x' }] })}\n`);
            const escaped = await runCommand('review', changeId, root, { reviewResultFile: 'tmp/escape/result.json' });
            expect(escaped.success).toBe(false);
            expect(escaped.error).toContain('inside the workspace');
        } finally {
            await rm(outside, { recursive: true, force: true });
        }
    });
});
