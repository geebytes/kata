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
import { argValue, parseChangeArg, parseRootArg } from './cli/invocation.js';
import { parseWikiArgs, runWikiCommand } from './cli/wiki.js';
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
    roleForPhase,
    runTasksCommand,
    type ResolvedTask,
    type TaskCandidate,
} from './cli/tasks.js';

// The role table is part of the task family now; re-exported so callers that know the entry point keep working.
export { roleForPhase } from './cli/tasks.js';
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
            'Usage: kata-cli <init|update|uninstall|discover|comet|codegraph|status|open|design|build|verify|archive|hotfix|tweak|collect|next> [change|--change change]',
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



function shouldUseInitWizard(argv: string[]): boolean {
    if (argv.includes('--platform') || argv.includes('--scope') || argv.includes('--home')) return false;
    if (argv.includes('--yes')) return true;
    return argv.length === 0 && process.stdin.isTTY;
}

async function runInitWizardCommand(argv: string[], defaultRoot?: string): Promise<Record<string, unknown>> {
    const args = parseInstallerArgs(argv, { requirePlatform: false, allowWizard: true });
    const root = args.options.root ?? defaultRoot ?? resolveWorkspaceRoot();
    const useAuto = args.yes || !process.stdin.isTTY;
    let platforms = await discoverPlatforms({ ...args.options, root });
    // Discover the live comet manifest so the wizard can offer flags / detect
    // breaking-change mitigations appropriate to the installed comet version.
    const cometBinary = await resolveCometPath();
    const cometVersion = cometBinary ? await getCometVersion(cometBinary) : null;
    const cometCompat = await loadCometCompatibilityAsync({ cometBinary: cometBinary ?? undefined }).catch(() => loadCometCompatibility());
    const plan = useAuto
        ? await (async () => {
            platforms = await discoverPlatforms({ ...args.options, root });
            return planDetectedInit(platforms, { scope: 'project', language: 'zh' });
        })()
        : await promptInitPlan(platforms);
    // Forward applicable comet flags the user actually picked. Auto mode keeps
    // the manifest's declared defaults; interactive mode prompts per spec.
    const cometExtras: CometExtraOptions = useAuto
        ? collectAutoCometExtras(cometCompat)
        : await promptCometOptions({
            compat: cometCompat,
            scope: plan.scope,
            language: plan.language,
            cometVersion,
        }).catch(() => ({}));
    // Forward the wizard's platform selection to comet init. Comet 0.4.x only
    // accepts a single --platform per invocation and its interactive mode
    // blocks on stdin prompts, so looping a *spawn* would show the user a
    // sequence of full comet wizards ("repeated installs"). Running each
    // platform as a non-interactive capture (--yes) keeps the loop silent and
    // fast, and kata itself installs the kata skills env-dir aware.
    const selectedPlatformIds = plan.selected.map((platform) => platform.platform);
    const cometInit = useAuto
        ? {
            command: 'comet init',
            status: 'deferred' as const,
            path: null,
            root,
            scope: plan.scope,
            language: plan.language,
            nextCommand: `comet init ${root} --scope ${plan.scope} --language ${plan.language}${
                selectedPlatformIds.length > 0 ? ` --platform ${selectedPlatformIds.join(' --platform ')}` : ''
            }`,
        }
        : await initCometProject({
            root,
            scope: plan.scope,
            language: plan.language,
            // Interactive wizard: run comet headless so it never blocks the
            // terminal waiting for stdin prompts during the multi-platform loop.
            yes: true,
            platforms: selectedPlatformIds,
            extras: cometExtras,
            compat: cometCompat,
            cometVersion,
        });
    const gitFlowInit = args.options.dryRun
        ? { status: 'skipped' as const, reason: 'dry_run' }
        : await initializeGitFlowProject(root, { interactive: !useAuto && process.stdin.isTTY });
    const reports = [];
    const preStates: PlatformInstallState[] = [];
    for (const platform of plan.selected) {
        preStates.push(await identifyPlatformInstallState(platform, { ...args.options, root }));
    }
    for (const platform of plan.selected) {
        reports.push(
            await install(
                platform.platform,
                plan.scope,
                optionsForWizardInstall(args.options, plan.scope, platform.root, plan.language),
            ),
        );
    }

    const codegraphResult = useAuto
        ? { codegraph: { status: 'deferred', nextCommand: 'kata-cli codegraph install --yes' } }
        : (() => {
            const invocation = codeGraphInvocation(root);
            const index = runProcessSync(invocation.command, ['index'], { cwd: invocation.cwd, env: invocation.env, timeoutMs: 60_000 });
            return index.ok
                ? { codegraph: { status: 'initialized', ...(index.stdout.trim() ? { error: undefined } : {}) } }
                : { codegraph: { status: 'failed', error: index.stderr.trim() || `codegraph index exited ${index.exitCode}` } };
        })();

    const result = mergeInstallReports({
        command: 'init',
        mode: useAuto ? 'auto' : 'interactive',
        scope: plan.scope,
        reports,
    });
    return { ...result, cometInit, gitFlowInit, ...codegraphResult };
}

