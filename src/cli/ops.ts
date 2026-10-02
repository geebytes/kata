import { readFlag, splitFlag, switchPresent } from './invocation.js';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { resolveWorkspaceRoot } from '../core/layout.js';
import { acknowledgeCometOpen } from '../core/workflow-profile.js';
import { codeGraphInvocation } from '../codegraph/runtime.js';
import { createWorktree, listWorktrees, recoverWorktreeRecords, removeWorktreeSafely, worktreesDir } from '../workflow/worktree.js';
import { loadEvaluationManifest, persistEvaluationReport, runEvaluation } from '../eval/runner.js';
import { runProcess, runProcessSync } from '../process/run.js';

/** The CodeGraph subcommands this CLI dispatches to the installed binary. */
const CODEGRAPH_SUBCOMMANDS = ['explore', 'query', 'impact', 'affected', 'node', 'status', 'index', 'sync'] as const;
type CodegraphSubcommand = (typeof CODEGRAPH_SUBCOMMANDS)[number];
import { getCometVersion, installComet, readCometCompatibility, resolveCometPath, updateComet, verifyComet } from '../comet/install.js';
import { nextActionForTask } from '../workflow/navigation.js';
import { argValue, flagPresent, parseChangeArg, parseRootArg } from './invocation.js';
import { listTaskCandidates, readTaskCandidate, recommendNextTask, type TaskCandidate } from './tasks.js';
import { parseDelegationArgs } from './handoff.js';

/**
 * The operational surfaces: evaluation, worktrees, the adversarial review tooling, the collector, CodeGraph and Comet.
 *
 * They are grouped by *shape* rather than by domain — each is a thin command adapter over one module, with no shared
 * rules between them — and they were the last handlers left in the entry point once the workflow families moved out.
 * The grouping is deliberate: they are what an operator runs *about* a task rather than *as* a phase of one.
 */

export async function runEvalCommand(argv: string[]): Promise<Record<string, unknown>> {
    // A switch is a switch in either spelling, through the shared reader (T6-1/F-1).
    const [manifestPath, ...rest] = argv.filter((arg) => !switchPresent([arg], '--json') && !switchPresent([arg], '--quiet'));
    if (!manifestPath || manifestPath.startsWith('--')) {
        throw new Error('Usage: kata-cli eval <manifest.json> [--persist <report.json>] [--root <path>]');
    }
    // R12-F4: `--persist=…` produced no report file while the command reported success, and `--root=` fell back to
    // workspace discovery. Both are documented value flags, so both go through the one reader.
    const rootRead = readFlag(rest, '--root');
    if (rootRead.present && rootRead.value === undefined) {
        // R12-F6: `--root=` fell back to workspace discovery — a named root silently ignored. Present-but-empty says so.
        throw new Error('Invalid root: --root requires a path.');
    }
    const root = rootRead.value ?? resolveWorkspaceRoot();
    const manifest = await loadEvaluationManifest(manifestPath);
    const report = await runEvaluation(manifest, root);

    const persistRead = readFlag(rest, '--persist');
    if (persistRead.present && persistRead.value === undefined) {
        // R12-F6: `--persist=` produced no file while the command reported success — the report the operator asked for
        // was silently not written.
        throw new Error('Invalid persist path: --persist requires a path.');
    }
    const persistPath = persistRead.value;
    if (persistPath) await persistEvaluationReport(report, persistPath);

    return {
        command: 'eval',
        manifest: manifestPath,
        fixtures: report.runs.map((run) => ({
            id: run.id,
            steps: run.steps,
            expected: run.expected,
            // A reader must not have to re-derive the comparison from two objects; the verdict is the comparison.
            expectation: run.expectation,
            acceptances: run.acceptances,
            passed: run.acceptancesPassed,
            failed: run.acceptancesFailed,
            repairs: run.repairCount,
            latencyMs: run.latencyMs,
        })),
        metrics: report.metrics,
        releaseGates: report.releaseGates,
        unmeasured: report.unmeasured,
        durationMs: report.durationMs,
        // The plan's manual criterion reads `concurrency` off this command, and a report that ran parallel without
        // saying so is the failure the note below exists to avoid. Both surfaces carry it.
        concurrency: report.concurrency,
        ...(persistPath ? { report: persistPath } : {}),
    };
}

