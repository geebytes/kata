import { readValidatedOptional } from '../core/schema.js';
import { completionPath, judgePath } from '../core/layout.js';
import { readCurrentStateOr, writeFileAtomic } from '../core/state.js';
import { assertValidTaskId } from '../core/ids.js';
import { readGitValue, runGit } from '../core/git.js';
import { runProcess } from '../process/run.js';
import { readCurrentTaskRevisionState } from './revision.js';
import { uniqueCopies } from '../core/layout.js';

/**
 * **"Approved" is not "done", and this module is the one place that distinction is derived.**
 *
 * A governed task can be certified — its acceptance verified, its review independent, its judge a PASS — and still not be
 * delivered: the certified content may sit on a branch nobody merged. Every surface that reported such a task as finished
 * was reporting a fact about the *candidate* as a fact about the *delivery*, which is the shape this repository's reviews
 * keep finding (a `status` that says continue beside a gate that refuses; a verdict that names no file).
 *
 * Four states, and they are not a ladder — they are the four honest answers to "how did this end":
 *
 * - `uncertified` — no Judge pass bound to the *current* revision, so there is nothing to deliver yet. Not a failure: a
 *   task in intake or mid-repair is here.
 * - `approved_awaiting_integration` — certified, and no integration evidence naming that revision. **In flight.**
 * - `delivered_and_archived` — integration evidence naming the current revision, *and* the governance transaction closed.
 * - `stopped_not_delivered` / `human_waived_with_gap` — a person decided to end it without delivery. Both are recorded
 *   decisions with a reason, and neither is a PASS.
 *
 * **The integration evidence is not self-reported.** The commit is checked to be an ancestor of the target ref, and the
 * check the operator names is *run* here and its exit code recorded; a record that only carried the operator's claim would
 * be the "documented flag with no reader" defect one level up. What the record cannot prove is stated rather than implied:
 * it proves the commit is in the target and that this command passed, not that the command covered everything.
 */

export type CompletionState =
    | 'uncertified'
    | 'approved_awaiting_integration'
    | 'delivered_and_archived'
    /**
     * **Delivered, and the governance record is not where it will survive.**
     *
     * `delivered_and_archived` claims two things, and this is the state where only the first is true: the certified content
     * reached the target, and the task's own records (its state, review, judge verdict and change records) exist **only
     * inside a linked worktree** — the directory `archive` removes. Measured on this repository: four merged changes have
     * 129 such files. Reporting those as archived would be the same defect as reporting an unmerged branch as delivered,
     * one layer down: a fact about the checkout reported as a fact about the record.
     */
    | 'delivered_records_elsewhere'
    | 'stopped_not_delivered'
    | 'human_waived_with_gap';

/** Where this task's own records live, as far as they can be enumerated. */
export type RecordsHome = 'primary' | 'worktree_only' | 'undetermined';

export type IntegrationCheck = {
    command: string;
    args: string[];
    exitCode: number;
    at: string;
    output?: string;
};

export type IntegrationRecord = {
    target: string;
    commit: string;
    certifiedRevisionId: string;
    check: IntegrationCheck;
    recordedAt: string;
    recordedBy?: string;
    note?: string;
};

export type TaskCompletionRecord = {
    taskId: string;
    updatedAt: string;
    integration?: IntegrationRecord;
    stop?: { reason: string; recordedAt: string; recordedBy?: string };
    waiver?: { reason: string; impact: string; recordedAt: string; recordedBy?: string };
};

export type CompletionFacts = {
    taskId: string;
    /** `null` when the task never sealed; `unreadable` when the pointer exists and cannot be read. */
    currentRevisionId: string | null;
    revisionReadState: 'absent' | 'current' | 'unreadable';
    /** Whether a Judge PASS is bound to the current revision. */
    judgedPass: boolean;
    /** The phase the task reached, or `null` when its state record could not be read. */
    phase: string | null;
    record: TaskCompletionRecord | null;
    recordReadState: 'absent' | 'usable' | 'unreadable';
    /** Whether the recorded commit is an ancestor of the recorded target ref; `null` when it could not be checked. */
    commitInTarget: boolean | null;
    /**
     * Where the task's records live. `worktree_only` means the archive's own removal target is the only holder, so the
     * record survives exactly as long as that worktree does.
     */
    recordsHome: RecordsHome;
    /** The files that exist only in a worktree, when there are any — the operator has to move them. */
    worktreeOnlyRecords: string[];
    /** The worktree(s) holding them, relative to the root. */
    worktreeOnlyHolders: string[];
};

