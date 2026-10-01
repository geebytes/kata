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


/** Run a ledger command against the same workspace reached through a path that carries a symlinked component. */
async function ledgerViaWorkspaceLink(argv: string[], linkedRoot: string): Promise<{ ok?: boolean; error?: string }> {
    const chunks: string[] = [];
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
        chunks.push(String(chunk));
        return true;
    });
    const previousExitCode = process.exitCode;
    try {
        await runLedgerCommand(argv, { root: linkedRoot, changeId });
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

        // The `=` spelling is the same flag: G-5 fixed `--result-file` only, so `--out=path` was seen as given by one
        // check and read as absent by the shared reader, refusing the path it had just been handed.
        await ledger(['run', '--out=tmp/equals-request.json']);
        const viaEquals = JSON.parse(await readFile(join(root, 'tmp', 'equals-request.json'), 'utf8')) as { changeId: string };
        expect(viaEquals.changeId).toBe(changeId);

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



    it('names the declaration move as its own fact, not as a content change', async () => {
        // F-2: the refusal has two branches and only `superseded` was asserted, so the `declaration-moved` half had no
        // falsifier — corrupting `added`/`removed` or collapsing the message back to "content has changed" stayed green.
        // Reachability proved with the real CLI by the reviewer: seal, then add an existing empty directory to the
        // declaration, then re-freeze.
        await prepareRequest();
        await mkdir(join(root, 'src', 'empty'), { recursive: true });
        const taskFile = join(root, '.kata', 'tasks', changeId, 'task.json');
        const task = JSON.parse(await readFile(taskFile, 'utf8')) as { ownedPaths: string[] };
        await writeFile(taskFile, `${JSON.stringify({ ...task, ownedPaths: [...task.ownedPaths, 'src/empty'] }, null, 2)}\n`);
        const refrozen = await freezeSubject({ root, paths: [...task.ownedPaths, 'src/empty'] });
        if (!refrozen.ok) throw new Error(refrozen.error);
        await writeSubject(root, changeId, refrozen.subject);

        const refusal = await ledger(['run', '--out', 'tmp/declaration-moved.json']);
        expect(refusal.ok, JSON.stringify(refusal)).toBe(false);
        const message = String(refusal.error);
        expect(message).toContain('declaration-moved');
        // The two facts are told apart in the message: this one names the added path, not "the content has changed".
        expect(message).toContain('src/empty');
        expect(message).toContain("the task's declaration has moved");
        expect(message).not.toContain('content under its declared paths has changed');
        expect(message).not.toContain('[object Object]');
    });

    it('refuses a request once the content under the seal has moved, even if the subject was re-frozen', async () => {
        // F-2: "the subject matches the content" and "a seal exists" were checked as two independent facts, so
        // freeze(A) → seal(revA) → edit → freeze(revB) → run passed and named revB while a reviewer's result would bind
        // to revA. Request and result must speak for one revision.
        await prepareRequest();
        await writeFile(join(root, 'src', 'a.ts'), 'export const holds = false;\n');
        // Re-freeze: the subject now matches the current content, which is what the first check looks at.
        const refrozen = await freezeSubject({ root, paths: ['src/a.ts'] });
        if (!refrozen.ok) throw new Error(refrozen.error);
        await writeSubject(root, changeId, refrozen.subject);

        const refusal = await ledger(['run', '--out', 'tmp/after-edit.json']);
        expect(refusal.ok, JSON.stringify(refusal)).toBe(false);
        // R5-2: the refusal has to name the state it measured. It is an object, so interpolating it printed
        // `[object Object]` — the message hid the very fact it had just read, under a case that only matched a suffix.
        expect(String(refusal.error)).toContain('superseded');
        expect(String(refusal.error)).not.toContain('[object Object]');
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


    it('never rewrites a recorded empty round back into a placeholder when review is re-entered', async () => {
        // F-3: two derivations of "is this a placeholder" disagreed. The result face was tightened, the write face kept
        // "findings is empty", so re-entering review over a legitimately empty *result* silently replaced it with a
        // placeholder — and the `--result-file` guard then allowed a second round over a record that was already recorded.
        await prepareRequest();
        await createTaskRevisionIfChanged({ root, taskId: changeId, ownedPaths: ['src/a.ts'], checkIds: [] });
        await writeCurrentState(root, {
            taskId: changeId, phase: 'hardVerify', actor: { id: 'kata-agent', role: 'implementer' },
            updatedAt: '2026-09-30T00:00:00.000Z',
        });
        expect((await runCommand('review', changeId, root, { confirmHostModel: true })).success).toBe(true);

        await writeFile(join(root, 'tmp', 'declared.json'), `${JSON.stringify({ findings: [], declaredCoverage: ['C-1'] })}\n`);
        expect((await runCommand('review', changeId, root, { reviewResultFile: 'tmp/declared.json' })).success).toBe(true);

        // Re-enter review. The recorded round must survive: a placeholder rewrite would erase the declaration.
        expect((await runCommand('review', changeId, root, { confirmHostModel: true })).success).toBe(true);
        const after = JSON.parse(await readFile(reviewPath(root, changeId), 'utf8')) as { declaredCoverage?: string[]; reviewRoute?: string };
        expect(after.declaredCoverage).toEqual(['C-1']);
        expect(after.reviewRoute).toBe('adversarial');

        // And because the round is still recorded, a third round is refused rather than silently replacing it.
        const third = await runCommand('review', changeId, root, { reviewResultFile: 'tmp/declared.json' });
        expect(third.success).toBe(false);
        expect(third.error).toContain('already recorded');
    });


    it('validates and keeps a coverage declaration even when the round did report findings', async () => {
        // F-6: the validation and the write both sat inside the empty-findings branch, so a non-empty round could declare
        // an invented claim id and the declaration was dropped — a validator on one path and no reader on the other.
        await prepareRequest();
        await writeCurrentState(root, {
            taskId: changeId, phase: 'review', actor: { id: 'kata-reviewer', role: 'reviewer' },
            updatedAt: '2026-09-30T00:00:00.000Z',
        });
        await writeFile(join(root, 'tmp', 'invented-plus-findings.json'), `${JSON.stringify({
            findings: [{ id: 'R-1', taskId: changeId, severity: 'minor', message: 'something' }],
            declaredCoverage: ['C-9'],
        })}\n`);
        const invented = await runCommand('review', changeId, root, { reviewResultFile: 'tmp/invented-plus-findings.json' });
        expect(invented.success).toBe(false);
        expect(String(invented.error)).toContain('C-9');

        await writeFile(join(root, 'tmp', 'real-plus-findings.json'), `${JSON.stringify({
            findings: [{ id: 'R-1', taskId: changeId, severity: 'minor', message: 'something' }],
            declaredCoverage: ['C-1'],
        })}\n`);
        const recorded = await runCommand('review', changeId, root, { reviewResultFile: 'tmp/real-plus-findings.json' });
        expect(recorded.success, JSON.stringify(recorded)).toBe(true);
        const record = JSON.parse(await readFile(reviewPath(root, changeId), 'utf8')) as { declaredCoverage?: string[]; findings: unknown[] };
        expect(record.findings).toHaveLength(1);
        expect(record.declaredCoverage).toEqual(['C-1']);
    });


    it('resolves the = spelling for every flag reader, not just the one that was fixed first', async () => {
        // R5-3: §12.4 claimed the rule was resolved "once, for every flag", but it only reached `argValue`, so
        // `--root=/ws` fell back to workspace discovery and quietly used the wrong root — the fail-open direction.
        const { parseRootArg, parseChangeArg, argValue } = await import('../../src/cli/invocation.js');
        const { reviewEvidenceArg, flagPresent } = await import('../../src/cli/workflow.js');

        expect(parseRootArg(['--root=/ws'])).toBe('/ws');
        expect(parseRootArg(['--root', '/ws'])).toBe('/ws');
        expect(parseChangeArg(['--change=c1'])).toBe('c1');
        expect(parseChangeArg(['--change', 'c1'])).toBe('c1');
        expect(parseChangeArg(['--root=/ws', '--change=c1'])).toBe('c1');
        expect(argValue(['--out=tmp/x'], '--out')).toBe('tmp/x');
        expect(reviewEvidenceArg(['--review-evidence=ledger passed'])).toBe('ledger passed');
        expect(flagPresent(['--reviewed-path=src/a.ts'], '--reviewed-path')).toBe(true);
    });


    it('refuses to enter review when the existing record is corrupt, rather than overwriting the round it describes', async () => {
        // R5-6: the catch around this step replaced the record with a placeholder for *any* failure, so a `review.json`
        // that does not parse was silently overwritten and the round it described was lost — under a message saying the
        // review had been entered. "Nothing here yet" is the ordinary case and must still work; "here and unreadable" must not.
        await prepareRequest();
        await createTaskRevisionIfChanged({ root, taskId: changeId, ownedPaths: ['src/a.ts'], checkIds: [] });
        await writeCurrentState(root, {
            taskId: changeId, phase: 'hardVerify', actor: { id: 'kata-agent', role: 'implementer' },
            updatedAt: '2026-09-30T00:00:00.000Z',
        });

        // First entry with no record at all: ordinary, and it succeeds.
        expect((await runCommand('review', changeId, root, { confirmHostModel: true })).success).toBe(true);

        // Now corrupt it, and try again. The corrupt bytes must survive and be reported, not be replaced.
        await writeFile(reviewPath(root, changeId), '{ this is not json');
        const refusal = await runCommand('review', changeId, root, { confirmHostModel: true });
        expect(refusal.success).toBe(false);
        // **The assertion has to distinguish the measured error from a plausible invented one.** R7-F5: asserting only
        // `toContain('Review could not be entered:')` plus `/JSON|Unexpected|position/` passed a hand-written sentence
        // (`the record is not valid JSON (unexpected position)`) substituted for the real error — the case claimed to
        // check that the refusal reports what it saw, and could not tell a real error from a convincing fake one. The
        // measured message is the parser's own, so the assertion is against the parser's own words for *this* input.
        const refusalText = String(refusal.error);
        expect(refusalText).toContain('Review could not be entered:');
        // The real message comes from `JSON.parse` and names the position it failed at; a substitute sentence cannot
        // produce the exact offset for this input.
        const parseError = ((): string => {
            try {
                JSON.parse('{ this is not json');
                return 'parsed';
            } catch (error) {
                return (error as Error).message;
            }
        })();
        expect(parseError).not.toBe('parsed');
        expect(refusalText).toContain(parseError);
        expect(refusalText).toContain(reviewPath(root, changeId));
        expect(await readFile(reviewPath(root, changeId), 'utf8')).toBe('{ this is not json');
    });


    it('does not let a value flag take the change-id slot, and both spellings resolve for every value flag', async () => {
        // F-1: `VALUE_FLAGS` was missing `--review-evidence`, so `review --review-evidence hello --change t1` read `hello`
        // as the *change id* and operated on a task named hello — the flag's value took the slot the change id wanted.
        const { parseRootArg, parseChangeArg, argValue, VALUE_FLAGS } = await import('../../src/cli/invocation.js');
        const { resultFileRequested, reviewEvidenceArg } = await import('../../src/cli/workflow.js');

        expect(parseChangeArg(['review', '--review-evidence', 'hello', '--change', 't1'])).toBe('t1');
        expect(parseChangeArg(['review', '--result-file', 'r.json', '--change', 't1'])).toBe('t1');
        expect(parseChangeArg(['review', '--out', 'req.json', '--change', 't1'])).toBe('t1');

        // F-4: the spaced form must not swallow the next flag as its value.
        expect(parseRootArg(['--root', '--change=c1'])).toBeUndefined();
        expect(parseChangeArg(['--change', '--root=/ws'])).toBeUndefined();

        // The vocabulary is complete for the flags the code actually reads: every value flag is in the list.
        for (const flag of ['--review-evidence', '--out', '--result-file', '--owned-path', '--waivers-file', '--requirements-file']) {
            expect(VALUE_FLAGS).toContain(flag);
            expect(argValue([`${flag}=v`], flag)).toBe('v');
            expect(argValue([flag, 'v'], flag)).toBe('v');
        }
        expect(reviewEvidenceArg(['--review-evidence=ledger passed'])).toBe('ledger passed');
        expect(resultFileRequested(['--result-file=r.json'])).toBe(true);
    });


    it('archives a recorded round that reported nothing before replacing it, and replaces a placeholder silently', async () => {
        // F-3: `review-history.jsonl` had no reader and no case in the whole suite, so this branch — the one R5-7 changed —
        // could be reverted to the old `findings.length` test without anything reddening. The two directions are asserted
        // here: an empty-but-declared round is a recorded round and is archived; a placeholder is not and leaves no trace.
        const historyPath = join(root, '.kata', 'tasks', changeId, 'review-history.jsonl');
        const readHistory = async (): Promise<Array<{ findings?: unknown[]; revisionId?: string }>> =>
            (await readFile(historyPath, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean)
                .map((line) => JSON.parse(line) as { findings?: unknown[]; revisionId?: string });

        await prepareRequest();
        await createTaskRevisionIfChanged({ root, taskId: changeId, ownedPaths: ['src/a.ts'], checkIds: [] });
        await writeCurrentState(root, {
            taskId: changeId, phase: 'hardVerify', actor: { id: 'kata-agent', role: 'implementer' },
            updatedAt: '2026-09-30T00:00:00.000Z',
        });

        // Enter review (a placeholder), record an empty-but-declared result, then move the content so the next entry sees
        // a revision the record is no longer bound to.
        expect((await runCommand('review', changeId, root, { confirmHostModel: true })).success).toBe(true);
        await writeFile(join(root, 'tmp', 'declared.json'), `${JSON.stringify({ findings: [], declaredCoverage: ['C-1'] })}\n`);
        expect((await runCommand('review', changeId, root, { reviewResultFile: 'tmp/declared.json' })).success).toBe(true);

        // **The guard needs a revision id, and it comes from recorded evidence — valid evidence.** Measured twice while
        // writing this: a hand-written envelope that fails the evidence schema makes `readRecordedEvidence` throw, the
        // caller falls back to collecting nothing, `revisionIdForEvidence` answers `undefined`, and the archival branch
        // short-circuits. A fixture that is not a record the engine can read cannot drive the branch that reads records.
        const sealed = JSON.parse(await readFile(join(root, '.kata', 'tasks', changeId, 'current-revision.json'), 'utf8')) as { id: string };
        await mkdir(join(root, '.kata', 'evidence'), { recursive: true });
        await writeFile(join(root, '.kata', 'evidence', `${changeId}-test.json`), `${JSON.stringify({
            id: 'evidence-1', taskId: changeId, checkId: 'check-1', checkSource: 'configured', name: 'test',
            kind: 'test', command: 'true', environment: 'test', exitCode: 0, passed: true,
            checkInput: 'a'.repeat(64), coveredAcceptanceIds: [], startedAt: '2026-09-30T00:00:00.000Z',
            finishedAt: '2026-09-30T00:00:01.000Z', diffHash: 'd'.repeat(64), log: '', logBytes: 0,
            revisionId: sealed.id,
        })}\n`);

        // The recorded round survives re-entering review with the same revision: no archival, because nothing replaced it.
        expect((await runCommand('review', changeId, root, { confirmHostModel: true })).success).toBe(true);
        expect(await readHistory()).toEqual([]);

        // Now move the content and re-seal, so the record's revision is no longer the current one.
        await writeFile(join(root, 'src', 'a.ts'), 'export const holds = false;\n');
        await createTaskRevisionIfChanged({ root, taskId: changeId, ownedPaths: ['src/a.ts'], checkIds: [] });
        expect((await runCommand('review', changeId, root, { confirmHostModel: true })).success).toBe(true);

        const archived = await readHistory();
        expect(archived).toHaveLength(1);
        expect(archived[0]?.findings).toEqual([]);
        expect(typeof archived[0]?.revisionId).toBe('string');
    });



    it('accepts either spelling for the flags that declare a change surface, not only for --result-file', async () => {
        // R9-F2: `--owned-path=src/a.ts` produced *no owned paths at all* (the declaration the seal binds), and
        // `--waivers-file=` / `--requirements-file=` were silently ignored — a supplied waiver set that did not apply,
        // with the command reporting success. Silent fail-open on the declaration surface is the one place it must not
        // happen: the task would be built with a surface nobody declared.
        const { ownedPaths, readWaiversFile, readRequirementsFile, reviewEvidenceRequested, reviewEvidenceArg } = await import('../../src/cli/workflow.js');
        // R12-F8: the "present but malformed is refused by name" rule only reached `--result-file`; its sibling
        // `--review-evidence` had no companion predicate at all.
        expect(reviewEvidenceRequested(['--review-evidence='])).toBe(true);
        expect(reviewEvidenceRequested(['--review-evidence', 'text'])).toBe(true);
        expect(reviewEvidenceRequested([])).toBe(false);
        expect(reviewEvidenceArg(['--review-evidence'])).toBeUndefined();
        expect(ownedPaths(['--owned-path', 'src/a.ts', '--owned-path=src/b.ts'])).toEqual(['src/a.ts', 'src/b.ts']);
        expect(ownedPaths(['--owned-path=src/a.ts'])).toEqual(['src/a.ts']);
        // Absent stays absent; present-but-empty is malformed rather than ignored — for the `=` form too, so a task is
        // never built with an empty declaration surface (R10-F1).
        // T6-3: a bare value flag with no value is present-but-empty as well, not "no declaration" — the earlier check
        // only recognised the inline spelling, so `--owned-path` (with nothing after it) silently declared nothing.
        expect(() => ownedPaths(['--owned-path'])).toThrow(/requires a path/u);
        expect(() => ownedPaths(['--owned-path='])).toThrow(/requires a path/u);
        // A flag given a value is of course fine, in either spelling.
        expect(ownedPaths(['--owned-path=src/a.ts'])).toEqual(['src/a.ts']);

        await expect(readWaiversFile(['--waivers-file'])).rejects.toThrow(/requires a path/u);
        await expect(readWaiversFile(['--waivers-file='])).rejects.toThrow(/requires a path/u);
        await expect(readRequirementsFile(['--requirements-file'])).rejects.toThrow(/requires a path/u);
        await expect(readRequirementsFile(['--requirements-file='])).rejects.toThrow(/requires a path/u);

        // R12-F5/F-6: present-but-empty is refused by these readers too, instead of reading as "absent".
        const { readBootstrapFile } = await import('../../src/cli/workflow.js');
        await expect(readBootstrapFile(['--bootstrap-file='])).rejects.toThrow(/requires a path/u);
        const { runEvalCommand } = await import('../../src/cli/ops.js');
        await expect(runEvalCommand(['/nonexistent-manifest.json', '--persist='])).rejects.toThrow();
        await expect(runEvalCommand(['/nonexistent-manifest.json', '--root='])).rejects.toThrow();

        // And the `=` spelling resolves the same file the spaced form does.
        await writeFile(join(root, 'tmp', 'waivers.json'), JSON.stringify({ waivers: [] }));
        await writeFile(join(root, 'tmp', 'requirements.json'), JSON.stringify({ requirements: [{ id: 'AC-1', statement: 'x' }] }));
        expect(await readWaiversFile([`--waivers-file=${join(root, 'tmp', 'waivers.json')}`])).toEqual([]);
        expect(await readRequirementsFile([`--requirements-file=${join(root, 'tmp', 'requirements.json')}`])).toHaveLength(1);
    });


    it('keeps the platform the operator named when it is spelled inline', async () => {
        // R10-F2, introduced by the previous round's own repair: `parseInstallerArgs` learned the `=` form and
        // `hasExplicitPlatform` did not, so `doctor --platform=codex` went from a loud `Unknown installer option` to a
        // *silent* aggregate discovery that ignored the named platform.
        const { runDoctorCommand } = await import('../../src/cli/installer.js');
        const named = await runDoctorCommand([`--platform=pi`, '--scope=project', '--root', root]);
        expect(named.mode).not.toBe('aggregate');
    });

    it('resolves the workflow profile choices in either spelling', async () => {
        // `resolveWorkflowProfile` is async: an un-awaited call compares two Promises, which is how the first version of
        // this case passed its own mutation checks by accident.
        // R10-F3: `parseEnumArg` compared whole tokens, so a caller who gave every choice inline was told they had given
        // none. The rule this change states is one rule for every flag reader, and this is the reader that was missed.
        const { resolveWorkflowProfile } = await import('../../src/cli/workflow.js');
        const spaced = await resolveWorkflowProfile('open', ['--isolation', 'current_worktree', '--development', 'tdd', '--review', 'strict']);
        const inline = await resolveWorkflowProfile('open', ['--isolation=current_worktree', '--development=tdd', '--review=strict']);
        expect(inline).toEqual(spaced);
        expect(inline.isolationMode).toBe('current_worktree');
        expect(inline.developmentMode).toBe('tdd');
        expect(inline.reviewMode).toBe('strict');
    });

    it("accepts the inline spelling in the installer flag loop", async () => {
        // R9-F1: the same rule, in the hand-written loop the docblock beside `splitFlag` named as covered.
        const { parseInstallerArgs } = await import('../../src/cli/installer.js');
        const spaced = parseInstallerArgs(['--platform', 'pi', '--scope', 'project']);
        const inline = parseInstallerArgs(['--platform=pi', '--scope=project']);
        expect(inline.platform).toBe(spaced.platform);
        expect(inline.scope).toBe(spaced.scope);
        expect(() => parseInstallerArgs(['--platform='])).toThrow();
    });


    it('never takes the next flag as a value, in any parser', async () => {
        // R12-F1, measured: `init --platform pi --scope project --root --dry-run` set `options.root = '--dry-run'`, left
        // `dryRun` false, and the end-to-end run created a directory of that name and wrote 14 files into it — "ask for a
        // dry run" became a real write. The guard against this lived in `argValue` and not in the loops that called it.
        const { parseInstallerArgs } = await import('../../src/cli/installer.js');
        // `--root` with no value is refused and says which problem it is (a value flag missing its value), rather than
        // either slurping `--dry-run` into the path or reporting the wrong fault ("unknown option: --root").
        expect(() => parseInstallerArgs(['--platform', 'pi', '--scope', 'project', '--root', '--dry-run']))
            .toThrow(/--root requires a value/u);
        // And the switch itself is a switch in either spelling.
        expect(parseInstallerArgs(['--platform=pi', '--scope=project', '--dry-run']).options.dryRun).toBe(true);
        expect(parseInstallerArgs(['--platform=pi', '--scope=project', '--dry-run=1']).options.dryRun).toBe(true);
        // T6-4: the same parser answered "empty value" two ways — `--platform=` threw, `--root=` was accepted as `''`.
        expect(() => parseInstallerArgs(['--platform=pi', '--scope=project', '--root='])).toThrow(/requires a path/u);
        expect(() => parseInstallerArgs(['--platform=pi', '--scope=project', '--home='])).toThrow(/requires a path/u);

        // `--mode` belongs to the orient parser, not the tasks one — assert each parser against its own flags, and make
        // the point that matters: two adjacent inline flags must not swallow one another.
        const tasks = await import('../../src/cli/tasks.js');
        expect(tasks.parseOrientArgs(['--mode=strict', '--role=reviewer'])).toMatchObject({ routingMode: 'strict', role: 'reviewer' });
        expect(tasks.parseTasksArgs(['--from=a', '--to=b', '--type=x'])).toMatchObject({ from: 'a', to: 'b', type: 'x' });

        const { parseHandoffArgs } = await import('../../src/cli/handoff.js');
        expect(parseHandoffArgs(['--task=t1', '--role=reviewer'])).toMatchObject({ task: 't1', role: 'reviewer' });

        const { parseWikiArgs } = await import('../../src/cli/wiki.js');
        expect(parseWikiArgs(['--root=/ws', '--wiki=proj'])).toMatchObject({ root: '/ws', wikiPath: 'proj' });

        // And a flag is not the next flag's value here either: it is refused rather than read as one.
        expect(() => parseHandoffArgs(['--task', '--role'])).toThrow(/Unknown handoff option/u);

        // T6-1: an inline value consumes nothing, in **every** branch of this parser, and each branch is asserted rather
        // than one of them — the three that were wrong (`--role`/`--from`/`--root`) each swallowed the flag that followed,
        // so `--role=reviewer --task=t1` lost the task and the caller delegated to a different one.
        const { parseDelegationArgs } = await import('../../src/cli/handoff.js');
        expect(parseDelegationArgs(['--role=reviewer', '--task=t1'])).toMatchObject({ role: 'reviewer', change: 't1' });
        expect(parseDelegationArgs(['--from=a', '--task=t1'])).toMatchObject({ from: 'a', change: 't1' });
        expect(parseDelegationArgs(['--root=/ws', '--task=t1'])).toMatchObject({ root: '/ws', change: 't1' });
        expect(parseDelegationArgs(['--to=opencode', '--task=t1'])).toMatchObject({ to: 'opencode', change: 't1' });
        expect(parseDelegationArgs(['--platform=pi', '--task=t1'])).toMatchObject({ to: 'pi', change: 't1' });
        // The  branch too: mutating it must redden this case, so it gets its own assertion with a flag after it.
        expect(parseDelegationArgs(['--change=t1', '--role=reviewer'])).toMatchObject({ change: 't1', role: 'reviewer' });
    });

    it('resolves the = spelling for hand-written flag parsers too, not only the shared readers', async () => {
        // R8-F4: `--flag=value` was fixed in the shared readers and left the hand-written `arg === '--x'` loops alone, so
        // `relations add --from=task:a --to=task:b` was refused with `Unknown relations option: --from=task:a`.
        const { splitFlag } = await import('../../src/cli/invocation.js');
        expect(splitFlag('--from=task:a')).toEqual({ flag: '--from', inline: 'task:a' });
        expect(splitFlag('--from')).toEqual({ flag: '--from' });
        expect(splitFlag('task:a')).toEqual({ flag: 'task:a' });
        expect(splitFlag('--from=')).toEqual({ flag: '--from', inline: '' });

        // Driven through the real command: the inline spelling must not be refused as an unknown option. `add` with an
        // inline `--from=`/`--to=`/`--type=` reaches the endpoint parser instead of the "Unknown relations option" throw,
        // which is the difference this asserts.
        const { runRelationsCommand } = await import('../../src/cli/relations.js');
        const failure = await runRelationsCommand(['add', '--from=task:missing-a', '--to=task:missing-b', '--type=depends_on'])
            .then(() => null, (error: unknown) => (error as Error).message);
        expect(failure).not.toBeNull();
        expect(failure).not.toContain('Unknown relations option');
    });


    it('judges a dangling link by where it points, and still refuses one that points out', async () => {
        // R5-5: every dangling link used to be refused on the grounds of spelling, including a relative one whose target
        // is inside the workspace — `ln -s not-yet.json a.json` — which `writeFile` creates in bounds. The target is
        // readable from the link, so it can be judged; only an unlocatable target is refused. Read-side probe only: this
        // asserts the fence's answer, not a write, because the fence is what both the request and the result paths share.
        const { containedPath } = await import('../../src/store/verify-context.js');
        await mkdir(join(root, 'src'), { recursive: true });
        await symlink('not-yet.json', join(root, 'src', 'inside-dangling.json'));
        await symlink('/tmp/kata-outside-target.json', join(root, 'src', 'outside-dangling.json'));
        await symlink('../../outside/elsewhere.json', join(root, 'src', 'upward-dangling.json'));
        expect(containedPath(root, 'src/inside-dangling.json')).not.toBeNull();
        expect(containedPath(root, 'src/outside-dangling.json')).toBeNull();
        expect(containedPath(root, 'src/upward-dangling.json')).toBeNull();
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


    it('accepts a link whose target is inside the workspace, and refuses only the ones that leave it', async () => {
        // F-7: refusing every symlink component also refused links that stay inside — reads failed silently and the
        // mutation-restore write threw. The fence answers "where does this land", so an inside link is ordinary.
        await prepareRequest();
        await mkdir(join(root, 'src', 'nested'), { recursive: true });
        await symlink(join(root, 'src'), join(root, 'tmp', 'inside-link'));

        const accepted = await ledger(['run', '--out', 'tmp/inside-link/request.json']);
        expect(accepted.ok, JSON.stringify(accepted)).toBe(true);
        const written = JSON.parse(await readFile(join(root, 'src', 'nested', '..', 'request.json'), 'utf8')) as { changeId: string };
        // Written through the link, and it is in the workspace — which is the fact that decides.
        expect(written.changeId).toBe(changeId);
    });

    it('accepts an existing path when the workspace root itself is reached through a link', async () => {
        // F-1: comparing an unresolved probe against a resolved root refused every *existing* path when the root's own
        // path carried a symlinked component (a symlinked $HOME, macOS /var). The verdict must not depend on whether the
        // file is already there.
        await prepareRequest();
        const viaLink = join(root, 'tmp', 'root-link');
        await symlink(root, viaLink);
        const throughRootLink = await ledgerViaWorkspaceLink(['run', '--out', 'tmp/existing.json'], viaLink);
        expect(throughRootLink.ok, JSON.stringify(throughRootLink)).toBe(true);
        // And the same invocation a second time, over the file it just wrote, still succeeds.
        const again = await ledgerViaWorkspaceLink(['run', '--out', 'tmp/existing.json'], viaLink);
        expect(again.ok, JSON.stringify(again)).toBe(true);
    });


    it('accepts a link whose target is the workspace root, not only links that point below it', async () => {
        // R5-1: the resolved-destination fence (this round's own semantics) refused a link whose target *is* the workspace
        // root, because `relative(realRoot, realRoot)` is the empty string and the emptiness test read that as "outside".
        // §12.1 says only a position that cannot be resolved is refused on spelling, and this one resolves to the root.
        await prepareRequest();
        await mkdir(join(root, 'src', 'docs'), { recursive: true });
        await writeFile(join(root, 'src', 'docs', 'x.md'), 'CONTENT\n');
        await symlink(root, join(root, 'tmp', 'at-root'));

        const inside = await ledger(['run', '--out', 'tmp/at-root/src/docs/via-root.json']);
        expect(inside.ok, JSON.stringify(inside)).toBe(true);
        await expect(readFile(join(root, 'src', 'docs', 'via-root.json'), 'utf8')).resolves.toContain(changeId);
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
