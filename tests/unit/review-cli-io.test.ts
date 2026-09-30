import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initLayout, reviewPath } from '../../src/core/layout.js';
import { createTask } from '../../src/core/task.js';
import { writeCurrentState } from '../../src/core/state.js';
import { runLedgerCommand } from '../../src/cli/ledger.js';
import { resultFileRequested, reviewResultFileArg } from '../../src/cli/workflow.js';
import { appendClaim, freezeSubject, writePlan, writePolicy, writeSubject } from '../../src/store/ledger.js';
import { defaultPolicy } from '../../src/kernel/policy.js';
import { runCommand } from '../../src/workflow/orchestrator.js';
import { createTaskRevisionIfChanged } from '../../src/workflow/revision.js';

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
    // **Sealed, because a request now speaks for the sealed revision.** The freeze and the seal hash the same content, so
    // they agree; a fixture that skipped the seal would test a request no flow produces.
    await createTaskRevisionIfChanged({ root, taskId: changeId, ownedPaths: ['src/a.ts'], checkIds: [] });
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


    it('refuses to hand a reviewer a brief for content the sealed revision no longer holds', async () => {
        // G-4, measured on a real flow by an independent review: the request copied `ledger.subject.revision` and the
        // frozen subject was 20 files behind the seal, so the reviewer was briefed on content that was no longer the
        // change. Binding the *result* cannot catch that — the input was already wrong.
        await prepareRequest();
        // The content moves after the freeze without a re-freeze, which is exactly the state that was shipped.
        await writeFile(join(root, 'src', 'a.ts'), 'export const holds = false;\n');

        const refusal = await ledger(['run', '--out', 'tmp/stale.json']);
        expect(refusal.ok, JSON.stringify(refusal)).toBe(false);
        expect(String(refusal.error)).toContain('has moved since it was frozen');
        expect(String(refusal.error)).toContain('src/a.ts');
        await expect(readFile(join(root, 'tmp', 'stale.json'), 'utf8')).rejects.toThrow();
    });

    it('refuses a request when nothing is sealed, naming the seal rather than briefing anyway', async () => {
        await writePolicy(root, changeId, defaultPolicy());
        const frozen = await freezeSubject({ root, paths: ['src/a.ts'] });
        if (!frozen.ok) throw new Error(frozen.error);
        await writeSubject(root, changeId, frozen.subject);
        await appendClaim(root, changeId, {
            id: 'C-1', statement: 'present.', riskClass: 'consistency', severity: 'major',
            dependsOn: ['path:src/a.ts'], evidenceIds: [], challengeIds: [], status: 'open',
            at: '2026-09-30T00:00:00.000Z', reopens: 0,
        });
        await writePlan(root, changeId, {
            tier: 'strict',
            readingSets: [{ claimId: 'C-1', paths: ['src/a.ts'], truncated: false }],
            requiredEvidence: [{ claimId: 'C-1', types: [], minimumStrength: 0 }],
            discovery: { deadlineToolCalls: null },
        });

        const refusal = await ledger(['run', '--out', 'tmp/unsealed.json']);
        expect(refusal.ok).toBe(false);
        expect(String(refusal.error)).toContain('build --seal');
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
        await prepareRequest();
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

        // And a *recorded result* blocks a second recording, empty or not — the guard G-1 first over-tightened to also
        // catch the enter-review placeholder, which made this command unreachable. `declared` wrote a result, so it holds.
        const repeat = await runCommand('review', changeId, root, { reviewResultFile: 'tmp/declared.json' });
        expect(repeat.success).toBe(false);
        expect(repeat.error).toContain('already recorded');
    });


    it('keeps --result-file reachable after the enter-review step, instead of deadlocking on its own placeholder', async () => {
        // **The case the first version of this file missed.** G-1: entering review writes a record bound to the revision
        // with an empty findings list, and the "already recorded" guard then refused every later `--result-file` — so the
        // command the design and the rendered skill both promise was unreachable in a real flow. The old test wrote
        // `writeCurrentState(phase: 'review')` by hand, which is exactly the step that creates the placeholder, so it
        // never met the state it had produced.
        await prepareRequest();
        // **Sealed, because that is what makes the placeholder bind.** The mutation check found the first version of this
        // case green with the placeholder distinction removed: nothing was sealed, so `revisionBindingFields` produced an
        // empty binding, `bindsToRevision` answered false, and the guard never ran. The real flow always has a sealed
        // revision, so the case has to have one or it is not testing the guard at all.
        await createTaskRevisionIfChanged({ root, taskId: changeId, ownedPaths: ['src/a.ts'], checkIds: [] });
        await writeCurrentState(root, {
            taskId: changeId,
            phase: 'hardVerify',
            actor: { id: 'kata-agent', role: 'implementer' },
            updatedAt: '2026-09-30T00:00:00.000Z',
        });

        // 1. Enter review the way an operator does — no `--result-file`, so the placeholder is written.
        // The review boundary demands an explicit confirmation; that is the gate, not the subject of this case.
        const entered = await runCommand('review', changeId, root, { confirmHostModel: true });
        expect(entered.success, JSON.stringify(entered)).toBe(true);
        // What the enter-review step actually wrote, so a fixture change cannot silently stop binding the placeholder.
        const writtenPlaceholder = await readFile(reviewPath(root, changeId), 'utf8');
        const placeholder = JSON.parse(await readFile(reviewPath(root, changeId), 'utf8')) as { findings?: unknown[]; revisionId?: string; manifestHash?: string };
        expect(placeholder.findings ?? []).toEqual([]);
        // **The fixture's own precondition, asserted against the guard's own binding.** A placeholder that does not bind
        // makes the guard unreachable and this whole case decorative — which is what the mutation check caught. The
        // binding `currentRevisionIdentity` derives is compared against what the enter-review step wrote.
        const { currentRevisionIdentity, bindsToRevision } = await import('../../src/workflow/verdict-binding.js');
        const binding = await currentRevisionIdentity(root, changeId);
        const written = JSON.parse(writtenPlaceholder) as Record<string, unknown>;
        expect(bindsToRevision({
            ...(typeof written.revisionId === 'string' ? { revisionId: written.revisionId } : {}),
            ...(typeof written.manifestHash === 'string' ? { manifestHash: written.manifestHash } : {}),
            ...(typeof written.candidateFreezeSha256 === 'string' ? { candidateFreezeSha256: written.candidateFreezeSha256 } : {}),
        }, binding)).toBe(true);

        // 2. Record the round's result. This is what the placeholder must not block.
        await writeFile(join(root, 'tmp', 'round.json'), `${JSON.stringify({
            findings: [{ id: 'R-1', taskId: changeId, severity: 'major', message: 'recorded after entering review' }],
        })}\n`);
        const recorded = await runCommand('review', changeId, root, { reviewResultFile: 'tmp/round.json' });
        expect(recorded.success, JSON.stringify(recorded)).toBe(true);
        const record = JSON.parse(await readFile(reviewPath(root, changeId), 'utf8')) as { findings: Array<{ id: string }> };
        expect(record.findings.map((finding) => finding.id)).toEqual(['R-1']);

        // 3. And a *recorded* result is what blocks a second one — the guard still exists, it just no longer mistakes
        //    the placeholder for a result.
        const repeat = await runCommand('review', changeId, root, { reviewResultFile: 'tmp/round.json' });
        expect(repeat.success).toBe(false);
        expect(repeat.error).toContain('already recorded');
    });

    it('refuses a dangling symlink at the destination, which no existsSync check can see', async () => {
        // G-2: `existsSync` follows symlinks, so a link whose target does not exist yet read as "the path is absent" and
        // the fence rebuilt it under the realpath of an existing ancestor — inside the workspace — while `writeFile`
        // followed the link and created the file outside it. A dangling link is the case a follow-the-link check cannot
        // detect, so the fence has to refuse the link itself.
        const outside = await mkdtemp(join(tmpdir(), 'kata-review-dangling-'));
        try {
            await prepareRequest();
            const escapedTarget = join(outside, 'created-outside.json');
            await symlink(escapedTarget, join(root, 'tmp', 'dangling.json'));

            const refusal = await ledger(['run', '--out', 'tmp/dangling.json']);
            expect(refusal.error).toContain('inside the workspace');
            // The decisive assertion: nothing was created on the other side of the link.
            expect(await readdir(outside)).toEqual([]);

            await writeCurrentState(root, {
                taskId: changeId,
                phase: 'review',
                actor: { id: 'kata-reviewer', role: 'reviewer' },
                updatedAt: '2026-09-30T00:00:00.000Z',
            });
            const result = await runCommand('review', changeId, root, { reviewResultFile: 'tmp/dangling.json' });
            expect(result.success).toBe(false);
            expect(result.error).toContain('inside the workspace');
        } finally {
            await rm(outside, { recursive: true, force: true });
        }
    });

    it("binds declared coverage to the ledger's real claim ids and records what was declared", async () => {
        // G-3: the first version accepted any non-empty string array and never wrote it, so an empty result whose
        // declaration named a claim that does not exist was still indistinguishable from "nothing was read".
        await prepareRequest();
        await writeCurrentState(root, {
            taskId: changeId,
            phase: 'review',
            actor: { id: 'kata-reviewer', role: 'reviewer' },
            updatedAt: '2026-09-30T00:00:00.000Z',
        });

        await writeFile(join(root, 'tmp', 'invented.json'), `${JSON.stringify({ findings: [], declaredCoverage: ['not-a-claim'] })}\n`);
        const invented = await runCommand('review', changeId, root, { reviewResultFile: 'tmp/invented.json' });
        expect(invented.success).toBe(false);
        expect(invented.error).toContain('not-a-claim');

        await writeFile(join(root, 'tmp', 'partial.json'), `${JSON.stringify({ findings: [], declaredCoverage: ['C-1'] })}\n`);
        const partial = await runCommand('review', changeId, root, { reviewResultFile: 'tmp/partial.json' });
        expect(partial.success).toBe(true);
        const record = JSON.parse(await readFile(reviewPath(root, changeId), 'utf8')) as { declaredCoverage?: string[] };
        // Persisted, not merely validated: a reader has to be able to see what the round claimed to have read.
        expect(record.declaredCoverage).toEqual(['C-1']);
    });

    it('refuses a malformed --result-file shape by name instead of degrading to the plain review path', async () => {
        expect(reviewResultFileArg(['review', '--result-file', '--approve'])).toBeUndefined();
        expect(reviewResultFileArg(['review', '--result-file'])).toBeUndefined();
        // Both spellings are the same flag. G-5: `--result-file=x` used to be read as absent, so the command fell into
        // the plain route and returned success — a malformed value degrading silently, which is what this refusal prevents.
        expect(reviewResultFileArg(['review', '--result-file=tmp/result.json'])).toBe('tmp/result.json');
        expect(reviewResultFileArg(['review', '--result-file='])).toBeUndefined();
        expect(resultFileRequested(['review', '--result-file=tmp/result.json'])).toBe(true);
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