export type CompletionDecision = {
    taskId: string;
    state: CompletionState;
    /** One sentence an operator can act on, and the reason code it is keyed by. */
    reason: string;
    detail: string;
    /** The command that moves this toward a delivery, or `null` when only a person can act. */
    road: string | null;
    integration: IntegrationRecord | null;
};

/** The one place the facts become a state. Pure: no clock, no filesystem, no second read. */
export function decideCompletion(facts: CompletionFacts): CompletionDecision {
    const { taskId, record } = facts;
    const integration = record?.integration ?? null;

    // **An unreadable record is not an absent one.** Reading it as absent would report "awaiting integration" about a
    // record somebody wrote, and the operator's next move would be to write a second one.
    if (facts.recordReadState === 'unreadable') {
        return {
            taskId,
            state: 'uncertified',
            reason: 'completion_record_unreadable',
            detail: 'The completion record could not be read, so nothing here can say how this task ended.',
            road: `kata-cli completion status --change ${taskId}`,
            integration: null,
        };
    }

    // An explicit decision outranks anything derived, because it is the only fact that says a person chose this ending.
    if (record?.stop) {
        return {
            taskId,
            state: 'stopped_not_delivered',
            reason: 'stopped_by_decision',
            detail: `Stopped without delivery: ${record.stop.reason}`,
            road: null,
            integration,
        };
    }
    if (record?.waiver) {
        return {
            taskId,
            state: 'human_waived_with_gap',
            reason: 'waived_by_decision',
            detail: `Closed with a recorded gap: ${record.waiver.reason} (impact: ${record.waiver.impact})`,
            road: null,
            integration,
        };
    }

    if (facts.revisionReadState !== 'current' || facts.currentRevisionId === null) {
        return {
            taskId,
            state: 'uncertified',
            reason: facts.revisionReadState === 'unreadable' ? 'current_revision_unreadable' : 'no_current_revision',
            detail: facts.revisionReadState === 'unreadable'
                ? 'The current revision could not be read, so there is nothing this can certify about delivery.'
                : 'No revision has been sealed, so there is nothing to deliver yet.',
            road: `kata-cli status --change ${taskId}`,
            integration,
        };
    }
    if (!facts.judgedPass) {
        return {
            taskId,
            state: 'uncertified',
            reason: 'not_judged',
            detail: `Revision '${facts.currentRevisionId}' carries no passing Judge record, so it is not a candidate for delivery.`,
            road: `kata-cli status --change ${taskId}`,
            integration,
        };
    }

    if (!integration) {
        return {
            taskId,
            state: 'approved_awaiting_integration',
            reason: 'integration_not_recorded',
            detail: `Revision '${facts.currentRevisionId}' is certified but no integration has been recorded, so this task is in flight and not delivered.`,
            road: `kata-cli completion integrate --change ${taskId} --target <branch> --commit <sha> --check <command> [--check-arg <a>]`,
            integration: null,
        };
    }
    if (integration.certifiedRevisionId !== facts.currentRevisionId) {
        return {
            taskId,
            state: 'approved_awaiting_integration',
            reason: 'integration_for_another_revision',
            detail: `The recorded integration names revision '${integration.certifiedRevisionId}', but the task now stands at '${facts.currentRevisionId}': the delivery evidence answers content that is no longer current.`,
            road: `kata-cli completion integrate --change ${taskId} --target <branch> --commit <sha> --check <command> [--check-arg <a>]`,
            integration,
        };
    }
    if (facts.commitInTarget === null) {
        // **"I could not check" is not "it is there".** The target may not resolve here at all (a ref this checkout does not
        // have, a target named before it existed), and a delivery claim resting on a comparison nobody could perform is the
        // false positive this module exists to prevent. It is named rather than folded into `commit_not_in_target`, because
        // the remedies differ: one is to merge, this one is to make the target readable.
        return {
            taskId,
            state: 'approved_awaiting_integration',
            reason: 'commit_unverifiable',
            detail: `The recorded target '${integration.target}' does not resolve to a commit here, so whether '${integration.commit}' reached it could not be checked.`,
            road: `kata-cli completion integrate --change ${taskId} --target <branch> --commit <sha> --check <command> [--check-arg <a>]`,
            integration,
        };
    }
    if (facts.commitInTarget === false) {
        return {
            taskId,
            state: 'approved_awaiting_integration',
            reason: 'commit_not_in_target',
            detail: `Commit '${integration.commit}' is not an ancestor of '${integration.target}', so the certified content is not in the target it claims.`,
            road: `kata-cli completion integrate --change ${taskId} --target <branch> --commit <sha> --check <command> [--check-arg <a>]`,
            integration,
        };
    }

    if (facts.phase !== 'archive') {
        return {
            taskId,
            state: 'approved_awaiting_integration',
            reason: 'archive_not_reached',
            detail: `Integrated into '${integration.target}' at '${integration.commit}', but the governance transaction is not closed (phase: ${facts.phase ?? 'unreadable'}), so this is not a finished task.`,
            road: `kata-cli archive --change ${taskId}`,
            integration,
        };
    }

    if (facts.recordsHome === 'undetermined') {
        // **"I could not enumerate the record" is not "the record is safe".** The enumeration walks linked worktrees and
        // two record surfaces, and a directory it cannot read makes the answer unknown rather than empty — reporting a
        // delivery here would rest on a reading that did not happen.
        return {
            taskId,
            state: 'delivered_records_elsewhere',
            reason: 'records_undetermined',
            detail: 'The task is integrated and archived, but where its governance records live could not be enumerated, so nothing here can say they survived the archive.',
            road: `kata-cli worktree recover --change ${taskId}`,
            integration,
        };
    }
    if (facts.recordsHome === 'worktree_only') {
        return {
            taskId,
            state: 'delivered_records_elsewhere',
            reason: 'records_only_in_a_worktree',
            detail: `Integrated into '${integration.target}' and archived, but ${facts.worktreeOnlyRecords.length} governed record(s) exist only inside ${facts.worktreeOnlyHolders.join(', ') || 'a linked worktree'} — the directory the archive removes.`,
            road: `kata-cli worktree recover --change ${taskId}`,
            integration,
        };
    }

    return {
        taskId,
        state: 'delivered_and_archived',
        reason: 'delivered',
        detail: `Certified at '${facts.currentRevisionId}', integrated into '${integration.target}' at '${integration.commit}', and archived, with its records in the checkout that owns the task.`,
        road: null,
        integration,
    };
}