/**
 * `kata-cli worktree …` — linked worktrees with kata's own convention.
 *
 * `isolated_worktree` used to be a declaration kata could not act on: every host nested worktrees in its own place, and
 * from inside a nested one no task-addressed command could resolve `--root` without help. Kata now creates, lists and
 * removes them under `.kata/worktrees/` (ignored, so a nested worktree never shows up as untracked paths in its primary
 * checkout). The worktree holds the code; the task's records stay with the checkout that owns the task.
 */
/** `kata-cli revision digests --change <task> [--since <revision-id|manifestHash>]` — the per-path content table. */
export async function runRevisionCommand(argv: string[]): Promise<Record<string, unknown>> {
    const [subcommand, ...rest] = argv;
    const { readCurrentTaskRevisionState, readTaskRevision, computePathDigests } = await import('../workflow/revision.js');
    const { changeSurface, changeSurfaceAgainstWorkspace } = await import('../quality/revision-delta.js');

    if (subcommand !== 'digests') {
        throw new Error('Usage: kata-cli revision digests --change <task-id> [--since <revision-id|manifestHash>]');
    }
    const taskId = parseChangeArg(rest);
    if (!taskId) throw new Error('Usage: kata-cli revision digests --change <task-id> [--since <revision-id|manifestHash>]');
    const root = resolveWorkspaceRoot();
    // **Three states, because the two answers this command can give are not the same news.** It used to read only the
    // revision and report `revisionId: null` with "no revision is sealed for this task" — and once the reader stopped
    // throwing, a corrupted pointer produced exactly that sentence, telling an operator there was nothing sealed for a task
    // whose seal is sitting there unreadable.
    const revisionRead = await readCurrentTaskRevisionState(root, taskId);
    if (revisionRead.kind === 'unreadable') {
        return {
            command: 'revision digests',
            taskId,
            revisionId: null,
            digestCount: 0,
            error: `The sealed revision cannot be read, so its digests cannot be listed (${revisionRead.detail}).`,
        };
    }
    const revision = revisionRead.kind === 'current' ? revisionRead.revision : null;
    if (!revision) return { command: 'revision digests', taskId, revisionId: null, digestCount: 0, note: 'no revision is sealed for this task' };

    const since = argValue(rest, '--since');
    if (!since) {
        return {
            command: 'revision digests',
            taskId,
            revisionId: revision.id,
            manifestHash: revision.manifestHash,
            digestCount: Object.keys(revision.pathDigests ?? {}).length,
            pathDigests: revision.pathDigests ?? await computePathDigests(root, revision.ownedPaths),
        };
    }

    const base = await readTaskRevision(root, taskId, since).catch(() => null);
    const surface = base
        ? await changeSurface(root, base, revision)
        : revision.pathDigests
            ? await changeSurfaceAgainstWorkspace(root, revision)
            : { status: 'delta_unavailable' as const, reason: `no revision matching '${since}'` };
    return {
        command: 'revision digests',
        taskId,
        revisionId: revision.id,
        since,
        ...(surface.status === 'available' ? { changedPaths: surface.changedPaths, added: surface.added, modified: surface.modified, removed: surface.removed } : {}),
        ...(surface.status === 'unchanged' ? { changedPaths: [] } : {}),
        ...(surface.status === 'delta_unavailable' ? { deltaUnavailable: surface.reason } : {}),
        status: surface.status,
    };
}

