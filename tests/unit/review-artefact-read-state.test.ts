import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readReviewRecord } from '../../src/workflow/review-read.js';
import { createTaskRevisionIfChanged, readCurrentTaskRevisionState } from '../../src/workflow/revision.js';
import { currentRevisionIdentityFrom } from '../../src/workflow/verdict-binding.js';
import { appendClaim, freezeSubject, writeSubject } from '../../src/store/ledger.js';
import { ledgerVerdict, openLedgerProblems, openProblemsReportFields } from '../../src/store/verdict.js';
import { authorizeReviewRepair } from '../../src/workflow/repair-entry.js';
import { readBlockingProblems } from '../../src/workflow/review-read.js';
import { readReviewRoundsState, reviewRoundsPath } from '../../src/quality/repair.js';
import { readUpstreamSummary, suggestCandidateAction } from '../../src/workflow/navigation.js';
import { runCommand } from '../../src/workflow/orchestrator.js';
import { createTaskRevision } from '../../src/workflow/revision.js';

/**
 * Every gate distinguishes a file that was never written from one that was
 * written but cannot establish the fact it claims to record.  Treating both
 * as absence lets corrupted state create a new, unbound approval path.
 */
describe('review artefact read states', () => {
    const roots: string[] = [];
    const taskId = 'unreadable-artefact';

    afterEach(async () => {
        await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
    });

    async function rootWithReview(): Promise<string> {
        const root = await mkdtemp(join(tmpdir(), 'kata-review-artefact-'));
        roots.push(root);
        await mkdir(join(root, '.kata', 'tasks', taskId), { recursive: true });
        await writeFile(join(root, '.kata', 'tasks', taskId, 'review.json'), JSON.stringify({ status: 'approved', findings: [] }));
        return root;
    }

    it('refuses a schema-invalid current revision instead of treating it as no revision', async () => {
        const root = await rootWithReview();
        // `{}` is valid JSON, but no revision schema can establish the identity
        // to which this review should bind.
        await writeFile(join(root, '.kata', 'tasks', taskId, 'current-revision.json'), '{}');

        await expect(readReviewRecord(root, taskId)).resolves.toMatchObject({
            ok: false,
            why: expect.stringContaining('cannot be read'),
        });
    });

    /**
     * **The revision artefact's three states, asserted where they are read.**
     *
     * `readCurrentTaskRevision` answered `null` for absence and threw for drift, and its twelve call sites split between
     * the two readings — so the same corrupted file crashed the router, refused at the seal, and silently became "no
     * revision" wherever a caller had wrapped it. The sibling reader (`readReviewRecord`) refused with a reason on the
     * same file set, which is the answer the router gave for the review record and not for the revision.
     */
    it('reports an unwritten current revision and an unreadable one as different facts', async () => {
        const root = await rootWithReview();
        const revisionPath = join(root, '.kata', 'tasks', taskId, 'current-revision.json');

        // Nothing written: a change nobody has sealed yet, which is normal and must not read as an error.
        await expect(readCurrentTaskRevisionState(root, taskId)).resolves.toEqual({ kind: 'absent' });

        await writeFile(revisionPath, '{}');
        const unreadable = await readCurrentTaskRevisionState(root, taskId);
        expect(unreadable.kind).toBe('unreadable');
        expect(unreadable.kind === 'unreadable' ? unreadable.detail : '').toContain('schema');
    });

    /**
     * **One ledger, one answer to "can it be read".**
     *
     * `openLedgerProblems` re-derived the readability predicate while `ledgerVerdict` had a third condition the copy never
     * learned (`!ledger.subject`: a ledger with claims but no frozen subject decides nothing). Measured on one fixture with
     * `subject.json` removed: the reader answered `read` and published the claims as problems, while the verdict answered
     * `unreadable` — so `navigation.ts` refused the closure and routed to a repair while `readBlockingProblems`, which the
     * approval, the archive gate and the repair entry all share, published the counts. The reader now delegates the
     * refusal, so the two cannot disagree; this case pins both the answer and the sentence.
     */
    /**
     * **The command boundary refuses instead of throwing the run away.**
     *
     * Measured with a corrupted pointer: the router reported `currentRevisionUnreadable`, dispatched `/kata-verify`, and
     * `cmdVerify` then threw *after* verifying everything and *before* writing `verify.json` — the run was discarded and
     * the operator got no envelope from the very command the router had recommended. The reviewer of round 9 found this
     * by driving the real command; the case drives it too, because a reader-level assertion cannot see it.
     */
    /**
     * **The refusal is not a check-then-use: the read is handed over, not taken again.**
     *
     * Measured by corrupting the pointer *between* the caller's read and the stamp: the writer is non-atomic, so a guard
     * followed by an independent read is not a guard — the command threw after computing the judgement and before writing
     * it, which is the discard the refusal exists to prevent. This case drives the real command with a pointer that a
     * second read would find corrupt, so a re-read cannot pass.
     */
    it('stamps a judgement from the read the command already took', async () => {
        const root = await rootWithReview();
        // **The revision is the engine's, not the fixture's.** This case used to hand-write a well-formed record — an `id`
        // in the revision namespace, a manifest hash, the digests — which is a fixture deciding the very identity the
        // command is supposed to read, and the guard that forbids it reported the line for two rounds while a per-line rule
        // could not see it. Sealing through the engine gives the same case a real identity to be bound to.
        const sealed = await createTaskRevisionIfChanged({ root, taskId, ownedPaths: ['src/a.ts'], checkIds: [] });
        // Read once, through the same function the command uses, then make a *second* read answer differently.
        const taken = await readCurrentTaskRevisionState(root, taskId);
        expect(taken.kind).toBe('current');
        await writeFile(join(root, '.kata', 'tasks', taskId, 'current-revision.json'), 'not json\n');

        // The stamp must come from `taken`; a re-read would throw here.
        const { revisionBindingFields } = await import('../../src/workflow/verdict-binding.js');
        const identity = revisionBindingFields(await currentRevisionIdentityFrom(taken, root, taskId));
        expect(identity.revisionId).toBe(sealed.revision.id);
        expect(identity.manifestHash).toBe(sealed.revision.manifestHash);
    });

    /**
     * **Both report surfaces publish the same shape for an unreadable ledger.**
     *
     * The omission is a property of the *envelope*, and it was asserted on `verify` only: measured by mutating the judge
     * spread to an unconditional `openProblems: 0`, every unit case stayed green — the two surfaces could disagree about
     * whether a zero means "no problems" or "nobody looked", which is the substitution this change exists to remove. So the
     * judge drive is a case of its own.
     */
    it('omits the problem count on the judge surface too when the ledger could not be read', async () => {
        const root = await rootWithReview();
        await writeFile(
            join(root, '.kata', 'tasks', taskId, 'task.json'),
            `${JSON.stringify({ id: taskId, title: 'Artefact reads', acceptance: [{ id: 'AC-1', statement: 'x' }] })}\n`,
        );
        await writeFile(
            join(root, '.kata', 'tasks', taskId, 'current-state.json'),
            `${JSON.stringify({ taskId, phase: 'review', actor: { id: 'kata-agent', role: 'reviewer' }, updatedAt: '2026-09-29T00:00:00.000Z' })}\n`,
        );
        await writeFile(
            join(root, '.kata', 'tasks', taskId, 'review.json'),
            `${JSON.stringify({ taskId, status: 'approved', reviewEvidence: 'reviewed', findings: [] })}\n`,
        );
        // A revision the judgement can be stamped with, so the run reaches the envelope.
        await createTaskRevision({ root, taskId, ownedPaths: [], checkIds: [] }).catch(() => undefined);
        await mkdir(join(root, '.kata', 'tasks', taskId, 'review'), { recursive: true });
        await writeFile(join(root, '.kata', 'tasks', taskId, 'review', 'claims.json'), '{}');

        const judged = await runCommand('judge', taskId, root, { confirmHostModel: true });
        const diagnostics = judged.diagnostics ?? {};
        expect(diagnostics).not.toHaveProperty('openProblems');
        expect(String(diagnostics.openProblemsUnreadable ?? '')).toContain('claims.json');
    });

    /**
     * **Both judgement-recording commands refuse rather than discarding a computed result.**
     *
     * `verify` was fixed first; `judge` had the identical defect and was worse — it computes the whole judgement and only
     * then reads the revision to stamp it, so a corrupted pointer threw at the stamp and `judge.json` was never written.
     * Measured on `runCommand('judge')`: threw at `quality/judge.ts:138`, write at `:140`. Both are asserted here because a
     * reader-level case cannot see either.
     */
    it('returns a refusal envelope from verify and judge when the revision cannot be read', async () => {
        for (const command of ['verify', 'judge'] as const) {
            const root = await rootWithReview();
            await writeFile(
                join(root, '.kata', 'tasks', taskId, 'task.json'),
                `${JSON.stringify({ id: taskId, title: 'Artefact reads', acceptance: [{ id: 'AC-1', statement: 'x' }] })}\n`,
            );
            await writeFile(
                join(root, '.kata', 'tasks', taskId, 'current-state.json'),
                `${JSON.stringify({ taskId, phase: command === 'verify' ? 'hardVerify' : 'review', actor: { id: 'kata-agent', role: 'implementer' }, updatedAt: '2026-09-29T00:00:00.000Z' })}\n`,
            );
            await writeFile(join(root, '.kata', 'tasks', taskId, 'current-revision.json'), 'not json\n');
            // `judge` reads the review conclusion before it computes anything, so the fixture owes it one: the point of the
            // case is the *stamp* boundary, and a missing premise would stop the command earlier for an unrelated reason.
            await writeFile(
                join(root, '.kata', 'tasks', taskId, 'review.json'),
                `${JSON.stringify({ taskId, status: 'approved', reviewEvidence: 'reviewed', findings: [] })}\n`,
            );

            const outcome = await runCommand(command, taskId, root, { confirmHostModel: true });
            expect([command, outcome.success]).toEqual([command, false]);
            expect([command, outcome.error ?? '']).toEqual([command, expect.stringContaining('cannot be read')]);
            expect([command, outcome.diagnostics?.currentRevisionUnreadable]).toEqual([command, expect.stringContaining('current-revision.json')]);
        }
    });


    /**
     * **Every ledger state gets the same answer from both readers.**
     *
     * Two versions of the delegation borrowed the verdict's *sentence* while re-deriving the *decision* locally, and each
     * disagreed in a state the other had not considered: `malformedFiles || policyRejected` (missing `!subject`), then
     * that plus `nothingRecorded`, which turned "the ledger holds evidence but no claims" — a state the verdict calls
     * `absent` — into a refusal. Measured: a change with `evidence.json` and no claims was refused at its own repair entry
     * where HEAD allowed it. This case walks the states, so a third restatement cannot pass by covering the ones its
     * author happened to think of.
     */
    it('agrees with the verdict across every ledger state', async () => {
        const states: Array<[string, () => Promise<void>]> = [];
        const fresh = async (name: string) => {
            const root = await rootWithReview();
            return { root, taskId };
        };

        // 1. No ledger files at all.
        {
            const { root } = await fresh('none');
            const problems = await openLedgerProblems(root, taskId);
            const verdict = await ledgerVerdict({ root, changeId: taskId });
            expect([verdict.kind, problems.kind]).toEqual(['absent', 'read']);
        }

        // 2. Recorded evidence, no claims: the state the second restatement got wrong.
        {
            const { root } = await fresh('evidence-only');
            await mkdir(join(root, '.kata', 'tasks', taskId, 'review'), { recursive: true });
            await writeFile(join(root, '.kata', 'tasks', taskId, 'review', 'evidence.json'), '[]\n');
            const problems = await openLedgerProblems(root, taskId);
            const verdict = await ledgerVerdict({ root, changeId: taskId });
            expect(verdict.kind).toBe('absent');
            expect(problems.kind, 'a claimless ledger is not a corrupted one').toBe('read');
            // And the entry that refused this state must authorise on it, as it did before the delegation.
            const authorization = await authorizeReviewRepair(root, taskId);
            expect(authorization.denial ?? '').not.toContain('cannot be read');
        }

        // 3. Malformed: both refuse, with the verdict's sentence.
        {
            const { root } = await fresh('malformed');
            await mkdir(join(root, '.kata', 'tasks', taskId, 'review'), { recursive: true });
            await writeFile(join(root, '.kata', 'tasks', taskId, 'review', 'claims.json'), '{}');
            const problems = await openLedgerProblems(root, taskId);
            const verdict = await ledgerVerdict({ root, changeId: taskId });
            expect(verdict.kind).toBe('unreadable');
            expect(problems.kind).toBe('unreadable');
            expect(problems.kind === 'unreadable' ? problems.detail : '').toBe(verdict.kind === 'unreadable' ? verdict.detail : '');
        }

        // 4. Claims without a frozen subject: both refuse.
        {
            const { root } = await fresh('claims-no-subject');
            await mkdir(join(root, '.kata', 'tasks', taskId, 'review'), { recursive: true });
            await appendClaim(root, taskId, {
                id: 'C-1', statement: 's', riskClass: 'boundary', severity: 'major',
                dependsOn: [], evidenceIds: [], challengeIds: [], status: 'open', at: '', reopens: 0,
            });
            const problems = await openLedgerProblems(root, taskId);
            const verdict = await ledgerVerdict({ root, changeId: taskId });
            expect(verdict.kind).toBe('unreadable');
            expect(problems.kind).toBe('unreadable');
        }
    });

    it('answers the ledger readability question the same way as the verdict', async () => {
        const root = await rootWithReview();
        await mkdir(join(root, 'src'), { recursive: true });
        await writeFile(join(root, 'src', 'subject.ts'), 'export const subject = true;\n');
        const frozen = await freezeSubject({ root, paths: ['src/subject.ts'] });
        if (!frozen.ok) throw new Error('fixture subject did not freeze');
        await writeSubject(root, taskId, frozen.subject);
        await appendClaim(root, taskId, {
            id: 'C-1', statement: 'a claim that needs a subject', riskClass: 'boundary', severity: 'major',
            dependsOn: [], evidenceIds: [], challengeIds: [], status: 'open', at: '', reopens: 0,
        });

        // With the subject present both agree the ledger is readable.
        await expect(openLedgerProblems(root, taskId)).resolves.toMatchObject({ kind: 'read' });

        // Remove the frozen subject: the verdict has always refused this, and the reader must not answer instead.
        await rm(join(root, '.kata', 'tasks', taskId, 'review', 'subject.json'), { force: true });
        const problems = await openLedgerProblems(root, taskId);
        const verdict = await ledgerVerdict({ root, changeId: taskId });
        expect(verdict.kind).toBe('unreadable');
        expect(problems).toMatchObject({ kind: 'unreadable' });
        // The sentence comes from the verdict, so an operator reading either surface reads the same refusal.
        expect(problems.kind === 'unreadable' ? problems.detail : '').toContain('frozen subject');
    });

    it('routes an unreadable current revision to a repair instead of crashing the summary', async () => {
        const root = await rootWithReview();
        const changeId = 'revision-artefact';
        await mkdir(join(root, '.kata', 'tasks', changeId, 'review'), { recursive: true });
        await writeFile(join(root, '.kata', 'tasks', changeId, 'current-revision.json'), '{}');
        await writeFile(
            join(root, '.kata', 'tasks', changeId, 'task.json'),
            `${JSON.stringify({ id: changeId, ownedPaths: ['src/a.ts'], workflowProfile: { reviewMode: 'strict' } }, null, 2)}\n`,
        );

        // The reader must not throw, and the refusal must name itself on the summary.
        const summary = await readUpstreamSummary(root, changeId);
        expect(summary.currentRevisionUnreadable).toContain('schema');

        const action = suggestCandidateAction('review', summary);
        expect(action.reason).toBe('repair_unreadable_current_revision');

        // **And it outranks the ledger routes when both artefacts are broken.** The pointer refusal sits above them for the
        // same reason the escalation terminal does: with both broken, naming the ledger routes the operator to a repair
        // that cannot run (`build` reads the pointer, and refuses by throwing). Measured before the reorder: `reason:
        // satisfy_ledger_deficits`, priority 1995, while `currentRevisionUnreadable` was set.
        const both = suggestCandidateAction('review', { ...summary, ledger: { state: 'decided', verdict: 'fail', claims: 1, deficits: [] } as never });
        expect(both.reason).toBe('repair_unreadable_current_revision');
        expect(both.reason).not.toBe('satisfy_ledger_deficits');
    });

    it('refuses an unreadable ledger instead of letting a shared decision reader throw', async () => {
        const root = await rootWithReview();
        await mkdir(join(root, 'src'), { recursive: true });
        await writeFile(join(root, 'src', 'subject.ts'), 'export const subject = true;\n');
        const frozen = await freezeSubject({ root, paths: ['src/subject.ts'] });
        if (!frozen.ok) throw new Error('fixture subject did not freeze');
        await writeSubject(root, taskId, frozen.subject);
        // It parses as JSON but violates the ledger's claim-list contract.
        await writeFile(join(root, '.kata', 'tasks', taskId, 'review', 'claims.json'), '{}');

        await expect(readBlockingProblems(root, taskId)).resolves.toMatchObject({
            ok: false,
            why: expect.stringContaining('ledger'),
        });
    });

    /**
     * **The same malformed ledger must not crash the two commands that report it.**
     *
     * `openLedgerProblems` used to throw, and `cmdVerify` / `cmdJudge` call it bare — so a corrupt `claims.json` turned a
     * structured refusal into a stack trace on exactly the commands an operator reaches for while repairing one. The
     * reader reports the failure as a value now, which is what makes both callers able to decide.
     */
    it('reports an unreadable ledger as a value rather than throwing at the caller', async () => {
        const root = await rootWithReview();
        await mkdir(join(root, 'src'), { recursive: true });
        await writeFile(join(root, 'src', 'subject.ts'), 'export const subject = true;\n');
        const frozen = await freezeSubject({ root, paths: ['src/subject.ts'] });
        if (!frozen.ok) throw new Error('fixture subject did not freeze');
        await writeSubject(root, taskId, frozen.subject);
        await writeFile(join(root, '.kata', 'tasks', taskId, 'review', 'claims.json'), '{}');

        await expect(openLedgerProblems(root, taskId)).resolves.toMatchObject({
            kind: 'unreadable',
            detail: expect.stringContaining('claims.json'),
        });
    });

    /**
     * **The report surface publishes no count it does not have.**
     *
     * `openProblems` used to be written unconditionally, so an unreadable ledger published `0` beside a separate detail
     * string — a consumer reading only the count sees "no problems" for a ledger that said nothing of the kind. It was
     * also a field written twice and read nowhere, which is the shape this change removed elsewhere. Both halves are
     * asserted here: the count is *absent*, and the reason is what carries the fact.
     */
    it('omits the problem count when the ledger could not be read, and keeps it when it could', async () => {
        const root = await rootWithReview();
        await mkdir(join(root, 'src'), { recursive: true });
        await writeFile(join(root, 'src', 'subject.ts'), 'export const subject = true;\n');
        // `verify` reads the task and the phase, so the fixture is a real task directory rather than only a review one.
        // The point of the case is the *envelope's* treatment of an unreadable ledger, so everything else it reads has to
        // be present and valid or the command fails before reaching the field under test.
        await writeFile(
            join(root, '.kata', 'tasks', taskId, 'task.json'),
            `${JSON.stringify({ id: taskId, title: 'Artefact reads', acceptance: [{ id: 'AC-1', statement: 'x' }] })}\n`,
        );
        await writeFile(
            join(root, '.kata', 'tasks', taskId, 'current-state.json'),
            `${JSON.stringify({ taskId, phase: 'hardVerify', actor: { id: 'kata-agent', role: 'implementer' }, updatedAt: '2026-09-29T00:00:00.000Z' })}\n`,
        );
        const frozen = await freezeSubject({ root, paths: ['src/subject.ts'] });
        if (!frozen.ok) throw new Error('fixture subject did not freeze');
        await writeSubject(root, taskId, frozen.subject);

        // No ledger at all: the reader answers `absent`, and the count is a real count (zero problems recorded).
        const absent = await openProblemsReportFields(await openLedgerProblems(root, taskId));
        expect(absent).toEqual({ openProblems: 0 });

        await writeFile(join(root, '.kata', 'tasks', taskId, 'review', 'claims.json'), '{}');
        const unreadable = await openProblemsReportFields(await openLedgerProblems(root, taskId));
        expect(unreadable.openProblems).toBeUndefined();
        expect(unreadable.openProblemsUnreadable).toContain('claims.json');

        // **And the envelope is where the omission has to be visible**, because that is what a consumer reads. The
        // projection above cannot show it — its `problems` key is always present — so asserting only that would leave the
        // spread free to publish a `0` again. Measured: reverting the spread to an unconditional `openProblems` left
        // every case in this file green until this assertion existed.
        const summary = await readUpstreamSummary(root, taskId);
        expect(summary.ledger?.state).toBe('unreadable');
        // Driven through the command, because the omission lives in the envelope the command returns.
        const verified = await runCommand('verify', taskId, root);
        const diagnostics = verified.diagnostics ?? {};
        expect(diagnostics).not.toHaveProperty('openProblems');
        expect(diagnostics.openProblemsUnreadable).toContain('claims.json');
    });

    it('reports a review-round history that exists but cannot be read', async () => {
        const root = await rootWithReview();
        // A directory at the history path is not absence: readFile reports EISDIR.
        await mkdir(reviewRoundsPath(root, taskId), { recursive: true });

        await expect(readReviewRoundsState(root, taskId)).resolves.toMatchObject({
            kind: 'unreadable',
            detail: expect.any(String),
        });
    });

    it('refuses a mixed valid and malformed round history instead of continuing from its valid prefix', async () => {
        const root = await rootWithReview();
        await mkdir(join(root, '.kata', 'tasks', taskId), { recursive: true });
        await writeFile(
            reviewRoundsPath(root, taskId),
            `${JSON.stringify({ at: '2026-09-29T00:00:00.000Z', blockingIds: ['R-1'], blockingCount: 1 })}\nnot-json\n`,
        );

        await expect(readReviewRoundsState(root, taskId)).resolves.toMatchObject({
            kind: 'unreadable',
            rounds: expect.arrayContaining([expect.objectContaining({ blockingIds: ['R-1'], blockingCount: 1 })]),
        });
    });

    /**
     * **A corrupted round history has to reach the router, or refusing it changes nothing.**
     *
     * Every case above asserts what a *reader* answers, and the first version of this repair stopped there. Measured: deleting
     * the `unreadable` condition from `navigation.ts` left all of them green, because nothing drove the decision they were
     * supposed to protect. That is this change's own recurring defect — 'a reader can be right and still be ignored'
     * (design doc §8.1) — reproduced in the regression written to fix it.
     *
     * This case drives `readUpstreamSummary` into `suggestCandidateAction`, which is the surface the CLI dispatches from.
     */
    it('refuses a corrupted round history with its own reason rather than escalating it', async () => {
        const root = await rootWithReview();
        const changeId = 'router-artefact';
        await mkdir(join(root, '.kata', 'tasks', changeId, 'review'), { recursive: true });
        await mkdir(join(root, 'src'), { recursive: true });
        await writeFile(join(root, 'src', 'a.ts'), 'holds\n', 'utf8');
        await writeFile(
            join(root, '.kata', 'tasks', changeId, 'task.json'),
            `${JSON.stringify({ id: changeId, ownedPaths: ['src/a.ts'], workflowProfile: { reviewMode: 'strict' } }, null, 2)}\n`,
        );
        // **The revision has to be sealed, or none of the assertions below can be reached.** Without it the assessment
        // answers `not_applicable`, the route comes from elsewhere, and every `not.toBe(...)` here passes for a reason
        // that has nothing to do with a damaged history — which is what an independent review measured, twice, about this
        // file's cases (design §6.1.8/§6.1.9).
        await createTaskRevisionIfChanged({ root, taskId: changeId, ownedPaths: ['src/a.ts'], checkIds: [] });
        // One sound round at 2, then a line that is not a round. The damage is named; the surviving measurement is not
        // turned into an escalation (a history that measurably went 3 → 1 must not stop for a person because a line was
        // damaged), and it is not silently ignored either.
        await writeFile(
            reviewRoundsPath(root, changeId),
            `${JSON.stringify({ at: '2026-09-29T00:00:00.000Z', blockingIds: ['R-1'], blockingCount: 2 })}\nnot-json\n`,
        );

        const summary = await readUpstreamSummary(root, changeId);
        expect(summary.reviewLoop).toMatchObject({ kind: 'unreadable_round_history' });
        const action = suggestCandidateAction('review', summary);
        expect(action.reason).toBe('repair_unreadable_round_history');
        expect(action.reason).not.toBe('escalate_review_without_progress');

        // **And the terminal is still reachable from a damaged history**: when the measurements that survive show the loop
        // not moving, the damage does not excuse it. Four non-declining rounds plus a damaged line stops the loop — which
        // is the same refusal, reached from a longer history, and never an escalation.
        await writeFile(
            reviewRoundsPath(root, changeId),
            [
                JSON.stringify({ at: '2026-09-29T00:00:00.000Z', blockingIds: ['R-1', 'R-2'], blockingCount: 2 }),
                JSON.stringify({ at: '2026-09-29T00:01:00.000Z', blockingIds: ['R-1', 'R-2'], blockingCount: 2 }),
                JSON.stringify({ at: '2026-09-29T00:02:00.000Z', blockingIds: ['R-1', 'R-2'], blockingCount: 2 }),
                JSON.stringify({ at: '2026-09-29T00:03:00.000Z', blockingIds: ['R-1', 'R-2'], blockingCount: 2 }),
                'not-json',
            ].join('\n') + '\n',
        );
        const stalled = await readUpstreamSummary(root, changeId);
        expect(stalled.reviewLoop).toMatchObject({ kind: 'unreadable_round_history' });
        expect(suggestCandidateAction('review', stalled).reason).not.toBe('escalate_review_without_progress');
    });

    /**
     * **The same gap, on the same fixture, one branch over**: a corrupted round history that also has a broken ledger used
     * to be dispatched to `/kata-build` because the ledger routes were evaluated first. Refusing to read the history and
     * then routing a repair anyway is the refusal not existing.
     *
     * **The refusal, not the escalation.** This case used to assert `reviewEscalation` was defined, and that assertion
     * outlived the reason for it: the history file holds no parseable round, so an escalation raised from it carried
     * `rounds: 0` and `blockingIds: []` — a terminal verdict ('the recent repairs did not reduce the blocking problems')
     * about a revision for which nothing was counted, and one that outranked the branch written for the unreadable
     * pointer. What this case is about is that the damage is *named and routed* rather than worked around, which is now
     * `repair_unreadable_round_history`.
     */
    it('keeps the unreadable-history refusal ahead of a broken ledger on the routing surface', async () => {
        const root = await rootWithReview();
        const changeId = 'router-artefact';
        await mkdir(join(root, '.kata', 'tasks', changeId, 'review'), { recursive: true });
        await mkdir(join(root, 'src'), { recursive: true });
        await writeFile(join(root, 'src', 'a.ts'), 'holds\n', 'utf8');
        await writeFile(
            join(root, '.kata', 'tasks', changeId, 'task.json'),
            `${JSON.stringify({ id: changeId, ownedPaths: ['src/a.ts'], workflowProfile: { reviewMode: 'strict' } }, null, 2)}\n`,
        );
        // **The refused state has to be reachable, or the name asserts nothing.** This case sealed no revision, so the
        // assessment answered `not_applicable` and the route came from the ledger: the *order* its name claims was never
        // exercised, and moving the round-history arm below the ledger branches reddened nothing (an independent review
        // measured that). Sealing first is what makes `unreadable_round_history` the state under test — the same shape
        // the pointer case above uses for `repair_unreadable_current_revision`.
        await createTaskRevisionIfChanged({ root, taskId: changeId, ownedPaths: ['src/a.ts'], checkIds: [] });
        await writeFile(reviewRoundsPath(root, changeId), 'not-json\n');
        // A ledger that exists and cannot be read decides nothing, which is what the router used to act on first.
        await writeFile(join(root, '.kata', 'tasks', changeId, 'review', 'claims.json'), '{}');

        const summary = await readUpstreamSummary(root, changeId);
        expect(summary.ledger?.state).toBe('unreadable');
        expect(summary.reviewLoop).toMatchObject({ kind: 'unreadable_round_history' });

        const action = suggestCandidateAction('review', summary);
        expect(action.reason).toBe('repair_unreadable_round_history');
        // The order is the claim: the round-history refusal wins over the ledger route that a broken ledger would
        // otherwise take. (The skill is `/kata-build` on this arm by design — it is a build-domain repair, and that is
        // exactly why the *reason* has to be the one that sends it there.)
        expect(action.reason).not.toBe('satisfy_ledger_deficits');
    });
});