export type CompletionRecordRead =
    | { kind: 'absent'; record: null }
    | { kind: 'usable'; record: TaskCompletionRecord }
    | { kind: 'unreadable'; detail: string };

export async function readCompletionRecord(root: string, taskId: string): Promise<CompletionRecordRead> {
    try {
        const record = await readValidatedOptional<TaskCompletionRecord>('task-completion', completionPath(root, taskId));
        return record === null ? { kind: 'absent', record: null } : { kind: 'usable', record };
    } catch (error) {
        return { kind: 'unreadable', detail: error instanceof Error ? error.message : String(error) };
    }
}

/**
 * Whether `commit` is reachable from `target` — three answers, not two.
 *
 * **Both refs are resolved first, and that ordering is what makes the third answer possible.** `git merge-base
 * --is-ancestor` reports by exit code alone, and `runGit` collapses that to `ok`; a single call could therefore not tell
 * "this commit is not in that branch" from "one of these names is not a ref here". Resolving both with `rev-parse` first
 * separates the cases: a name that does not resolve is `null` ("I could not look", which is never reported as "not
 * integrated"), and once both resolve, `--is-ancestor` failing means exactly what it says.
 *
 * The comparison is a SHA against a SHA and an exit code against zero — no git prose is parsed, which is the rule this
 * repository learned from a worktree classification that matched wording git never printed.
 */
export function commitReachesTarget(root: string, target: string, commit: string): boolean | null {
    const commitSha = readGitValue(root, ['rev-parse', '--verify', '--quiet', `${commit}^{commit}`]);
    if (commitSha === null) return false;
    const targetSha = readGitValue(root, ['rev-parse', '--verify', '--quiet', `${target}^{commit}`]);
    if (targetSha === null) return null;
    return runGit(root, ['merge-base', '--is-ancestor', commitSha, targetSha]).ok;
}