/**
 * Build a non-interactive comet extras payload from the compatibility manifest.
 *
 * In `--yes` mode the user is not asked per-flag, so we apply any manifest-
 * declared defaults (treated as "comet's recommended behaviour") and forward
 * them. Returning an empty object leaves comet to its own defaults — that's
 * exactly the historical behaviour, so this is purely additive.
 */
function collectAutoCometExtras(compat: CometCompatibility | undefined): CometExtraOptions {
    const extras: CometExtraOptions = {};
    if (!compat?.flags?.init) return extras;
    for (const [flagName, spec] of Object.entries(compat.flags.init)) {
        if (spec.preview) continue;
        if (spec.default === undefined || spec.default === false) continue;
        extras[flagName] = spec.default;
    }
    return extras;
}









type WorkflowHandoffRole = 'designer' | 'implementer' | 'reviewer' | 'judge' | 'distiller';















/**
 * The role a task in this phase is activated as, which is also the role the hook guard accepts. It is the phase table's
 * `activeRoleByPhase`, shared with the hook, so activation and enforcement cannot disagree.
 */








async function runEvalCommand(argv: string[]): Promise<Record<string, unknown>> {
    const [manifestPath, ...rest] = argv.filter((arg) => arg !== '--json' && arg !== '--quiet');
    if (!manifestPath || manifestPath.startsWith('--')) {
        throw new Error('Usage: kata-cli eval <manifest.json> [--persist <report.json>] [--root <path>]');
    }
    const rootIndex = rest.indexOf('--root');
    const root = rootIndex >= 0 ? rest[rootIndex + 1] ?? resolveWorkspaceRoot() : resolveWorkspaceRoot();
    const manifest = await loadEvaluationManifest(manifestPath);
    const report = await runEvaluation(manifest, root);

    const persistIndex = rest.indexOf('--persist');
    const persistPath = persistIndex >= 0 ? rest[persistIndex + 1] : undefined;
    if (persistPath) await persistEvaluationReport(report, persistPath);

    return {
        command: 'eval',
        manifest: manifestPath,
        fixtures: report.runs.map((run) => ({
            id: run.id,
            steps: run.steps,
            expected: run.expected,
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
        ...(persistPath ? { report: persistPath } : {}),
    };
}



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
async function runWorktreeCommand(argv: string[]): Promise<Record<string, unknown>> {
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
        return { command: 'worktree remove', ...(await removeWorktree({ root, path, ...(rest.includes('--force') ? { force: true } : {}) })) };
    }

    throw new Error(`Unknown worktree command: ${subcommand}. Usage: kata-cli worktree <create|list|remove>`);
}


/** The sealed revision's manifest hash, for binding a recorded pass to the content it reviewed. */
async function currentRevisionManifest(root: string, taskId: string): Promise<{ manifestHash?: string }> {
    const { readCurrentTaskRevision } = await import('./workflow/revision.js');
    const revision = await readCurrentTaskRevision(root, taskId);
    return revision?.manifestHash ? { manifestHash: revision.manifestHash } : {};
}

async function runAdversarialCommand(argv: string[]): Promise<Record<string, unknown>> {
    const [subcommand, ...rest] = argv;
    const change = parseChangeArg(rest);
    if (!change) throw new Error(`Usage: kata-cli adversarial <brief|record|status> --change <task-id> [--node verify|review]`);
    const root = resolveWorkspaceRoot();
    const nodeArg = (() => {
        const index = rest.indexOf('--node');
        return index >= 0 ? rest[index + 1] : undefined;
    })();
    const node = nodeArg ?? 'verify';
    if (!isAdversarialNode(node)) throw new Error(`Unknown adversarial node: ${nodeArg}. Expected one of: ${adversarialNodes.join('|')}`);

    if (subcommand === 'brief') {
        const brief = await buildAdversarialBrief(root, change, node);
        return {
            command: 'adversarial brief',
            taskId: change,
            node,
            revisionId: brief.revisionId,
            briefSha256: brief.sha256,
            brief: brief.text,
            recordCommand: `kata-cli adversarial record --change ${change} --node ${node} --from-file <result.json>`,
        };
    }

    if (subcommand === 'waive') {
        const reason = argValue(rest, '--reason');
        if (!reason?.trim()) throw new Error('kata-cli adversarial waive requires --reason "<why this node proceeds without the pass>"');
        const record = await writeAdversarialRecord(root, change, {
            node,
            status: 'waived',
            revisionId: (await buildAdversarialBrief(root, change, node)).revisionId ?? '',
            // Stamped here, not asked of the reviewer: kata knows the sealed content this pass is about.
            ...(await currentRevisionManifest(root, change)),
            createdAt: new Date().toISOString(),
            waivedReason: reason,
            ...(argValue(rest, '--by') ? { waivedBy: argValue(rest, '--by')! } : {}),
        });
        return {
            command: 'adversarial waive',
            taskId: change,
            node,
            status: record.status,
            waivedReason: record.waivedReason,
            gate: { satisfied: true, reason: 'waived' },
        };
    }

    if (subcommand === 'record') {
        const fromFile = argValue(rest, '--from-file');
        const raw = fromFile ? await readFile(fromFile, 'utf8') : await readStdin();
        if (!raw.trim()) throw new Error('adversarial record requires the result JSON on stdin or via --from-file');
        let parsed: AdversarialRecord;
        try {
            parsed = JSON.parse(raw) as AdversarialRecord;
        } catch (error) {
            throw new Error(`adversarial record could not parse the result: ${error instanceof Error ? error.message : String(error)}`);
        }
        const record = await writeAdversarialRecord(root, change, {
            ...parsed,
            node,
            ...(await currentRevisionManifest(root, change)),
        });
        const gate = await adversarialGateFor(root, change, node);
        return {
            command: 'adversarial record',
            taskId: change,
            node,
            status: record.status,
            verdict: record.verdict ?? null,
            findings: (record.findings ?? []).map((finding) => ({ id: finding.id, severity: finding.severity, message: finding.message })),
            gate: { satisfied: gate.satisfied, reason: gate.reason ?? null },
            ...(gate.satisfied ? {} : { error: adversarialReasonFor(gate.reason) }),
        };
    }

    if (subcommand === 'status') {
        const nodes: Record<string, unknown> = {};
        for (const candidate of adversarialNodes) {
            const record = await readAdversarialRecord(root, change, candidate);
            const gate = await adversarialGateFor(root, change, candidate);
            nodes[candidate] = {
                recorded: record !== null,
                status: record?.status ?? null,
                revisionId: record?.revisionId ?? null,
                verdict: record?.verdict ?? null,
                executedInFreshContext: record?.executedInFreshContext ?? null,
                blockingFindings: blockingAdversarialFindings(record).length,
                satisfied: gate.satisfied,
                reason: gate.reason ?? null,
            };
        }
        return { command: 'adversarial status', taskId: change, nodes };
    }

    throw new Error(`Unknown adversarial command: ${subcommand ?? ''}. Usage: kata-cli adversarial <brief|record|waive|status>`);
}

function isAdversarialNode(value: string): value is AdversarialNode {
    return (adversarialNodes as readonly string[]).includes(value);
}


async function readStdin(): Promise<string> {
    if (process.stdin.isTTY) return '';
    process.stdin.setEncoding('utf8');
    let data = '';
    for await (const chunk of process.stdin) data += chunk;
    return data;
}


async function runHandoffCommand(argv: string[]): Promise<Record<string, unknown>> {
    const [subcommand, ...rest] = argv;
    const args = parseHandoffArgs(rest);
    const root = args.root ?? (args.task ? resolveWorkspaceRootForTask(args.task) : resolveWorkspaceRoot());
    if (!args.task) throw new Error('Usage: kata-cli handoff <create|show|verify|acknowledge> --task <id>');
    if (subcommand === 'create') {
        if (!args.from || !args.to) throw new Error('Usage: kata-cli handoff create --task <id> --from <role> --to <role>');
        const packet = await createContextPacket({ root, taskId: args.task, fromRole: args.from as HandoffRole, toRole: args.to as HandoffRole, ...(args.platform ? { platform: args.platform } : {}) });
        return { command: 'handoff create', taskId: args.task, id: packet.id, path: `.kata/tasks/${args.task}/handoffs/${packet.id}.json`, sha256: createPacketHash(packet), packet };
    }
    if (!args.id) throw new Error('Usage: kata-cli handoff <show|verify|acknowledge> --task <id> --id <handoff-id>');
    if (subcommand === 'show') return { command: 'handoff show', packet: await readContextPacket(root, args.task, args.id) };
    if (subcommand === 'verify') return { command: 'handoff verify', ...(await verifyContextPacket({ root, taskId: args.task, id: args.id })) };
    if (subcommand === 'acknowledge') {
        if (!args.platform || !args.role) throw new Error('Usage: kata-cli handoff acknowledge --task <id> --id <handoff-id> --platform <name> --role <role>');
        const receipt = await acknowledgeContextPacket({ root, taskId: args.task, id: args.id, platform: args.platform, role: args.role as HandoffRole });
        const active = await activateHookTask({
            root,
            taskId: args.task,
            role: args.role,
            platform: args.platform,
            origin: 'handoff',
        }).catch((error: unknown) => {
            if (error instanceof Error && error.message.includes('does not match current phase')) return null;
            throw error;
        });
        return {
            command: 'handoff acknowledge',
            receipt,
            ...(active ? {
                activeTask: {
                    taskId: active.taskId,
                    role: active.role,
                    phase: active.phase,
                    ...(active.platform ? { platform: active.platform } : {}),
                    ...(active.branch ? { branch: active.branch } : {}),
                    ...(active.origin ? { origin: active.origin } : {}),
                    active: true,
                }
            } : {}),
        };
    }
    throw new Error(`Unknown handoff command: ${subcommand ?? ''}`);
}


type DelegationArgs = { change?: string; to?: string; role?: string; from?: string; root?: string; create?: boolean };

async function runDelegateCommand(argv: string[]): Promise<Record<string, unknown>> {
    const args = parseDelegationArgs(argv);
    const root = args.root ?? resolveWorkspaceRoot();
    const candidates = await listTaskCandidates(root);
    const selected = args.change ? candidates.find((task) => task.taskId === args.change) ?? await readTaskCandidate(root, args.change) : undefined;
    const recommendedTask = selected ?? recommendDelegationTask(candidates);
    const targetRole = args.role ?? inferDelegationRole(recommendedTask?.phase);
    const fromRole = args.from ?? inferCurrentRole(recommendedTask?.phase);
    const platforms = await discoverPlatforms({ root });
    const recommendedPlatform = args.to ?? recommendPlatform(platforms.map((platform) => platform.platform), targetRole);

    const base = {
        command: 'delegate',
        mode: args.create && selected ? 'create' : 'interactive',
        selectedTask: selected ?? null,
        candidates,
        recommended: {
            taskId: recommendedTask?.taskId ?? null,
            role: targetRole,
            platform: recommendedPlatform,
        },
        options: {
            roles: ['implementer', 'reviewer', 'judge', 'distiller'],
            platforms: platforms.map((platform) => ({
                platform: platform.platform,
                detected: platform.detected,
                scope: platform.scope,
                capabilities: platform.capabilities,
            })),
        },
        askUser: [
            selected ? `确认委托任务：${selected.taskId}` : '请选择要委托的 Kata task，或输入 task id。',
            `确认目标角色：${targetRole}`,
            recommendedPlatform ? `确认目标平台：${recommendedPlatform}` : '请选择目标平台，或输入自定义平台名。',
        ],
    };

    if (!args.create || !selected) return base;
    const packet = await createContextPacket({
        root,
        taskId: selected.taskId,
        fromRole: fromRole as HandoffRole,
        toRole: targetRole as HandoffRole,
        ...(recommendedPlatform ? { platform: recommendedPlatform } : {}),
    });
    const verification = await verifyContextPacket({ root, taskId: selected.taskId, id: packet.id });
    return {
        ...base,
        handoff: {
            id: packet.id,
            path: `.kata/tasks/${selected.taskId}/handoffs/${packet.id}.json`,
            sha256: createPacketHash(packet),
            verification,
        },
        targetPrompt: renderDelegationPrompt(selected.taskId, packet.id, recommendedPlatform ?? '<platform>', targetRole, packet.context.designRefs),
    };
}

async function runCollectCommand(argv: string[]): Promise<Record<string, unknown>> {
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
            recommended?.upstream?.blockingFindings
                ? '检测到上游 blocking review findings；建议作为 implementer repair。'
                : '如果来自其他平台，请确认该平台已经完成 handoff acknowledge 并写入 evidence。',
        ],
    };
}

