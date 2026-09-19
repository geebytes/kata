import { readdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { codeGraphInvocation } from './codegraph/runtime.js';
import { createWorktree, listWorktrees, removeWorktree, worktreesDir } from './workflow/worktree.js';
import { ensureWorkspaceHygiene } from './core/layout.js';
import {
    adversarialGateFor,
    adversarialNodes,
    adversarialReasonFor,
    blockingAdversarialFindings,
    buildAdversarialBrief,
    readAdversarialRecord,
    writeAdversarialRecord,
    type AdversarialNode,
    type AdversarialRecord,
} from './quality/adversarial.js';
import { runProcess, runProcessSync } from './process/run.js';
import { relationsRelativePath, resolveWorkspaceRoot, resolveWorkspaceRootForTask, skillsIndexRelativePath } from './core/layout.js';
import { recover, requiresRecovery } from './core/recovery.js';
import { CometClient } from './comet/client.js';
import { loadCometCompatibility, loadCometCompatibilityAsync, type CometCompatibility } from './comet/compat.js';
import { installComet, updateComet, verifyComet, resolveCometPath, getCometVersion, readCometCompatibility, initCometProject } from './comet/install.js';
import {
    discoverPlatforms,
    identifyPlatformInstallState,
    install,
    listManagedPlatforms,
    uninstall,
    update,
    type InstallOptions,
    type InstallScope,
    type Platform,
    type PlatformInstallState,
} from './adapters/discovery.js';
import { mergeInstallReports, optionsForWizardInstall, planDetectedInit, promptInitPlan, promptCometOptions, type CometExtraOptions } from './init-wizard.js';
import { confirmDestructive } from './cli/prompt.js';
import { runCommand, type KataCommand } from './workflow/orchestrator.js';
import { type Waiver, validateWaivers } from './quality/acceptance-matrix.js';
import { createWorkflowHandoff, renderDelegationPrompt } from './workflow/delegation-prompt.js';
import { createHandoff, type Role as HandoffRole } from './workflow/handoff.js';
import { acknowledgeContextPacket, createContextPacket, readContextPacket, requireAcknowledgedContextPacket, verifyContextPacket } from './workflow/context-fabric.js';
import { approveUserChoiceGate, consumeUserChoiceGate, createUserChoiceGate, requireUserChoiceGate, type UserChoiceBoundary } from './workflow/user-choice-gate.js';
import {
    nextActionForTask,
    nextSkillForPhase,
    readUpstreamSummary,
    statusActionPrompts,
    suggestCandidateAction,
    activeRoleForPhase,
    phaseFallbackAction,
    type NextActionReason,
    type UpstreamSummary,
} from './workflow/navigation.js';
import { buildContextManifest } from './core/context.js';
import { buildLlmWikiTask, ingestLlmWiki, initLlmWiki, lintLlmWiki, orientLlmWiki, queryLlmWiki, rebuildLlmWiki, registerWikiPages } from './wiki/llmwiki.js';
import { loadEvaluationManifest, persistEvaluationReport, runEvaluation } from './eval/runner.js';
import { revalidateStaleRecords, revalidateWikiRecord, verifySources } from './wiki/drift.js';
import { promote, rejectCandidate, retireWikiRecord } from './wiki/promotion.js';
import { readWikiRecords } from './wiki/store.js';
import { evaluateWikiClosure, writeWikiClosure } from './wiki/closure.js';
import { auditWiki, createRefreshPacket, relevantWiki } from './wiki/lifecycle.js';
import { orderedPhases, type Phase } from './core/state.js';
import { activateHookTask, currentGitBranch, deactivateHookTask, readActiveHookTask, type ActiveHookTask } from './hooks/runtime.js';
import { platformDefinitionById } from './adapters/platforms.js';
import { doctor } from './adapters/doctor.js';
import {
    acknowledgeCometOpen,
    defaultWorkflowProfile,
    developmentModes,
    isolationModes,
    isWorkflowProfile,
    reviewModes,
    updateGitFlowProfile,
    type WorkflowProfile,
} from './core/workflow-profile.js';
import { applyGitFlowPlan, initializeGitFlowProject, inspectGitFlow, type GitFlowBranchKind, type GitFlowPlan } from './core/git-flow.js';
import {
    addKataRelation,
    addTaskRelation,
    findKataRelations,
    readTaskRelations,
    resolveTerminalTask,
    type RelationEndpoint,
    type TaskRelationType,
} from './core/relations.js';
import { hashContent } from './core/hash.js';
import { currentStatePath, handoffDir, taskPath, tasksDir } from './core/layout.js';
import { createOutputContext, currentOutput, isDefaultSilentInstallerCommand, isJsonOutput, isQuietOutput, outputResult, setOutput, writeProgress, type OutputContext, type OutputOverrides } from './cli/output.js';
import {
    parseInstallerArgs,
    renderUpdateSummary,
    runAggregateUpdate,
    runDoctorCommand,
    runRuntimeRefresh,
} from './cli/installer.js';
import { runInitWizardCommand, shouldUseInitWizard } from './cli/wizard.js';
import { argValue, parseChangeArg, parseRootArg } from './cli/invocation.js';
import { parseWikiArgs, runWikiCommand } from './cli/wiki.js';
import {
    parseCometArgs,
    runAdversarialCommand,
    runCodegraphCommand,
    runCollectCommand,
    runCometCommand,
    runEvalCommand,
    runWorktreeCommand,
} from './cli/ops.js';
import { parseDelegationArgs, runDelegateCommand, runHandoffCommand, type DelegationArgs } from './cli/handoff.js';
import { runFindingsCommand } from './cli/findings.js';
import { runScopeCommand } from './cli/scope.js';
import { runRevisionCommand } from './cli/ops.js';
import {
    isResumableWorkflowCommand,
    isWorkflowCommand,
    parseWorkflowProfileArgs,
    requireWorkflowReceipt,
    resolveWorkflowProfile,
    runGateCommand,
    runWorkflowCommand,
} from './cli/workflow.js';
import {
    createPacketHash,
    discoverSingleTaskForCurrentBranch,
    listTaskCandidates,
    parseHooksArgs,
    parseOrientArgs,
    parseTasksArgs,
    readTaskCandidate,
    recommendNextTask,
    resolveTaskForCurrentBranch,
    runDispatchStatusCommand,
    runHooksCommand,
    runLocalStatusCommand,
    runOrientCommand,
    runTasksCommand,
    type ResolvedTask,
    type TaskCandidate,
} from './cli/tasks.js';

// The role table is part of the task family now; re-exported so callers that know the entry point keep working.
export { roleForPhase } from './workflow/navigation.js';
import { parseTaskRelationType, runGitFlowCommand, runRelationsCommand } from './cli/relations.js';

// The output context is the CLI's public boundary; re-exported so callers (and tests) that know the entry point keep
// working while command handlers move to their own modules.
export { createOutputContext, currentOutput } from './cli/output.js';

export function getRuntimeCompatibility(manifestPath?: string): CometCompatibility {
    return loadCometCompatibility(manifestPath);
}

export async function main(argv = process.argv.slice(2), overrides: OutputOverrides = {}): Promise<void> {
    const previousOutput = currentOutput();
    const requested = createOutputContext(argv, overrides);
    // Flags accumulate across nested calls (an installer path may call a workflow command), which is what the previous
    // OR-ing did.
    setOutput({
        ...requested,
        format: previousOutput.format === 'json' ? 'json' : requested.format,
        quiet: previousOutput.quiet || requested.quiet,
    });
    try {
        await runMain(stripOutputModeArgs(argv));
    } finally {
        setOutput(previousOutput);
    }
}

async function runMain(argv: string[]): Promise<void> {
    const [command, maybeChange] = argv;
    if (!command) {
        throw new Error('Usage: kata-cli <init|update|uninstall|discover|comet|codegraph|tasks> [--platform name] [--scope project|global] [--root path]');
    }
    const requestedChange = parseChangeArg(argv.slice(1));
    const workspaceRoot = parseRootArg(argv)
        ?? (requestedChange && command !== 'open' && (isWorkflowCommand(command) || command === 'status')
            ? resolveWorkspaceRootForTask(requestedChange)
            : resolveWorkspaceRoot());
    if (isWorkflowCommand(command) && (argv.includes('--help') || argv.includes('-h'))) {
        outputResult({
            command,
            usage: 'kata-cli <init|update|uninstall|discover|comet|codegraph|status|open|design|build|verify|archive|hotfix|tweak|collect|next> [change|--change change]',
            readOnly: true,
        });
        return;
    }

    if (command === 'init' && shouldUseInitWizard(argv.slice(1))) {
        const result = await runInitWizardCommand(argv.slice(1), workspaceRoot);
        outputResult(result);
        return;
    }

    if (command === 'init' && !process.stdin.isTTY && !argv.includes('--yes')
        && (!argv.includes('--platform') || !argv.includes('--scope'))) {
        throw new Error('kata-cli init requires explicit --platform and --scope choices in non-interactive mode; use the installation Skill to collect user confirmation first.');
    }

    if (isInstallerCommand(command) && (maybeChange === undefined || maybeChange.startsWith('--'))) {
        const args = parseInstallerArgs(argv.slice(1));
        if (!args.options.root) args.options.root = workspaceRoot;
        if (command === 'uninstall') {
            const platformLabel = args.platform === 'generic' ? 'all platforms' : args.platform;
            const confirmed = args.options.force ?? await confirmDestructive(
                `Uninstall Kata components from platform: ${platformLabel}`,
                ['Removes hooks, rules, skills, and related files.', 'Cannot be undone automatically.'],
            );
            if (!confirmed) {
                outputResult({ command: 'uninstall', aborted: true });
                return;
            }
        }
        if (command === 'update' && !argv.includes('--platform')) {
            outputResult(await runAggregateUpdate(args.scope, args.options), { human: renderUpdateSummary });
            return;
        }
        const report =
            command === 'init'
                ? await install(args.platform, args.scope, args.options)
                : command === 'update'
                    ? await update(args.platform, args.scope, args.options)
                    : await uninstall(args.platform, args.scope, args.options);
        const runtimeRefresh = command === 'update'
            ? await runRuntimeRefresh(args.options.root!)
            : undefined;
        const gitFlowInit = command === 'init'
            ? args.options.dryRun
                ? { status: 'skipped' as const, reason: 'dry_run' }
                : await initializeGitFlowProject(args.options.root!, { interactive: process.stdin.isTTY && !args.yes })
            : undefined;
        outputResult(
            {
                ...(report as unknown as Record<string, unknown>),
                ...(runtimeRefresh ? { runtimeRefresh } : {}),
                ...(gitFlowInit ? { gitFlowInit } : {}),
            },
            // The update family renders its own human summary; the boundary no longer sniffs the result shape.
            { human: renderUpdateSummary },
        );
        return;
    }

    if (command === 'discover') {
        const args = parseInstallerArgs(argv.slice(1), { requirePlatform: false });
        if (!args.options.root) args.options.root = workspaceRoot;
        outputResult({ platforms: await discoverPlatforms(args.options) });
        return;
    }

    if (command === 'doctor') {
        const result = await runDoctorCommand(argv.slice(1));
        outputResult(result);
        return;
    }

    if (command === 'recover') {
        const taskId = parseChangeArg(argv.slice(1)) ?? maybeChange;
        if (!taskId || taskId.startsWith('--')) throw new Error('Usage: kata recover --change <task-id>');
        outputResult({ command: 'recover', ...(await recover(taskId, { root: workspaceRoot })) });
        return;
    }

    if (command === 'wiki') {
        const result = await runWikiCommand(argv.slice(1));
        outputResult(result);
        return;
    }

    if (command === 'tasks') {
        const result = await runTasksCommand(argv.slice(1));
        outputResult(result);
        return;
    }

    if (command === 'eval') {
        const result = await runEvalCommand(argv.slice(1));
        outputResult(result);
        return;
    }

    if (command === 'worktree') {
        const result = await runWorktreeCommand(argv.slice(1));
        outputResult(result);
        return;
    }

    if (command === 'revision') {
        const result = await runRevisionCommand(argv.slice(1));
        outputResult(result);
        return;
    }

    if (command === 'findings') {
        const result = await runFindingsCommand(argv.slice(1));
        outputResult(result);
        return;
    }

    if (command === 'scope') {
        const result = await runScopeCommand(argv.slice(1));
        outputResult(result);
        return;
    }

    if (command === 'adversarial') {
        const result = await runAdversarialCommand(argv.slice(1));
        outputResult(result);
        return;
    }

    if (command === 'relations') {
        const result = await runRelationsCommand(argv.slice(1));
        outputResult(result);
        return;
    }

    if (command === 'orient') {
        const result = await runOrientCommand(argv.slice(1));
        outputResult(result);
        return;
    }

    if (command === 'hooks') {
        const result = await runHooksCommand(argv.slice(1));
        outputResult(result);
        return;
    }

    if (command === 'handoff') {
        outputResult(await runHandoffCommand(argv.slice(1)));
        return;
    }
    if (command === 'gate') {
        outputResult(await runGateCommand(argv.slice(1), workspaceRoot));
        return;
    }

    if (command === 'collect') {
        outputResult(await runCollectCommand(argv.slice(1)));
        return;
    }

    if (command === 'comet') {
        const result = await runCometCommand(argv.slice(1), workspaceRoot);
        outputResult(result);
        return;
    }

    if (command === 'codegraph') {
        const result = await runCodegraphCommand(argv.slice(1));
        outputResult(result);
        return;
    }

    if (command === 'git-flow') {
        outputResult(await runGitFlowCommand(argv.slice(1), workspaceRoot));
        return;
    }

    let change = parseChangeArg(argv.slice(1));
    let resolved: ResolvedTask | null = null;
    if (!change && (isResumableWorkflowCommand(command) || command === 'status')) {
        resolved = await resolveTaskForCurrentBranch(workspaceRoot);
        if (resolved) change = resolved.taskId;
    }
    if (command === 'status' && !change) {
        outputResult(await runDispatchStatusCommand(workspaceRoot));
        return;
    }

    if (!change) {
        throw new Error(
            'Usage: kata-cli <init|update|uninstall|discover|comet|codegraph|status|open|design|build|verify|archive|hotfix|tweak|collect|next|findings|scope|adversarial|worktree|eval> [change|--change change]',
        );
    }
    if (command === 'status') {
        outputResult(await runLocalStatusCommand(change, resolved, workspaceRoot));
        return;
    }

    const client = new CometClient({ compatibility: getRuntimeCompatibility() });
    if (command === 'init') {
        const initLanguage = process.stdin.isTTY
            ? await (await import('./cli/prompt.js')).select<'en' | 'zh'>('Language for skills', [
                { value: 'en', label: 'English' },
                { value: 'zh', label: '中文' },
            ])
            : 'zh';
        await client.init(change, { language: initLanguage });
        // Setup is the other safe moment for the ignore rules: the workspace is being written anyway.
        await ensureWorkspaceHygiene(workspaceRoot).catch(() => null);
        outputResult({
            command: 'init',
            gitFlowInit: await initializeGitFlowProject(workspaceRoot, { interactive: process.stdin.isTTY }),
        });
    }
    else if (command === 'next') outputResult(await client.next(change) as unknown as Record<string, unknown>);
    else if (isWorkflowCommand(command)) {
        const result = await runWorkflowCommand(command, change, workspaceRoot, workflowPlatform(argv.slice(1)) ?? resolved?.platform, argv.slice(1));
        outputResult(result);
    } else throw new Error(`Unknown command: ${command}`);
}


/**
 * One refresh stage's outcome. `status` distinguishes a stage that could not run (`skipped`) from one that ran and
 * failed, and from one that was cut off by its own timeout — the three used to be collapsed into `success: false`.
 */


function stripOutputModeArgs(argv: string[]): string[] {
    return argv.filter((arg) => arg !== '--quiet' && arg !== '--json');
}


function workflowPlatform(argv: string[]): string | undefined {
    const index = argv.indexOf('--platform');
    return index >= 0 ? argv[index + 1] : undefined;
}


function isInstallerCommand(command: string): command is 'init' | 'update' | 'uninstall' {
    return command === 'init' || command === 'update' || command === 'uninstall';
}


/**
 * The role a task in this phase is activated as, which is also the role the hook guard accepts. It is the phase table's
 * `activeRoleByPhase`, shared with the hook, so activation and enforcement cannot disagree.
 */


/**
 * `kata-cli adversarial …` — the independent adversarial pass at the verify and review nodes.
 *
 * `brief` renders the self-contained brief for a clean-context subagent and reports the hash the result must carry;
 * `record` validates and files the result; `status` reports both nodes. The gate that consumes the record lives in the
 * workflow (verify and review refuse to conclude without one), so this command is the only way in.
 */
/**
 * `kata-cli worktree …` — linked worktrees with kata's own convention.
 *
 * `isolated_worktree` used to be a declaration kata could not act on: every host nested worktrees in its own place, and
 * from inside a nested one no task-addressed command could resolve `--root` without help. Kata now creates, lists and
 * removes them under `.kata/worktrees/` (ignored, so a nested worktree never shows up as untracked paths in its primary
 * checkout) and carries the task's state into the checkout.
 */


/** The sealed revision's manifest hash, for binding a recorded pass to the content it reviewed. */


function isCliEntrypoint(): boolean {
    try {
        return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1] ?? '');
    } catch {
        return false;
    }
}


if (isCliEntrypoint()) {
    main().catch((error: unknown) => {
        // The same context the results went through: an error is output too.
        const output = currentOutput();
        output.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
    });
}