/** Read this task's completion facts from the repository. */
export async function readCompletionFacts(root: string, taskId: string): Promise<CompletionFacts> {
    assertValidTaskId(taskId);
    const revisionRead = await readCurrentTaskRevisionState(root, taskId);
    const revision = revisionRead.kind === 'current' ? revisionRead.revision : null;
    const stateRead = await readCurrentStateOr(root, taskId);
    const recordRead = await readCompletionRecord(root, taskId);

    let judgedPass = false;
    if (revision) {
        try {
            const judge = await readValidatedOptional<{ result?: string; revisionId?: string }>('judge-result', judgePath(root, taskId));
            judgedPass = judge?.result === 'PASS' && judge.revisionId === revision.id;
        } catch {
            judgedPass = false;
        }
    }

    const record = recordRead.kind === 'usable' ? recordRead.record : null;
    const integration = record?.integration ?? null;
    // **The records' own home, read from the one detector that already answers it.** `uniqueCopies` reports what would be
    // lost if a worktree went away — the same question the archive's removal guard asks — so a delivery claim and the
    // removal decision cannot disagree about which files are at risk. Its "I could not look" is carried, not swallowed.
    let recordsHome: RecordsHome = 'primary';
    let worktreeOnlyRecords: string[] = [];
    let worktreeOnlyHolders: string[] = [];
    try {
        const stranded = await uniqueCopies({ root, taskId });
        if (stranded.length > 0) {
            recordsHome = 'worktree_only';
            worktreeOnlyRecords = stranded.map((copy) => copy.path);
            worktreeOnlyHolders = [...new Set(stranded.map((copy) => copy.worktreeRelative))];
        }
    } catch {
        recordsHome = 'undetermined';
    }
    return {
        taskId,
        currentRevisionId: revision?.id ?? null,
        revisionReadState: revisionRead.kind === 'unreadable' ? 'unreadable' : revisionRead.kind === 'absent' ? 'absent' : 'current',
        judgedPass,
        phase: stateRead.kind === 'current' ? stateRead.state.phase : null,
        record,
        recordReadState: recordRead.kind === 'unreadable' ? 'unreadable' : recordRead.kind === 'absent' ? 'absent' : 'usable',
        commitInTarget: integration === null ? null : commitReachesTarget(root, integration.target, integration.commit),
        recordsHome,
        worktreeOnlyRecords,
        worktreeOnlyHolders,
    };
}

export async function readCompletion(root: string, taskId: string): Promise<CompletionDecision> {
    return decideCompletion(await readCompletionFacts(root, taskId));
}

/**
 * Record that the certified candidate reached a target, and that a check was run there.
 *
 * **Refused unless the task is certified.** This writer is what turns "certified" into "delivered", so it asks the same
 * question the reader asks: a task with no Judge pass bound to its current revision has nothing to integrate, and letting
 * the writer record one would make the record an assertion about a candidate nobody accepted.
 *
 * **The check is run, not taken on faith.** Its exit code is recorded and a non-zero one refuses the write, so the record
 * cannot describe a verification that did not happen. The check is chosen by the operator because "what counts as verified
 * in the target" is a property of the target, and a mechanism that guessed it would be inventing evidence.
 */
export async function recordIntegration(input: {
    root: string;
    taskId: string;
    target: string;
    commit: string;
    check: { command: string; args: string[] };
    timeoutMs?: number;
    recordedBy?: string;
    note?: string;
}): Promise<{ record: IntegrationRecord; decision: CompletionDecision }> {
    const { root, taskId } = input;
    assertValidTaskId(taskId);
    const facts = await readCompletionFacts(root, taskId);
    if (facts.recordReadState === 'unreadable') {
        throw new Error(`Cannot record integration for '${taskId}': the existing completion record could not be read.`);
    }
    if (facts.currentRevisionId === null || facts.revisionReadState !== 'current') {
        throw new Error(`Cannot record integration for '${taskId}': it has no readable current revision, so there is nothing to integrate.`);
    }
    if (!facts.judgedPass) {
        throw new Error(`Cannot record integration for '${taskId}': revision '${facts.currentRevisionId}' carries no passing Judge record, so nothing here has been certified for delivery.`);
    }
    if (input.target.trim() === '' || input.commit.trim() === '') {
        throw new Error(`Cannot record integration for '${taskId}': a target and a commit are both required — an integration that names neither is a claim about nothing.`);
    }

    const reaches = commitReachesTarget(root, input.target, input.commit);
    if (reaches === false) {
        throw new Error(`Cannot record integration for '${taskId}': commit '${input.commit}' is not in the history of '${input.target}'. Merge it first, then record the integration with the commit that carries it.`);
    }
    if (reaches === null) {
        throw new Error(`Cannot record integration for '${taskId}': '${input.target}' does not resolve to a commit here, so whether the candidate reached it cannot be checked.`);
    }

    const startedAt = new Date().toISOString();
    const result = await runProcess(input.check.command, input.check.args, {
        cwd: root,
        timeoutMs: input.timeoutMs ?? 600_000,
        maxCaptureBytes: 4_000,
    });
    const record: IntegrationRecord = {
        target: input.target,
        commit: input.commit,
        certifiedRevisionId: facts.currentRevisionId,
        check: {
            command: input.check.command,
            args: [...input.check.args],
            exitCode: result.exitCode ?? -1,
            at: startedAt,
            output: `${result.stdout}\n${result.stderr}`.trim().slice(0, 4_000),
        },
        recordedAt: new Date().toISOString(),
        ...(input.recordedBy === undefined ? {} : { recordedBy: input.recordedBy }),
        ...(input.note === undefined ? {} : { note: input.note }),
    };
    if (record.check.exitCode !== 0) {
        // Refused, and the record is not written: an integration whose target check failed is not an integration, and a
        // record that described it would be the "verified in the target" claim with nothing behind it.
        throw new Error(`Cannot record integration for '${taskId}': the target check '${record.check.command} ${record.check.args.join(' ')}' exited ${record.check.exitCode}.\n${record.check.output ?? ''}`);
    }

    await writeCompletionRecord(root, taskId, { ...(facts.record ?? { taskId, updatedAt: '' }), taskId, integration: record });
    return { record, decision: await readCompletion(root, taskId) };
}