function parseDelegationArgs(argv: string[]): DelegationArgs {
    const args: DelegationArgs = {};
    for (let index = 0; index < argv.length; index += 1) {
        const key = argv[index];
        const value = argv[index + 1];
        if (key === '--change' || key === '--task') {
            if (value === undefined) throw new Error(`${key} requires a value`);
            args.change = value; index += 1; continue;
        }
        if (key === '--to' || key === '--platform') {
            if (value === undefined) throw new Error(`${key} requires a value`);
            args.to = value; index += 1; continue;
        }
        if (key === '--role') {
            if (value === undefined) throw new Error(`${key} requires a value`);
            args.role = value; index += 1; continue;
        }
        if (key === '--from') {
            if (value === undefined) throw new Error(`${key} requires a value`);
            args.from = value; index += 1; continue;
        }
        if (key === '--root') {
            if (value === undefined) throw new Error(`${key} requires a value`);
            args.root = value; index += 1; continue;
        }
        if (key === '--create') {
            args.create = true; continue;
        }
        if (key?.startsWith('--')) throw new Error(`Unknown delegation option: ${key}`);
        if (!args.change) args.change = key;
    }
    return args;
}





function inferDelegationRole(phase?: string): string {
    if (phase === 'hardVerify') return 'reviewer';
    if (phase === 'review') return 'judge';
    if (phase === 'judge' || phase === 'distill') return 'distiller';
    return 'implementer';
}