export async function runWorktreeCommand(argv: string[]): Promise<Record<string, unknown>> {
    const [subcommand, ...rest] = argv;
    const root = resolveWorkspaceRoot();

    if (!subcommand || subcommand === 'list') {
        const entries = await listWorktrees(root);
        return {
            command: 'worktree list',
            workspaceRoot: root,
            worktreesDir: worktreesDir(root),
            worktrees: entries.map((entry) => ({
                path: entry.path,
                branch: entry.branch,
                kind: entry.kind,
                current: entry.current,
                tasks: entry.tasks,
            })),
        };
    }

    if (subcommand === 'create') {
        const change = parseChangeArg(rest);
        const result = await createWorktree({
            root,
            ...(change ? { taskId: change } : {}),
            ...(argValue(rest, '--branch') ? { branch: argValue(rest, '--branch')! } : {}),
            ...(argValue(rest, '--path') ? { path: argValue(rest, '--path')! } : {}),
            ...(argValue(rest, '--base') ? { base: argValue(rest, '--base')! } : {}),
        });
        return {
            command: 'worktree create',
            ...result,
            nextSteps: [
                `cd ${result.path}`,
                change ? `kata-cli hooks activate --change ${change} --role <role>` : 'kata-cli hooks activate --change <task> --role <role>',
                change ? `kata-cli status --change ${change}` : 'kata-cli status',
            ],
        };
    }

    if (subcommand === 'remove') {
        const path = rest.find((argument) => !argument.startsWith('--')) ?? argValue(rest, '--path');
        if (!path) throw new Error('Usage: kata-cli worktree remove <path> [--force]');
        // **The positional path must not also read as the change id.** `parseChangeArg` answers "the first bare token
        // that is not already spoken for", and the documented form `worktree remove <path>` puts the path there — so it
        // was returned as `--change`, which then *differed* from the derived owner and made the verb refuse every
        // worktree, including a clean one. Measured: `remove <path>` threw while `remove --path <path>` worked, i.e. the
        // documented spelling was the broken one. The path is removed from the tokens the change reader sees, so the two
        // answers come from different tokens by construction rather than by luck. Fixing the general "positional argument
        // versus value flag" rule is scoped to its own change (`docs/design/2026-10-02-record-ownership-single-derivation.md` §3.4).
        const restWithoutPath = rest.filter((argument) => argument !== path);
        // **The same guard the archive path passes through.** This verb called `removeWorktree` directly while the
        // guard lived only inside `removeWorktreeSafely`, so the one route an operator reaches by hand was the one
        // route that skipped it: measured, the guard refused and left `judge.json` in place, then this command removed
        // the worktree and the record was gone. A guard that one caller can walk around is a suggestion.
        const change = parseChangeArg(restWithoutPath);
        const resolvedRoot = parseRootArg(rest) ?? root;
        // **The worktree's own content decides, and `--change` cannot replace it.** The guard used to look up the task
        // the *operator* named, so `worktree remove <wtB> --change A --force` checked A (which had no stranded records)
        // and then deleted B — measured, `judge.json` gone. An operator typo, not an attack. `--change` is still read,
        // because it is what callers learned to pass, but it is reconciled with the derived owner rather than trusted:
        // when the two disagree, the suspicious case is exactly the one the guard exists for, so the removal is refused.
        const derived = await worktreeOwner(resolvedRoot, path);
        const task = derived;
        if (change !== undefined && derived !== undefined && change !== derived) {
            throw new Error(
                `worktree remove was told --change ${change}, but this worktree holds the records of ${derived}. `
                    + 'Removing it would delete records the named task does not own. Re-run without --change, or with '
                    + `--change ${derived} to acknowledge what is being deleted.`,
            );
        }
        if (task === undefined) {
            throw new Error(
                `worktree remove needs the task whose records this worktree may hold: pass --change <task>. `
                    + `The worktree is ${resolve(resolvedRoot, path)}.`,
            );
        }
        return {
            command: 'worktree remove',
            ...(await removeWorktreeSafely({
                root: resolvedRoot,
                path,
                taskId: task,
                ...(flagPresent(rest, '--force') ? { force: true } : {}),
            })),
        };
    }

    if (subcommand === 'recover') {
        // **The remedy the refusal names.** `recoverWorktreeRecords` existed with no command reaching it — only tests — so
        // the guard told an operator what was missing and offered nothing to do about it. A refusal that names a command
        // nothing answers is worse than no advice: it reads as a route and is a dead end.
        const change = parseChangeArg(rest);
        const resolvedRoot = parseRootArg(rest) ?? root;
        // **The task is passed to the reader, not filtered afterwards.** Filtering the whole recovery by task id kept the
        // shape of the old defect: the work was done for every task and then narrowed by a string comparison, so a task
        // whose records the reader could not see produced the same empty answer as one with nothing to recover.
        const recovery = await recoverWorktreeRecords({ root: resolvedRoot, ...(change === undefined ? {} : { taskId: change }) });
        const scoped = change ? recovery.filter((entry) => entry.taskId === change) : recovery;
        const movedCount = scoped.reduce((total, entry) => total + entry.moved.length, 0);
        const keptCount = scoped.reduce((total, entry) => total + entry.kept.length, 0);
        const skippedCount = scoped.reduce((total, entry) => total + entry.skipped.length, 0);
        return {
            command: 'worktree recover',
            workspaceRoot: resolvedRoot,
            ...(change ? { taskId: change } : {}),
            recovered: scoped,
            movedCount,
            keptCount,
            skippedCount,
            // **A zero count says what it means.** The guard's remedy points here, and `movedCount: 0` alone reads as
            // "there was nothing to move" when it can equally mean "nothing of this task is in a worktree". The operator
            // needs the difference: the second is the state in which records are lost at archive time.
            foundNothing: movedCount === 0,
            ...(movedCount === 0
                ? {
                    note: change
                        ? `no worktree holds a record that only it has for ${change}; nothing needed recovering`
                        : 'no worktree holds a record that only it has; nothing needed recovering',
                }
                : {}),
        };
    }

    throw new Error(`Unknown worktree command: ${subcommand}. Usage: kata-cli worktree <create|list|remove|recover>`);
}