/** Record that this task ends without delivery. A person's decision, with the reason it was made. */
export async function recordStop(input: { root: string; taskId: string; reason: string; recordedBy?: string }): Promise<CompletionDecision> {
    assertValidTaskId(input.taskId);
    const facts = await readCompletionFacts(input.root, input.taskId);
    if (facts.recordReadState === 'unreadable') {
        throw new Error(`Cannot record a stop for '${input.taskId}': the existing completion record could not be read.`);
    }
    if (facts.record?.integration) {
        throw new Error(`Cannot record a stop for '${input.taskId}': it already carries integration evidence, so it was delivered rather than stopped. Record what actually happened instead of overwriting the delivery.`);
    }
    await writeCompletionRecord(input.root, input.taskId, {
        ...(facts.record ?? { taskId: input.taskId, updatedAt: '' }),
        taskId: input.taskId,
        stop: { reason: input.reason, recordedAt: new Date().toISOString(), ...(input.recordedBy === undefined ? {} : { recordedBy: input.recordedBy }) },
    });
    return readCompletion(input.root, input.taskId);
}

/** Record that this task closes with a named gap. Not a PASS, and the record says so by naming the impact. */
export async function recordWaiver(input: { root: string; taskId: string; reason: string; impact: string; recordedBy?: string }): Promise<CompletionDecision> {
    assertValidTaskId(input.taskId);
    const facts = await readCompletionFacts(input.root, input.taskId);
    if (facts.recordReadState === 'unreadable') {
        throw new Error(`Cannot record a waiver for '${input.taskId}': the existing completion record could not be read.`);
    }
    if (facts.record?.integration) {
        throw new Error(`Cannot record a waiver for '${input.taskId}': it already carries integration evidence, so it was delivered rather than waived.`);
    }
    await writeCompletionRecord(input.root, input.taskId, {
        ...(facts.record ?? { taskId: input.taskId, updatedAt: '' }),
        taskId: input.taskId,
        waiver: {
            reason: input.reason,
            impact: input.impact,
            recordedAt: new Date().toISOString(),
            ...(input.recordedBy === undefined ? {} : { recordedBy: input.recordedBy }),
        },
    });
    return readCompletion(input.root, input.taskId);
}

async function writeCompletionRecord(root: string, taskId: string, record: TaskCompletionRecord): Promise<void> {
    await writeFileAtomic(completionPath(root, taskId), `${JSON.stringify({ ...record, taskId, updatedAt: new Date().toISOString() }, null, 2)}\n`);
}

/** A short, stable summary for the surfaces that publish rather than gate (`status`). */
export function summarizeCompletion(decision: CompletionDecision): Record<string, unknown> {
    return {
        state: decision.state,
        reason: decision.reason,
        detail: decision.detail,
        road: decision.road,
        ...(decision.integration === null ? {} : {
            integration: {
                target: decision.integration.target,
                commit: decision.integration.commit,
                certifiedRevisionId: decision.integration.certifiedRevisionId,
                check: { command: decision.integration.check.command, args: decision.integration.check.args, exitCode: decision.integration.check.exitCode },
            },
        }),
    };
}