function inferCurrentRole(phase?: string): string {
    if (phase === 'hardVerify') return 'implementer';
    if (phase === 'review') return 'reviewer';
    if (phase === 'judge' || phase === 'distill') return 'judge';
    return 'designer';
}

function recommendDelegationTask(candidates: Array<{ phase: string }>): { phase: string; taskId?: string } | undefined {
    return candidates.find((task) => task.phase === 'plan' || task.phase === 'implement')
        ?? candidates.find((task) => task.phase === 'hardVerify' || task.phase === 'review')
        ?? candidates.find((task) => task.phase !== 'archive')
        ?? candidates[0];
}

function recommendPlatform(platforms: string[], role: string): string | undefined {
    const preferred = role === 'implementer'
        ? ['opencode', 'codex', 'claude-code', 'github-copilot', 'pi']
        : ['codex', 'claude-code', 'github-copilot', 'opencode', 'pi'];
    return preferred.find((platform) => platforms.includes(platform)) ?? platforms.find((platform) => platform !== 'generic') ?? platforms[0];
}

function parseHandoffArgs(argv: string[]): { task?: string; id?: string; from?: string; to?: string; role?: string; platform?: string; root?: string } {
    const args: { task?: string; id?: string; from?: string; to?: string; role?: string; platform?: string; root?: string } = {};
    for (let index = 0; index < argv.length; index += 1) {
        const key = argv[index]; const value = argv[index + 1];
        const target = key === '--task' ? 'task' : key === '--id' ? 'id' : key === '--from' ? 'from' : key === '--to' ? 'to' : key === '--role' ? 'role' : key === '--platform' ? 'platform' : key === '--root' ? 'root' : undefined;
        if (!target || value === undefined) throw new Error(`Unknown handoff option: ${key}`);
        args[target] = value; index += 1;
    }
    return args;
}