/**
 * The task whose records a worktree path holds, or `undefined` when it holds none.
 *
 * `worktree remove` must pass a task id to the guard, and requiring the operator to restate it would make the guard
 * optional in practice — the caller who forgets is the caller who walks around it. Deriving it from the worktree's own
 * `.kata/tasks/` keeps the guard on the path of least resistance.
 */
async function worktreeOwner(root: string, path: string): Promise<string | undefined> {
    const target = resolve(root, path);
    const entries = await listWorktrees(root);
    const match = entries.find((entry) => resolve(entry.path) === target);
    if (match && match.tasks.length > 0) return match.tasks[0];
    // A worktree git does not list (a fixture, or a path that is not a linked checkout yet) still carries its task
    // directory, and reading it directly keeps the guard reachable for those paths too.
    try {
        const candidates = await readdir(join(target, '.kata', 'tasks'));
        return candidates.filter((name) => !name.startsWith('.')).sort()[0];
    } catch {
        return undefined;
    }
}

// **`RETIRED_TELEMETRY_FLAGS` and `RETIRED_TELEMETRY_FIELDS` were deleted with the command that enforced them.** They were
// one fact in two encodings — the flag channel and the result-line channel — and both refusals lived in
// `runAdversarialCommand`, which is gone: caller-stated telemetry has no route to be written through any more, so a list of
// names to refuse is a declaration with nothing to refuse. The wiring check reported them by name, which is how this was
// found rather than remembered.


// **`runAdversarialCommand` was here.** Seven hundred and fifty-nine lines: `create`, `remove`, `salvage`, `brief`,
// `waive`, `note`, `finding`, `execute`, `record`, `status`, `acknowledge-open`, `version`, `path` and `verify` — the
// command surface of the round-shaped route, which certified a review with a document about a round rather than with
// claims and evidence. It was deleted with the decision that the archived records become read-only history: every
// consumer of this command was either a test fixture or a reader of one of those records, and the route it fed has not
// gated anything since the approval began requiring an evidence ledger.
//
// The `verify` subcommand is worth naming because it is the one whose absence could be mistaken for a loss: it checked
// whether a recorded pass bound to the current revision. The ledger answers the same question by construction — a
// disposition binds the working tree the next seal will mint, and a drift check compares them — so what was a command
// here is a property of the store now.

export async function readStdin(): Promise<string> {
    if (process.stdin.isTTY) return '';
    process.stdin.setEncoding('utf8');
    let data = '';
    for await (const chunk of process.stdin) data += chunk;
    return data;
}

export async function runCollectCommand(argv: string[]): Promise<Record<string, unknown>> {
    const args = parseDelegationArgs(argv);
    const root = args.root ?? resolveWorkspaceRoot();
    const candidates = (await listTaskCandidates(root)).filter((task) => ['plan', 'implement', 'hardVerify', 'review', 'judge', 'distill'].includes(task.phase));
    const selected = args.change ? candidates.find((task) => task.taskId === args.change) ?? await readTaskCandidate(root, args.change) : undefined;
    const recommended = selected ?? recommendNextTask(candidates);
    const next = recommended ? recommended.nextSkill : '/kata';
    const action = recommended
        ? nextActionForTask(recommended.taskId, next, recommended.suggestedRole, recommended.suggestedReason)
        : null;
    return {
        command: 'collect',
        mode: 'interactive',
        selectedTask: selected ?? null,
        candidates,
        recommended: {
            taskId: recommended?.taskId ?? null,
            nextSkill: next,
            role: recommended?.suggestedRole ?? null,
            reason: recommended?.suggestedReason ?? null,
            upstream: recommended?.upstream ?? null,
            slashCommand: action?.slashCommand ?? null,
            cliCommand: action?.cliCommand ?? null,
        },
        nextAction: action,
        askUser: [
            selected ? `确认回收任务：${selected.taskId}` : recommended ? `建议回收任务：${recommended.taskId}` : '请选择要回收的 Kata task，或输入 task id。',
            `确认下一步：${action?.slashCommand ?? next}`,
            // **Asked of the ledger, not of a findings count.** The leader's own decision names the gaps it found, so the
            // handoff sentence states what the receiving platform has to do rather than naming a record shape that no
            // longer exists — and when there is no ledger the sentence is the platform-handoff reminder it always was.
            recommended?.upstream?.ledger && recommended.upstream.ledger.verdict !== 'pass'
                ? '上游证据账本（ledger）判定不通过；建议作为 implementer 补齐缺口后再回收。'
                : '如果来自其他平台，请确认该平台已经完成 handoff acknowledge 并写入 evidence。',
        ],
    };
}

export function isCodegraphSubcommand(value: string): value is CodegraphSubcommand {
    return (CODEGRAPH_SUBCOMMANDS as readonly string[]).includes(value);
}

export async function runCodegraphCommand(argv: string[]): Promise<Record<string, unknown>> {
    const [subcommand, ...rest] = argv;
    if (!subcommand || !isCodegraphSubcommand(subcommand)) {
        throw new Error(`Unknown codegraph command: ${subcommand ?? ''}. Usage: kata-cli codegraph <${CODEGRAPH_SUBCOMMANDS.join('|')}> [args...]`);
    }
    const invocation = codeGraphInvocation(resolveWorkspaceRoot());
    const binary = invocation.command;
    try {
        const result = runProcessSync(invocation.command, [subcommand, ...rest], { cwd: invocation.cwd, env: invocation.env, timeoutMs: 120_000 });
        if (!result.ok) throw Object.assign(new Error(result.stderr.trim() || `codegraph ${subcommand} exited ${result.exitCode}`), { code: result.error?.code });
        const stdout = result.stdout.trim();
        return {
            command: `codegraph ${subcommand}`,
            success: true,
            args: rest,
            ...(stdout ? { output: stdout } : {}),
        };
    } catch (error: unknown) {
        const message = codegraphErrorMessage(error, binary);
        return {
            command: `codegraph ${subcommand}`,
            success: false,
            args: rest,
            error: message,
        };
    }
}

export function codegraphErrorMessage(error: unknown, binary: string): string {
    if (isNodeError(error) && (error.code === 'ENOENT' || error.code === 'EACCES')) {
        const override = process.env.STRATA_CODEGRAPH_BIN ? ` configured by STRATA_CODEGRAPH_BIN (${binary})` : '';
        return `CodeGraph binary${override} was not found or is not executable. Install codegraph, add it to PATH, or set STRATA_CODEGRAPH_BIN to the executable path.`;
    }
    return error instanceof Error ? error.message : String(error);
}