const CODEGRAPH_SUBCOMMANDS = ['explore', 'query', 'impact', 'affected', 'node', 'status', 'index', 'sync'] as const;
type CodegraphSubcommand = (typeof CODEGRAPH_SUBCOMMANDS)[number];

function isCodegraphSubcommand(value: string): value is CodegraphSubcommand {
    return (CODEGRAPH_SUBCOMMANDS as readonly string[]).includes(value);
}

async function runCodegraphCommand(argv: string[]): Promise<Record<string, unknown>> {
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

function codegraphErrorMessage(error: unknown, binary: string): string {
    if (isNodeError(error) && (error.code === 'ENOENT' || error.code === 'EACCES')) {
        const override = process.env.STRATA_CODEGRAPH_BIN ? ` configured by STRATA_CODEGRAPH_BIN (${binary})` : '';
        return `CodeGraph binary${override} was not found or is not executable. Install codegraph, add it to PATH, or set STRATA_CODEGRAPH_BIN to the executable path.`;
    }
    return error instanceof Error ? error.message : String(error);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
    return error instanceof Error && 'code' in error;
}

async function runCometCommand(argv: string[], root = resolveWorkspaceRoot()): Promise<Record<string, unknown>> {
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

function parseCometArgs(argv: string[]): { version?: string; change?: string } {
    const args: { version?: string; change?: string } = {};
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        const value = argv[index + 1];
        if ((arg === '--version' || arg === '-v') && value !== undefined) {
            args.version = value;
            index += 1;
        } else if (arg === '--change' && value !== undefined) {
            args.change = value;
            index += 1;
        } else if (arg !== undefined) {
            throw new Error(`Unknown comet option: ${arg}`);
        }
    }
    return args;
}



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