export function isNodeError(error: unknown): error is NodeJS.ErrnoException {
    return error instanceof Error && 'code' in error;
}

export async function runCometCommand(argv: string[], root = resolveWorkspaceRoot()): Promise<Record<string, unknown>> {
    const [subcommand, ...rest] = argv;
    const args = parseCometArgs(rest);

    if (subcommand === 'acknowledge-open') {
        if (!args.change) throw new Error('Usage: kata-cli comet acknowledge-open --change <id>');
        return { command: 'comet acknowledge-open', taskId: args.change, workflowProfile: await acknowledgeCometOpen(root, args.change), nextAction: { slashCommand: `/kata-design ${args.change}`, cliCommand: `kata-cli design --change ${args.change}` } };
    }

    if (subcommand === 'install' || subcommand === 'update') {
        const result = subcommand === 'install'
            ? await installComet(args.version)
            : await updateComet();
        return {
            command: `comet ${subcommand}`,
            previousVersion: result.previousVersion,
            installedVersion: result.installedVersion,
            method: result.method,
            path: result.path,
            compatUpdated: result.compatUpdated,
        };
    }

    if (subcommand === 'version') {
        // The window is what kata supports; the installed version is what is actually there, and the source says which
        // layer answered.
        const compat = await readCometCompatibility();
        const installed = await getCometVersion();
        return {
            command: 'comet version',
            compatibility: compat,
            installed: installed ?? null,
            compatMinVersion: compat.minVersion,
            compatMaxVersion: compat.maxVersion,
            compatSource: compat.source,
        };
    }

    if (subcommand === 'path') {
        const binaryPath = await resolveCometPath();
        return {
            command: 'comet path',
            path: binaryPath,
            found: binaryPath !== null,
        };
    }

    if (subcommand === 'verify') {
        const result = await verifyComet();
        return {
            command: 'comet verify',
            exists: result.exists,
            executable: result.executable,
            version: result.version,
            compatible: result.compatible,
            path: result.path,
        };
    }

    throw new Error(`Unknown comet command: ${subcommand ?? ''}. Usage: kata-cli comet <install|update|version|path|verify|acknowledge-open>`);
}

export function parseCometArgs(argv: string[]): { version?: string; change?: string } {
    const args: { version?: string; change?: string } = {};
    for (let index = 0; index < argv.length; index += 1) {
        const { flag: arg, inline } = splitFlag(argv[index] ?? '');
        // **A flag is not the next flag's value.** Measured: `--root --dry-run` set a directory named `--dry-run` and wrote
        // 14 files into it, because the neighbour guard lived in `argValue` and not in the loop that called it (R12-F1).
        const neighbour = argv[index + 1];
        const value = inline ?? (neighbour === undefined || neighbour.startsWith('--') ? undefined : neighbour);
        if ((arg === '--version' || arg === '-v') && value !== undefined) {
            args.version = value;
            if (inline === undefined) index += 1;
        } else if (arg === '--change' && value !== undefined) {
            args.change = value;
            if (inline === undefined) index += 1;
        } else if (arg !== undefined) {
            throw new Error(`Unknown comet option: ${argv[index]}`);
        }
    }
    return args;
}

/**
 * The scope a `--since` pass is recorded with: the base revision and the paths kata measured as changed (F2.3).
 *
 * The reviewer declares *that* it is a delta pass; the platform declares *over what*, because the gate has to be able to
 * verify the claim without trusting the reviewer. If the change surface cannot be measured the scope says so, and the
 * gate refuses the pass as `delta_unavailable` rather than accepting a delta nobody can check.
 */

// **`runFalsifyCommand` was here**, with the entire round-shaped disposition machinery behind it: a finding's subject had
// to exist in the task's records, an absence bound to the content surface the next seal would mint, and the reddening
// ledger recorded `{before, mutated, after}`. What the new route keeps from it is the *shape* — `executable_falsifier`
// carries the same three steps and the inline adapter measures them — written in `src/producers/verifiers.ts` and
// recorded by `ledger evidence verify`. What it does not keep is a command that disposes of a *finding*: findings belong
// to the route that produced them, and the ledger's unit is a claim with evidence.
