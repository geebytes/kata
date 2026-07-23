import { readdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { codeGraphExecutionEnv } from './codegraph/runtime.js';
import { resolveWorkspaceRoot, resolveWorkspaceRootForTask } from './core/layout.js';
import { recover, requiresRecovery } from './core/recovery.js';
import { CometClient } from './comet/client.js';
import { loadCometCompatibility, type CometCompatibility } from './comet/compat.js';
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
import { mergeInstallReports, optionsForWizardInstall, planDetectedInit, promptInitPlan } from './init-wizard.js';
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
  type UpstreamSummary,
} from './workflow/navigation.js';
import { buildContextManifest } from './core/context.js';
import { buildLlmWikiTask, ingestLlmWiki, initLlmWiki, lintLlmWiki, orientLlmWiki, queryLlmWiki, rebuildLlmWiki, registerWikiPages } from './wiki/llmwiki.js';
import { verifySources } from './wiki/drift.js';
import { promote, rejectCandidate, retireWikiRecord } from './wiki/promotion.js';
import { readWikiRecords } from './wiki/store.js';
import { evaluateWikiClosure, writeWikiClosure } from './wiki/closure.js';
import { auditWiki, createRefreshPacket, relevantWiki } from './wiki/lifecycle.js';
import type { Phase } from './core/state.js';
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

export function getRuntimeCompatibility(manifestPath?: string): CometCompatibility {
  return loadCometCompatibility(manifestPath);
}

let quietOutput = false;
let jsonOutput = false;

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const previousQuiet = quietOutput;
  const previousJson = jsonOutput;
  jsonOutput = previousJson || isJsonOutput(argv);
  quietOutput = previousQuiet || isQuietOutput(argv) || isDefaultSilentInstallerCommand(argv);
  try {
    await runMain(stripOutputModeArgs(argv));
  } finally {
    quietOutput = previousQuiet;
    jsonOutput = previousJson;
  }
}

async function runMain(argv: string[]): Promise<void> {
  const [command, maybeChange] = argv;
  if (!command) {
    throw new Error('Usage: kata <init|update|uninstall|discover|comet|codegraph|tasks> [--platform name] [--scope project|global] [--root path]');
  }
  const requestedChange = parseChangeArg(argv.slice(1));
  const workspaceRoot = parseRootArg(argv)
    ?? (requestedChange && command !== 'open' && (isWorkflowCommand(command) || command === 'status')
      ? resolveWorkspaceRootForTask(requestedChange)
      : resolveWorkspaceRoot());
  if (isWorkflowCommand(command) && (argv.includes('--help') || argv.includes('-h'))) {
    outputResult({
      command,
      usage: 'kata <init|update|uninstall|discover|comet|codegraph|status|open|design|build|verify|archive|hotfix|tweak|collect|next> [change|--change change]',
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
    throw new Error('kata init requires explicit --platform and --scope choices in non-interactive mode; use the installation Skill to collect user confirmation first.');
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
      outputResult(await runAggregateUpdate(args.scope, args.options));
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
    outputResult({
      ...(report as unknown as Record<string, unknown>),
      ...(runtimeRefresh ? { runtimeRefresh } : {}),
      ...(gitFlowInit ? { gitFlowInit } : {}),
    });
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
      'Usage: kata <init|update|uninstall|discover|comet|codegraph|status|open|design|build|verify|archive|hotfix|tweak|collect|next> [change|--change change]',
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

async function runAggregateUpdate(
  scope: InstallScope,
  options: InstallOptions,
): Promise<Record<string, unknown>> {
  const managed = await listManagedPlatforms(scope, options);
  const detected = (await discoverPlatforms(options))
    .filter((platform) => platform.scope === scope)
    .map((platform) => platform.platform);
  const realPlatforms: Platform[] = [...new Set<Platform>([...managed, ...detected])]
    .filter((platform) => platform !== 'generic')
    .sort();
  const targets: Platform[] = [...realPlatforms];
  if (targets.length === 0 || managed.includes('generic')) targets.push('generic');
  writeUpdateProgress(`Kata update · ${scope === 'project' ? '当前项目' : '全局安装'}\n`);
  const reports = [];
  for (const platform of targets) {
    writeUpdateProgress(`\n→ 更新 ${platform}\n`);
    const report = await update(platform, scope, options);
    reports.push(report);
    writeUpdateProgress(formatUpdateReport(report));
  }
  const runtimeRefresh = await runRuntimeRefresh(options.root!);
  writeUpdateProgress(formatRuntimeRefresh(runtimeRefresh));
  return { ...mergeInstallReports({ command: 'update', mode: 'auto', scope, reports }), runtimeRefresh };
}

type RuntimeRefreshResult = {
  comet: { success: boolean; previousVersion?: string | null; installedVersion?: string | null; error?: string };
  codegraphSync: { success: boolean; output?: string; error?: string };
  codegraphIndex: { success: boolean; output?: string; error?: string };
};

async function runRuntimeRefresh(root: string): Promise<RuntimeRefreshResult> {
  const timeoutMs = runtimeRefreshTimeoutMs();
  const comet = await withTimeout(updateComet(), timeoutMs, `Comet update timed out after ${timeoutMs}ms`)
    .then((result) => ({ success: true, previousVersion: result.previousVersion, installedVersion: result.installedVersion }))
    .catch((error: unknown) => ({ success: false, error: error instanceof Error ? error.message : String(error) }));
  const runCodegraph = (subcommand: 'sync' | 'index') => {
    try {
      const output = execFileSync('codegraph', [subcommand], {
        encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024, cwd: root, env: codeGraphExecutionEnv(), stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();
      return { success: true, ...(output ? { output } : {}) };
    } catch (error: unknown) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  };
  return { comet, codegraphSync: runCodegraph('sync'), codegraphIndex: runCodegraph('index') };
}

function runtimeRefreshTimeoutMs(): number {
  const configured = Number.parseInt(process.env.KATA_RUNTIME_REFRESH_TIMEOUT_MS ?? '', 10);
  return Number.isSafeInteger(configured) && configured >= 1_000 && configured <= 120_000 ? configured : 30_000;
}

async function withTimeout<T>(operation: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), timeoutMs); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function isQuietOutput(argv: string[]): boolean {
  return process.env.STRATA_QUIET === '1' || process.env.STRATA_QUIET === 'true' || argv.includes('--quiet');
}

function isJsonOutput(argv: string[]): boolean {
  return argv.includes('--json') || process.env.STRATA_JSON === '1' || process.env.STRATA_JSON === 'true';
}

function isDefaultSilentInstallerCommand(argv: string[]): boolean {
  const command = argv[0];
  return (command === 'init' || command === 'uninstall') && !isJsonOutput(argv);
}

function stripOutputModeArgs(argv: string[]): string[] {
  return argv.filter((arg) => arg !== '--quiet' && arg !== '--json');
}

function parseRootArg(argv: string[]): string | undefined {
  const index = argv.indexOf('--root');
  return index >= 0 ? argv[index + 1] : undefined;
}

function parseChangeArg(argv: string[]): string | undefined {
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--change') return argv[index + 1];
    if (
      value === '--platform'
      || value === '--root'
      || value === '--role'
      || value === '--task-kind'
      || value === '--mode'
      || value === '--routing-mode'
      || value === '--failures'
      || value === '--failure-count'
      || value === '--isolation'
      || value === '--isolation-mode'
      || value === '--development'
      || value === '--development-mode'
      || value === '--review'
      || value === '--review-mode'
    ) {
      index += 1;
      continue;
    }
    if (value?.startsWith('--')) continue;
    return value;
  }
  return undefined;
}

function workflowPlatform(argv: string[]): string | undefined {
  const index = argv.indexOf('--platform');
  return index >= 0 ? argv[index + 1] : undefined;
}

function statusDiagnostic(candidates: TaskCandidate[] = []): Record<string, unknown> {
  const recommended = recommendNextTask(candidates);
  const action = recommended
    ? nextActionForTask(recommended.taskId, recommended.nextSkill, recommended.suggestedRole, recommended.suggestedReason)
    : null;
  return {
    command: 'status',
    taskId: null,
    phase: 'dispatch',
    success: true,
    diagnostics: {
      message: candidates.length > 0
        ? 'Multiple same-branch Kata tasks were discovered. Pick the recommended task or pass --change explicitly.'
        : 'No same-branch Kata task was discovered. Provide a change id with --change, or open a new task.',
      usage: 'kata <status|open|design|build|verify|archive|hotfix|tweak|next> --change <id>',
    },
    candidates,
    recommended: recommended
      ? {
          taskId: recommended.taskId,
          nextSkill: recommended.nextSkill,
          role: recommended.suggestedRole,
          reason: recommended.suggestedReason,
          slashCommand: action?.slashCommand,
          cliCommand: action?.cliCommand,
        }
      : null,
    nextAction: action,
    askUser: recommended
      ? [
          `发现 ${candidates.length} 个当前分支任务，建议处理：${recommended.taskId}`,
          `确认下一步：${action?.slashCommand ?? recommended.nextSkill}`,
        ]
      : ['请选择 Kata task，或输入要开启的新 change id。'],
  };
}

function isInstallerCommand(command: string): command is 'init' | 'update' | 'uninstall' {
  return command === 'init' || command === 'update' || command === 'uninstall';
}

function isWorkflowCommand(command: string): command is KataCommand {
  return ['open', 'design', 'build', 'review', 'judge', 'verify', 'archive', 'hotfix', 'tweak'].includes(command);
}

function isResumableWorkflowCommand(command: string): boolean {
  return ['design', 'build', 'review', 'judge', 'verify', 'archive'].includes(command);
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
  const plan = useAuto
    ? await (async () => {
        platforms = await discoverPlatforms({ ...args.options, root });
        return planDetectedInit(platforms, { scope: 'project', language: 'zh' });
      })()
    : await promptInitPlan(platforms);
  const cometInit = useAuto
    ? {
        command: 'comet init',
        status: 'deferred' as const,
        path: null,
        root,
        scope: plan.scope,
        language: plan.language,
        nextCommand: `comet init ${root} --scope ${plan.scope} --language ${plan.language}`,
      }
    : await initCometProject({
        root,
        scope: plan.scope,
        language: plan.language,
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
    ? { codegraph: { status: 'deferred', nextCommand: 'kata codegraph install --yes' } }
    : (() => {
        try {
          const output = execFileSync('codegraph', ['index'], {
            encoding: 'utf-8',
            cwd: root,
            env: codeGraphExecutionEnv(),
          }).trim();
          return { codegraph: { status: 'initialized', ...(output ? { error: undefined } : {}) } };
        } catch (error: unknown) {
          return { codegraph: { status: 'failed', error: error instanceof Error ? error.message : String(error) } };
        }
      })();

  const result = mergeInstallReports({
    command: 'init',
    mode: useAuto ? 'auto' : 'interactive',
    scope: plan.scope,
    reports,
  });
  return { ...result, cometInit, gitFlowInit, ...codegraphResult };
}

async function runWorkflowCommand(command: KataCommand, change: string, root: string, platform?: string, argv: string[] = []): Promise<Record<string, unknown>> {
  const waivers = command === 'build' ? await readWaiversFile(argv) : undefined;
  const inputPhase = await readWorkflowPhase(root, change);
  const boundary = boundaryForCommand(command, inputPhase);
  if (boundary) await requireUserChoiceGate({ root, taskId: change, boundary });
  // hotfix/tweak and Git-Flow preparation can create or inspect an intake task
  // before an implementer handoff exists. They do not mutate an established
  // implementation phase, so receipt enforcement begins once a task has
  // crossed intake.
  if (command !== 'open' && inputPhase !== null && inputPhase !== 'intake') {
    await requireWorkflowReceipt(root, change, roleForCommand(command));
  }
  const explicitChange = parseChangeArg(argv.slice(1));
  let workflowProfile = requiresWorkflowProfile(command) ? await resolveWorkflowProfile(command, argv) : undefined;
  const abortController = command === 'build' ? new AbortController() : undefined;
  const onProgress = command === 'build' && argv.includes('--seal')
    ? (event: { type: string; check: string; state: string; timeoutMs: number; exitCode?: number | null }) => {
        process.stderr.write(`${JSON.stringify(event)}\n`);
      }
    : undefined;
  if (abortController) {
    const onSignal = () => { abortController.abort(); process.removeListener('SIGINT', onSignal); process.removeListener('SIGTERM', onSignal); };
    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);
  }
  // A hotfix/tweak aggregate would otherwise modify code before its Git Flow
  // branch exists. Establish the task and wait for the explicit branch action
  // first; the following phase is then selected from the persisted task state.
  const branchPreparationOnly = workflowProfile?.isolationMode === 'git_flow' && command !== 'open';
  const commandToRun: KataCommand = branchPreparationOnly ? 'open' : command;
  const result = await runCommand(commandToRun, change, root, {
    title: command === 'hotfix' ? `Hotfix ${change}` : command === 'tweak' ? `Tweak ${change}` : `Change ${change}`,
    acceptance: [{ id: 'AC-1', statement: 'Implement the change.' }],
    ...(platform ? { platform } : {}),
    ...(commandToRun === 'build' ? { seal: argv.includes('--seal') } : {}),
    ...(command === 'review' ? { approve: argv.includes('--approve') } : {}),
    ...(command === 'review' && reviewEvidenceArg(argv) ? { reviewEvidence: reviewEvidenceArg(argv) } : {}),
    ...((command === 'review' || command === 'judge' || command === 'archive') ? { confirmHostModel: boundary !== null } : {}),
    ...((commandToRun === 'open' || commandToRun === 'build') ? { allowOwnershipConflicts: argv.includes('--allow-ownership-conflicts') } : {}),
    ...(waivers ? { waivers } : {}),
    ...((commandToRun === 'open' || commandToRun === 'build') && ownedPaths(argv).length ? { ownedPaths: ownedPaths(argv) } : {}),
    ...(workflowProfile ? { workflowProfile } : {}),
    ...(onProgress ? { onProgress, signal: abortController?.signal } : {}),
  });
  if (explicitChange && result.taskId !== change) {
    return { command, taskId: change, phase: 'intake', success: false, error: `Task ID mismatch: requested ${change} but result returned ${result.taskId}.` };
  }
  if (boundary && result.success) await consumeUserChoiceGate({ root, taskId: change, boundary });
  const nextBoundary = result.success
    ? result.phase === 'plan' ? 'implementation_gate'
      : result.phase === 'hardVerify' && command === 'verify' ? 'review_gate'
      : result.phase === 'review' && command === 'review' && argv.includes('--approve') ? 'judge_gate'
      : result.phase === 'judge' && command === 'judge' ? 'archive_gate'
      : null
    : null;
  if (nextBoundary) await createUserChoiceGate({ root, taskId: result.taskId, boundary: nextBoundary });
  if (result.success && workflowProfile?.isolationMode === 'git_flow') {
    const plan = inspectGitFlow(root, result.taskId, undefined, gitFlowBranchKindForCommand(command));
    workflowProfile = await updateGitFlowProfile(root, result.taskId, plan);
  }
  const upstream = await readUpstreamSummary(root, result.taskId).catch(() => null);
  const suggestion = workflowProfile ? null : upstream ? suggestCandidateAction(result.phase, upstream) : null;
  const gitFlowPending = workflowProfile?.gitFlow?.status === 'pending_confirmation';
  const gitFlowManualCommand = workflowProfile?.gitFlow?.installation?.status !== 'installed'
    ? workflowProfile?.gitFlow?.installation?.manualCommand
    : undefined;
  const phaseNextSkill = gitFlowPending ? '/kata' : nextSkillForPhase(result.phase);
  const nextAction = suggestion
    ? nextActionForTask(result.taskId, suggestion.nextSkill, suggestion.role, suggestion.reason)
    : null;
  const workflowNextAction = workflowProfile
    ? gitFlowPending
      ? {
          taskId: result.taskId,
          nextSkill: '/kata',
          slashCommand: '/kata',
          cliCommand: `kata git-flow apply --change ${result.taskId} --confirm`,
          role: 'implementer',
          reason: 'git_flow_confirmation_required',
          requiresUserConfirmation: true,
          ...(gitFlowManualCommand ? { pauseInstruction: `Git Flow 自动安装未完成；请先手动执行：${gitFlowManualCommand}` } : {}),
        }
      : nextActionForTask(result.taskId, phaseNextSkill, roleForPhase(result.phase), workflowNextReason(result.phase))
    : null;
  const completion = result.success
    ? workflowCompletion(result.phase, workflowNextAction ?? nextAction)
    : null;
  const effectiveAction = workflowNextAction ?? nextAction;
  const fromRole = roleForCompletedCommand(command);
  const toRole = effectiveAction ? handoffRole(effectiveAction.role) : null;
  const handoff = result.success && fromRole && toRole && fromRole !== toRole
    ? await createWorkflowHandoff({ root, taskId: result.taskId, fromRole, toRole })
    : null;
  const shouldAskUser = suggestion !== null || workflowNextAction?.requiresUserConfirmation === true;
  const active = result.success
    ? await activateHookTask({
        root,
        taskId: result.taskId,
        role: roleForPhase(result.phase),
        ...(platform ? { platform } : {}),
        origin: 'workflow',
      }).catch(() => null)
    : null;
  return {
    command: result.command,
    taskId: result.taskId,
    phase: result.phase,
    success: result.success,
    execution: {
      workspaceRoot: realpathSync(root),
      executable: process.argv[1] ?? process.execPath,
      runtimeVersion: process.version,
      inputPhase,
      outputPhase: result.phase,
      ...(upstream?.currentRevisionId ? { revisionId: upstream.currentRevisionId } : {}),
      handoffValidated: command === 'open' ? false : true,
    },
    phaseNextSkill,
    ...(completion ? { completion } : {}),
    ...(handoff ? {
      handoff: {
        id: handoff.packet.id,
        path: `.kata/tasks/${result.taskId}/handoffs/${handoff.packet.id}.json`,
        sha256: createPacketHash(handoff.packet),
        packet: handoff.packet,
        targetPrompt: handoff.prompt,
      },
    } : {}),
    ...(workflowProfile && workflowNextAction ? { workflowProfile, nextAction: workflowNextAction } : {}),
    ...(suggestion
      ? {
          nextSkill: suggestion.nextSkill,
          recommended: {
            taskId: result.taskId,
            nextSkill: suggestion.nextSkill,
            role: suggestion.role,
            reason: suggestion.reason,
            slashCommand: nextAction?.slashCommand,
            cliCommand: nextAction?.cliCommand,
          },
          nextAction,
        }
      : {}),
    ...(upstream ? { upstream } : {}),
    ...(shouldAskUser
      ? { askUser: statusActionPrompts(suggestion ?? { nextSkill: phaseNextSkill, role: roleForPhase(result.phase), reason: workflowNextReason(result.phase) }) }
      : {}),
    ...(active
      ? {
          activeTask: {
            taskId: active.taskId,
            role: active.role,
            phase: active.phase,
            ...(active.platform ? { platform: active.platform } : {}),
            ...(active.branch ? { branch: active.branch } : {}),
            ...(active.origin ? { origin: active.origin } : {}),
            active: true,
          },
        }
      : {}),
    ...(result.diagnostics ? { diagnostics: result.diagnostics } : {}),
    ...(result.error ? { error: result.error } : {}),
  };
}

async function readWorkflowPhase(root: string, taskId: string): Promise<string | null> {
  try {
    const state = JSON.parse(await readFile(join(root, '.kata/tasks', taskId, 'current-state.json'), 'utf8')) as { phase?: unknown };
    return typeof state.phase === 'string' ? state.phase : null;
  } catch {
    return null;
  }
}

function roleForCommand(command: KataCommand): HandoffRole {
  if (command === 'review' || command === 'verify') return 'reviewer';
  if (command === 'judge') return 'judge';
  if (command === 'archive') return 'distiller';
  return 'implementer';
}

function boundaryForCommand(command: KataCommand, phase: string | null): UserChoiceBoundary | null {
  if (command === 'build' && phase === 'plan') return 'implementation_gate';
  if (command === 'review' && phase === 'hardVerify') return 'review_gate';
  if (command === 'judge' && phase === 'review') return 'judge_gate';
  if (command === 'archive' && (phase === 'judge' || phase === 'distill')) return 'archive_gate';
  return null;
}

async function runGateCommand(argv: string[], root: string): Promise<Record<string, unknown>> {
  if (argv[0] !== 'approve') throw new Error('Usage: kata gate approve --task <id> --boundary <implementation_gate|review_gate|judge_gate|archive_gate> --choice <continue_current|switched|delegated>');
  const task = valueAfter(argv, '--task');
  const boundary = valueAfter(argv, '--boundary') as UserChoiceBoundary | undefined;
  const choice = valueAfter(argv, '--choice') as 'continue_current' | 'switched' | 'delegated' | undefined;
  if (!task || !boundary || !choice) throw new Error('kata gate approve requires --task, --boundary, and --choice');
  await approveUserChoiceGate({ root, taskId: task, boundary, choice });
  return { command: 'gate approve', taskId: task, boundary, choice, approved: true };
}

function valueAfter(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
}

async function requireWorkflowReceipt(root: string, taskId: string, role: HandoffRole): Promise<void> {
  const handoffDirectory = join(root, '.kata/tasks', taskId, 'handoffs');
  let entries: string[];
  try {
    entries = await readdir(handoffDirectory);
  } catch {
    throw new Error(`Workflow mutation requires a current acknowledged handoff receipt for ${role}.`);
  }
  const ids = entries
    .filter((entry) => entry.startsWith('handoff-') && entry.endsWith('.receipt.json'))
    .map((entry) => entry.slice(0, -'.receipt.json'.length))
    .sort()
    .reverse();
  for (const id of ids) {
    try {
      await requireAcknowledgedContextPacket({ root, taskId, id, role });
      return;
    } catch {
      // An older or stale receipt cannot authorize this command; try only
      // another receipt for the same task before rejecting the mutation.
    }
  }
  throw new Error(`Workflow mutation requires a current acknowledged handoff receipt for ${role}.`);
}

function reviewEvidenceArg(argv: string[]): string | undefined {
  const index = argv.indexOf('--review-evidence');
  const value = index >= 0 ? argv[index + 1] : undefined;
  return value?.trim() || undefined;
}

type WorkflowHandoffRole = 'designer' | 'implementer' | 'reviewer' | 'judge' | 'distiller';

function roleForCompletedCommand(command: KataCommand): WorkflowHandoffRole | null {
  if (command === 'design') return 'designer';
  if (command === 'build') return 'implementer';
  if (command === 'verify' || command === 'review') return 'reviewer';
  if (command === 'judge') return 'judge';
  if (command === 'archive') return 'distiller';
  return null;
}

function handoffRole(role: string): WorkflowHandoffRole | null {
  return ['designer', 'implementer', 'reviewer', 'judge', 'distiller'].includes(role)
    ? role as WorkflowHandoffRole
    : null;
}

function workflowCompletion(
  phase: Phase,
  nextAction: {
    slashCommand: string;
    cliCommand: string;
    requiresUserConfirmation?: boolean;
    pauseInstruction?: string;
  } | null,
): Record<string, unknown> | null {
  if (!nextAction) return null;
  const archiveNote = phase === 'archive' ? '\n归档已完成。建议使用 git 提交本轮工作流涉及的所有更改，并推送到远端。' : '';
  return {
    phase,
    nextAction,
    userMessage: [
      `当前阶段：${phase}。`,
      `下一步：${nextAction.slashCommand}`,
      `CLI 备用：${nextAction.cliCommand}`,
      ...(nextAction.requiresUserConfirmation && nextAction.pauseInstruction ? [nextAction.pauseInstruction] : []),
      ...(archiveNote ? [archiveNote] : []),
    ].join('\n'),
  };
}

function workflowNextReason(phase: Phase): string {
  if (phase === 'intake') return 'design_intake_task';
  if (phase === 'plan') return 'choose_execution_mode';
  return 'continue_workflow';
}

function ownedPaths(argv: string[]): string[] {
  return argv.flatMap((value, index) => value === '--owned-path' && argv[index + 1] ? [argv[index + 1]!] : []);
}

async function readWaiversFile(argv: string[]): Promise<Waiver[] | undefined> {
  const index = argv.indexOf('--waivers-file');
  if (index === -1) return undefined;
  const path = argv[index + 1];
  if (!path) throw new Error('Invalid waivers file: --waivers-file requires a path.');

  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid waivers file: ${detail}`);
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as { waivers?: unknown }).waivers)) {
    throw new Error('Invalid waivers file: expected an object with a waivers array.');
  }
  const waivers = (parsed as { waivers: Waiver[] }).waivers;
  const errors = validateWaivers(waivers);
  if (errors.length > 0) throw new Error(`Invalid waivers file: ${errors.join('; ')}`);
  return waivers;
}

async function runGitFlowCommand(argv: string[], root: string): Promise<Record<string, unknown>> {
  if (argv[0] !== 'apply') throw new Error('Usage: kata git-flow apply --change <task-id>');
  const taskId = parseChangeArg(argv.slice(1));
  if (!taskId) throw new Error('Usage: kata git-flow apply --change <task-id>');
  const task = JSON.parse(await readFile(join(root, '.kata/tasks', taskId, 'task.json'), 'utf8')) as { workflowProfile?: unknown };
  if (!isWorkflowProfile(task.workflowProfile) || task.workflowProfile.isolationMode !== 'git_flow') {
    throw new Error(`Task ${taskId} does not use Git Flow isolation`);
  }
  const inspected = inspectGitFlow(root, taskId, undefined, gitFlowBranchKindForProfile(task.workflowProfile));
  if (inspected.status === 'pending_confirmation' && !argv.includes('--confirm')) {
    return {
      command: 'git-flow apply', taskId, workflowProfile: task.workflowProfile,
      nextAction: {
        slashCommand: '/kata',
        cliCommand: `kata git-flow apply --change ${taskId} --confirm`,
        reason: 'git_flow_confirmation_required',
        requiresUserConfirmation: true,
      },
    };
  }
  const state = inspected.status === 'pending_confirmation' ? applyGitFlowPlan(root, inspected) : inspected;
  const workflowProfile = await updateGitFlowProfile(root, taskId, state);
  return {
    command: 'git-flow apply', taskId, workflowProfile,
    nextAction: state.status === 'active'
      ? { slashCommand: `/kata-design ${taskId}`, cliCommand: `kata design --change ${taskId}` }
      : { cliCommand: `kata git-flow apply --change ${taskId} --confirm`, reason: (inspected as GitFlowPlan).reason ?? 'git_flow_setup_failed' },
  };
}

function gitFlowBranchKindForCommand(command: KataCommand): GitFlowBranchKind {
  return command === 'hotfix' ? 'hotfix' : 'feature';
}

function gitFlowBranchKindForProfile(profile: WorkflowProfile): GitFlowBranchKind {
  return profile.gitFlow?.branch.startsWith('hotfix/') ? 'hotfix' : 'feature';
}

function requiresWorkflowProfile(command: KataCommand): command is 'open' | 'hotfix' | 'tweak' {
  return command === 'open' || command === 'hotfix' || command === 'tweak';
}

async function resolveWorkflowProfile(command: 'open' | 'hotfix' | 'tweak', argv: string[] = []): Promise<WorkflowProfile> {
  const explicit = parseWorkflowProfileArgs(argv);
  if (!explicit.isolationMode || !explicit.developmentMode || !explicit.reviewMode) {
    throw new Error(`kata ${command} requires explicit --isolation, --development, and --review choices; use /kata-${command} to collect user confirmation first.`);
  }
  return {
    ...defaultWorkflowProfile(),
    isolationMode: explicit.isolationMode,
    developmentMode: explicit.developmentMode,
    reviewMode: explicit.reviewMode,
  };
}

function parseWorkflowProfileArgs(argv: string[]): Partial<Pick<WorkflowProfile, 'isolationMode' | 'developmentMode' | 'reviewMode'>> {
  return {
    isolationMode: parseEnumArg(argv, ['--isolation', '--isolation-mode'], isolationModes, 'isolation mode'),
    developmentMode: parseEnumArg(argv, ['--development', '--development-mode'], developmentModes, 'development mode'),
    reviewMode: parseEnumArg(argv, ['--review', '--review-mode'], reviewModes, 'review mode'),
  };
}

function parseEnumArg<const T extends readonly string[]>(
  argv: string[],
  flags: readonly string[],
  allowed: T,
  label: string,
): T[number] | undefined {
  const flag = flags.find((candidate) => argv.includes(candidate));
  if (!flag) return undefined;
  const value = argv[argv.indexOf(flag) + 1];
  if (!value) throw new Error(`Missing ${label} after ${flag}`);
  if (!(allowed as readonly string[]).includes(value)) {
    throw new Error(`Invalid ${label}: ${value}. Expected one of: ${allowed.join(', ')}`);
  }
  return value as T[number];
}

export function roleForPhase(phase: Phase | string): string {
  if (phase === 'intake') return 'designer';
  if (phase === 'plan' || phase === 'implement') return 'implementer';
  if (phase === 'hardVerify') return 'reviewer';
  if (phase === 'review') return 'reviewer';
  if (phase === 'judge') return 'judge';
  if (phase === 'distill') return 'distiller';
  return 'dispatcher';
}

type ResolvedTask = {
  taskId: string;
  source: 'active' | 'discovered';
  branch?: string;
  platform?: string;
  role?: string;
  origin?: ActiveHookTask['origin'];
};

async function resolveTaskForCurrentBranch(root: string): Promise<ResolvedTask | null> {
  const active = await resolveActiveTaskForCurrentBranch(root);
  if (active) {
    return {
      taskId: active.taskId,
      source: 'active',
      ...(active.branch ? { branch: active.branch } : {}),
      ...(active.platform ? { platform: active.platform } : {}),
      ...(active.role ? { role: active.role } : {}),
      ...(active.origin ? { origin: active.origin } : {}),
    };
  }
  return discoverSingleTaskForCurrentBranch(root);
}

async function resolveActiveTaskForCurrentBranch(root: string): Promise<ActiveHookTask | null> {
  const active = await readActiveHookTask(root);
  if (!active) return null;
  const branch = currentGitBranch(root);
  if (active.branch && branch && active.branch !== branch) {
    throw new Error(`Active task belongs to branch ${active.branch}; current branch is ${branch}. Pass --change explicitly or activate a task on this branch.`);
  }
  return active;
}

async function discoverSingleTaskForCurrentBranch(root: string): Promise<ResolvedTask | null> {
  const branch = currentGitBranch(root);
  if (!branch) return null;
  let taskIds: string[];
  try {
    taskIds = await readdir(join(root, '.kata/tasks'));
  } catch {
    return null;
  }
  const matches: string[] = [];
  for (const taskId of taskIds) {
    try {
      const task = JSON.parse(await readFile(join(root, '.kata/tasks', taskId, 'task.json'), 'utf8')) as {
        id?: string;
        branch?: string;
        phase?: Phase;
      };
      if (task.branch === branch && task.phase !== 'archive') matches.push(task.id ?? taskId);
    } catch {
      // Ignore partial/non-task directories; they should not block explicit --change usage.
    }
  }
  if (matches.length !== 1) return null;
  return { taskId: matches[0]!, source: 'discovered', branch };
}

async function runLocalStatusCommand(change: string, resolved?: ResolvedTask | null, root = resolveWorkspaceRoot()): Promise<Record<string, unknown>> {
  const terminal = await resolveTerminalTask(root, change);
  if (terminal.taskId !== change) {
    const targetStatus = await runLocalStatusCommand(terminal.taskId, resolved, root);
    return {
      ...targetStatus,
      command: 'status',
      redirectedFrom: change,
      relationRedirects: terminal.redirects,
      askUser: [
        `任务 ${change} 已通过 ${terminal.redirects[0]?.type ?? 'relation'} 指向 ${terminal.taskId}；请继续处理 ${terminal.taskId}。`,
      ],
    };
  }
  // Status is the cross-platform resume entrypoint. Rebuild the mutable
  // projection from the append-only legal event chain before reporting it.
  if (await requiresRecovery(change, { root }).catch(() => false)) await recover(change, { root });
  const state = JSON.parse(await readFile(join(root, '.kata/tasks', change, 'current-state.json'), 'utf8')) as {
    phase: Phase;
    updatedAt?: string;
    actor?: unknown;
    activeSession?: string;
  };
  const autoActive = resolved?.source === 'discovered'
    ? await activateHookTask({
        root,
        taskId: change,
        role: roleForPhase(state.phase),
        ...(resolved.platform ? { platform: resolved.platform } : {}),
        origin: 'discovered',
      }).catch(() => null)
    : null;
  const effectiveResolved: ResolvedTask | null | undefined = autoActive
    ? {
        taskId: autoActive.taskId,
        source: 'active',
        ...(autoActive.branch ? { branch: autoActive.branch } : {}),
        ...(autoActive.platform ? { platform: autoActive.platform } : {}),
        role: autoActive.role,
        ...(autoActive.origin ? { origin: autoActive.origin } : {}),
      }
    : resolved;
  const taskContext = await readTaskContext(root, change);
  const upstream = await readUpstreamSummary(root, change);
  const suggestion = suggestCandidateAction(state.phase, upstream);
  const phaseNextSkill = nextSkillForPhase(state.phase);
  const nextAction = nextActionForTask(change, suggestion.nextSkill, suggestion.role, suggestion.reason);
  const hasArtifactOverride = suggestion.nextSkill !== phaseNextSkill || suggestion.reason.startsWith('repair_');
  const shouldAskUser = hasArtifactOverride || nextAction.requiresUserConfirmation;
  return {
    command: 'status',
    taskId: change,
    phase: state.phase,
    nextSkill: suggestion.nextSkill,
    phaseNextSkill,
    recommended: {
      taskId: change,
      nextSkill: suggestion.nextSkill,
      role: suggestion.role,
      reason: suggestion.reason,
      slashCommand: nextAction.slashCommand,
      cliCommand: nextAction.cliCommand,
    },
    nextAction,
    upstream,
    ...(shouldAskUser
      ? {
          ...(hasArtifactOverride ? { artifactOverride: true } : {}),
          askUser: statusActionPrompts(suggestion),
        }
      : {}),
    ...(effectiveResolved?.source === 'active' && effectiveResolved.taskId === change ? { active: true } : {}),
    ...(effectiveResolved?.source === 'discovered' && effectiveResolved.taskId === change ? { discovered: true } : {}),
    ...(effectiveResolved?.source === 'active' && effectiveResolved.origin === 'discovered' ? { discovered: true } : {}),
    ...(autoActive ? { discovered: true, autoActivated: true } : {}),
    ...(effectiveResolved?.branch ? { branch: effectiveResolved.branch } : {}),
    ...(effectiveResolved?.platform ? { platform: effectiveResolved.platform } : {}),
    ...(effectiveResolved?.role ? { activeRole: effectiveResolved.role } : {}),
    ...(state.updatedAt ? { updatedAt: state.updatedAt } : {}),
    ...(state.actor ? { actor: state.actor } : {}),
    ...(state.activeSession ? { activeSession: state.activeSession } : {}),
    task: taskContext.task,
    state,
    requiredReads: taskContext.requiredReads,
    context: taskContext.context,
  };
}

async function runDispatchStatusCommand(root: string): Promise<Record<string, unknown>> {
  const candidates = await listTaskCandidates(root);
  if (candidates.length === 1) {
    const active = await activateHookTask({
      root,
      taskId: candidates[0]!.taskId,
      role: candidates[0]!.suggestedRole,
      origin: 'discovered',
    }).catch(() => null);
    return {
      ...(await runLocalStatusCommand(candidates[0]!.taskId, active
        ? {
            taskId: active.taskId,
            source: 'active',
            ...(active.branch ? { branch: active.branch } : {}),
            ...(active.platform ? { platform: active.platform } : {}),
            role: active.role,
            ...(active.origin ? { origin: active.origin } : {}),
          }
        : { taskId: candidates[0]!.taskId, source: 'discovered', ...(candidates[0]!.branch ? { branch: candidates[0]!.branch } : {}) }, root)),
      autoDispatched: true,
      ...(active ? { autoActivated: true } : {}),
    };
  }
  return statusDiagnostic(candidates);
}

async function readTaskContext(root: string, change: string): Promise<{
  task: { title: string; acceptance: Array<{ id?: string; statement: string }> };
  requiredReads: string[];
  context: Record<string, unknown>;
}> {
  const taskRaw = await readFile(join(root, '.kata/tasks', change, 'task.json'), 'utf8');
  const task = JSON.parse(taskRaw) as { title: string; acceptance: Array<{ id?: string; statement: string }> };
  let context: Awaited<ReturnType<typeof buildContextManifest>>;
  try {
    context = await buildContextManifest({ root, taskId: change, sourceRefs: [] });
  } catch {
    context = { taskId: change, sourceRefs: [], authoritativeWiki: [], excludedWiki: [], warnings: [] };
  }
  return {
    task: {
      title: task.title,
      acceptance: task.acceptance,
    },
    requiredReads: [
      'AGENTS.md',
      '.kata/skills-index.md',
      '.llmwiki/SCHEMA.md',
      '.llmwiki/index.md',
      '.llmwiki/log.md',
      `.kata/tasks/${change}/task.json`,
      `.kata/tasks/${change}/current-state.json`,
    ],
    context: {
      authoritativeWikiCount: context.authoritativeWiki.length,
      excludedWikiCount: context.excludedWiki.length,
      sourceRefs: context.sourceRefs,
      warnings: context.warnings,
    },
  };
}

async function runWikiCommand(argv: string[]): Promise<Record<string, unknown>> {
  const [subcommand, ...rest] = argv;
  if (!subcommand || subcommand === '--help' || subcommand === '-h') {
    return {
      command: 'wiki help',
      commands: ['init --from <path>', 'orient', 'ingest --from <path>', 'query --q <question>', 'lint', 'verify', 'task --kind enrich', 'register', 'candidate', 'closure --task <task-id> --decision <captured|not_applicable|deferred> --reason <text>', 'audit', 'lifecycle', 'refresh --task <task-id>', 'relevance --task <task-id>', 'promote <wiki-id> --by <actor> --role <role>', 'reject <wiki-id> --by <actor> --role <role> --reason <reason>', 'retire <wiki-id> --by <actor> --role <role> --reason <reason>'],
      aliases: { propose: 'task --kind enrich' },
      examples: ['kata wiki task --kind enrich --from docs', 'kata wiki propose --task <task-id> --from docs', 'kata wiki candidate'],
    };
  }
  const args = subcommand === 'promote' || subcommand === 'reject' || subcommand === 'retire' ? parseWikiArgs(rest.slice(1)) : parseWikiArgs(rest);
  if (subcommand === 'init') {
    if (!args.from) throw new Error('Usage: kata wiki init --from <path> [--wiki <path>] [--root <path>]');
    const result = await initLlmWiki({ root: args.root, wikiPath: args.wikiPath, from: args.from });
    return {
      command: 'wiki init',
      wikiPath: result.wikiPath,
      importedCount: result.importedSources.length,
      importedSources: result.importedSources,
    };
  }
  if (subcommand === 'orient') {
    const result = await orientLlmWiki({ root: args.root, wikiPath: args.wikiPath });
    return {
      command: 'wiki orient',
      wikiPath: result.wikiPath,
      schemaBytes: result.schema.length,
      indexBytes: result.index.length,
      recentLog: result.recentLog,
    };
  }
  if (subcommand === 'ingest') {
    if (!args.from) throw new Error('Usage: kata wiki ingest --from <path> [--wiki <path>] [--root <path>]');
    const result = await ingestLlmWiki({ root: args.root, wikiPath: args.wikiPath, from: args.from });
    return {
      command: 'wiki ingest',
      wikiPath: result.wikiPath,
      importedCount: result.importedSources.length,
      importedSources: result.importedSources,
      pagesWritten: result.pagesWritten,
      governedRecords: result.governedRecords,
    };
  }
  if (subcommand === 'query') {
    if (!args.query) throw new Error('Usage: kata wiki query --q <question> [--file] [--wiki <path>] [--root <path>]');
    const result = await queryLlmWiki({ root: args.root, wikiPath: args.wikiPath, query: args.query, file: args.file });
    return {
      command: 'wiki query',
      wikiPath: result.wikiPath,
      answer: result.answer,
      citations: result.citations,
      ...(result.filedPath ? { filedPath: result.filedPath } : {}),
    };
  }
  if (subcommand === 'lint') {
    const result = await lintLlmWiki({ root: args.root, wikiPath: args.wikiPath });
    return {
      command: 'wiki lint',
      wikiPath: result.wikiPath,
      ok: result.ok,
      issues: result.issues,
    };
  }
  if (subcommand === 'task') {
    if (args.kind !== 'bootstrap' && args.kind !== 'enrich' && args.kind !== 'distill') {
      throw new Error('Usage: kata wiki task --kind <bootstrap|enrich|distill> [--from <path>] [--wiki <path>] [--root <path>]');
    }
    return { ...(await buildLlmWikiTask({ root: args.root, wikiPath: args.wikiPath, kind: args.kind, from: args.from })) };
  }
  if (subcommand === 'propose') {
    const packet = await buildLlmWikiTask({ root: args.root, wikiPath: args.wikiPath, kind: 'enrich', from: args.from });
    return { ...packet, ...(args.task ? { sourceTask: args.task } : {}), alias: 'wiki propose' };
  }
  if (subcommand === 'candidate') {
    const root = args.root ?? resolveWorkspaceRoot();
    const candidates = (await readWikiRecords(root)).filter((record) => record.status === 'candidate');
    return { command: 'wiki candidate', candidates };
  }
  if (subcommand === 'closure') {
    if (!args.task || !args.decision || !args.reason || !['captured', 'not_applicable', 'deferred'].includes(args.decision)) {
      throw new Error('Usage: kata wiki closure --task <task-id> --decision <captured|not_applicable|deferred> --reason <text> [--candidate <wiki-id>]');
    }
    const root = args.root ?? resolveWorkspaceRoot();
    const closure = await writeWikiClosure(root, args.task, { decision: args.decision as 'captured' | 'not_applicable' | 'deferred', reason: args.reason, candidateIds: args.candidates });
    const evaluation = await evaluateWikiClosure(root, args.task);
    const lint = closure.decision === 'captured' ? await lintLlmWiki({ root, wikiPath: args.wikiPath }) : null;
    const sources = closure.decision === 'captured' ? await verifySources(root) : null;
    return { command: 'wiki closure', closure, evaluation, ...(lint ? { lint } : {}), ...(sources ? { sources } : {}) };
  }
  if (subcommand === 'audit') return { command: 'wiki audit', ...(await auditWiki(args.root ?? resolveWorkspaceRoot())) };
  if (subcommand === 'lifecycle') return { command: 'wiki lifecycle', ...(await auditWiki(args.root ?? resolveWorkspaceRoot())) };
  if (subcommand === 'refresh') {
    if (!args.task) throw new Error('Usage: kata wiki refresh --task <task-id> [--root <path>]');
    return { command: 'wiki refresh', ...(await createRefreshPacket(args.root ?? resolveWorkspaceRoot(), args.task)) };
  }
  if (subcommand === 'relevance') {
    if (!args.task) throw new Error('Usage: kata wiki relevance --task <task-id> [--root <path>]');
    return { command: 'wiki relevance', taskId: args.task, records: await relevantWiki(args.root ?? resolveWorkspaceRoot(), args.task) };
  }
  if (subcommand === 'verify') {
    const root = args.root ?? resolveWorkspaceRoot();
    const result = await verifySources(root);
    return {
      command: 'wiki verify',
      checked: result.checked,
      intact: result.intact,
      stale: result.stale,
      missing: result.missing,
    };
  }
  if (subcommand === 'register') {
    const result = await registerWikiPages({ root: args.root, wikiPath: args.wikiPath });
    return result as unknown as Record<string, unknown>;
  }
  if (subcommand === 'rebuild') {
    const confirmed = args.force ?? await confirmDestructive(
      'This will remove all existing wiki pages and governed records, then regenerate the enrich task-packet.',
      ['Concepts, entities, comparisons, and queries will be deleted.', 'Governed candidate records in .kata/wiki/ will be deleted.'],
    );
    if (!confirmed) {
      return { command: 'wiki rebuild', aborted: true };
    }
    const result = await rebuildLlmWiki({ root: args.root, wikiPath: args.wikiPath });
    return result as unknown as Record<string, unknown>;
  }
  if (subcommand === 'promote') {
    const id = rest[0];
    if (!id || id.startsWith('--') || !args.by || !args.role) {
      throw new Error('Usage: kata wiki promote <wiki-id> --by <actor> --role <role> [--root <path>]');
    }
    const approvedAt = new Date().toISOString();
    const record = await promote(args.root ?? resolveWorkspaceRoot(), id, { approvedBy: args.by, role: args.role, approvedAt });
    return {
      command: 'wiki promote',
      id: record.id,
      status: record.status,
      approvedBy: args.by,
      role: args.role,
      approvedAt,
    };
  }
  if (subcommand === 'reject') {
    const id = rest[0];
    if (!id || id.startsWith('--') || !args.by || !args.role || !args.reason) {
      throw new Error('Usage: kata wiki reject <wiki-id> --by <actor> --role <role> --reason <reason> [--root <path>]');
    }
    const rejectedAt = new Date().toISOString();
    const record = await rejectCandidate(args.root ?? resolveWorkspaceRoot(), id, {
      rejectedBy: args.by,
      role: args.role,
      rejectedAt,
      reason: args.reason,
    });
    return {
      command: 'wiki reject',
      id: record.id,
      status: record.status,
      rejectedBy: args.by,
      role: args.role,
      rejectedAt,
      reason: args.reason,
    };
  }
  if (subcommand === 'retire') {
    const id = rest[0];
    if (!id || id.startsWith('--') || !args.by || !args.role || !args.reason) {
      throw new Error('Usage: kata wiki retire <wiki-id> --by <actor> --role <role> --reason <reason> [--root <path>]');
    }
    const rejectedAt = new Date().toISOString();
    const record = await retireWikiRecord(args.root ?? resolveWorkspaceRoot(), id, {
      rejectedBy: args.by,
      role: args.role,
      rejectedAt,
      reason: args.reason,
    });
    return {
      command: 'wiki retire',
      id: record.id,
      status: record.status,
      rejectedBy: args.by,
      role: args.role,
      rejectedAt,
      reason: record.rejectionEvent?.reason ?? args.reason,
    };
  }
  throw new Error(`Unknown wiki command: ${subcommand ?? ''}`);
}

async function runTasksCommand(argv: string[]): Promise<Record<string, unknown>> {
  const [subcommand, ...rest] = argv;
  const args = parseTasksArgs(rest);
  const root = args.root ?? resolveWorkspaceRoot();
  if (subcommand === 'relate') {
    if (!args.from || !args.to || !args.type) {
      throw new Error('Usage: kata tasks relate --from <task> --to <task> --type <superseded_by|covered_by|duplicate_of|merged_into|parent_of|spawned_from|related_to> [--reason <text>] [--root <path>]');
    }
    const record = await addTaskRelation({
      root,
      fromTaskId: args.from,
      toTaskId: args.to,
      type: parseTaskRelationType(args.type),
      ...(args.reason ? { reason: args.reason } : {}),
      createdBy: 'kata-cli',
    });
    const terminal = await resolveTerminalTask(root, args.from);
    return {
      command: 'tasks relate',
      fromTaskId: args.from,
      toTaskId: args.to,
      type: args.type,
      relationPath: `.kata/tasks/${args.from}/task-relations.json`,
      relations: record.relations,
      ...(terminal.taskId !== args.from ? { redirectsTo: terminal.taskId, relationRedirects: terminal.redirects } : {}),
      nextAction: {
        slashCommand: `/kata ${terminal.taskId}`,
        cliCommand: `kata status --change ${terminal.taskId}`,
      },
    };
  }
  if (subcommand === 'relations' || subcommand === 'show') {
    if (!args.task && !args.from) throw new Error('Usage: kata tasks relations --task <task> [--root <path>]');
    const taskId = args.task ?? args.from!;
    const record = await readTaskRelations(root, taskId);
    const terminal = await resolveTerminalTask(root, taskId);
    return {
      command: 'tasks relations',
      taskId,
      relations: record.relations,
      ...(terminal.taskId !== taskId ? { redirectsTo: terminal.taskId, relationRedirects: terminal.redirects } : {}),
    };
  }
  throw new Error(`Unknown tasks command: ${subcommand ?? ''}`);
}

async function runRelationsCommand(argv: string[]): Promise<Record<string, unknown>> {
  const [subcommand, ...rest] = argv;
  const args = parseRelationsArgs(rest);
  const root = args.root ?? resolveWorkspaceRoot();
  if (subcommand === 'add' || subcommand === 'relate') {
    if (!args.from || !args.to || !args.type) {
      throw new Error('Usage: kata relations add --from <task:id|change:id> --to <task:id|change:id> --type <relation> [--reason <text>] [--root <path>]');
    }
    const from = parseRelationEndpoint(args.from);
    const to = parseRelationEndpoint(args.to);
    const graph = await addKataRelation({
      root,
      from,
      to,
      type: parseTaskRelationType(args.type),
      ...(args.reason ? { reason: args.reason } : {}),
      createdBy: 'kata-cli',
    });
    return {
      command: 'relations add',
      from,
      to,
      type: args.type,
      graphPath: '.kata/relations.json',
      relation: graph.relations.at(-1) ?? null,
    };
  }
  if (subcommand === 'show' || subcommand === 'list') {
    if (!args.id) throw new Error('Usage: kata relations show --id <task:id|change:id> [--root <path>]');
    const endpoint = parseRelationEndpoint(args.id);
    return {
      command: 'relations show',
      ...(await findKataRelations(root, endpoint)),
    };
  }
  throw new Error(`Unknown relations command: ${subcommand ?? ''}`);
}

async function runHandoffCommand(argv: string[]): Promise<Record<string, unknown>> {
  const [subcommand, ...rest] = argv;
  const args = parseHandoffArgs(rest);
  const root = args.root ?? (args.task ? resolveWorkspaceRootForTask(args.task) : resolveWorkspaceRoot());
  if (!args.task) throw new Error('Usage: kata handoff <create|show|verify|acknowledge> --task <id>');
  if (subcommand === 'create') {
    if (!args.from || !args.to) throw new Error('Usage: kata handoff create --task <id> --from <role> --to <role>');
    const packet = await createContextPacket({ root, taskId: args.task, fromRole: args.from as HandoffRole, toRole: args.to as HandoffRole, ...(args.platform ? { platform: args.platform } : {}) });
    return { command: 'handoff create', taskId: args.task, id: packet.id, path: `.kata/tasks/${args.task}/handoffs/${packet.id}.json`, sha256: createPacketHash(packet), packet };
  }
  if (!args.id) throw new Error('Usage: kata handoff <show|verify|acknowledge> --task <id> --id <handoff-id>');
  if (subcommand === 'show') return { command: 'handoff show', packet: await readContextPacket(root, args.task, args.id) };
  if (subcommand === 'verify') return { command: 'handoff verify', ...(await verifyContextPacket({ root, taskId: args.task, id: args.id })) };
  if (subcommand === 'acknowledge') {
    if (!args.platform || !args.role) throw new Error('Usage: kata handoff acknowledge --task <id> --id <handoff-id> --platform <name> --role <role>');
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
      ...(active ? { activeTask: {
        taskId: active.taskId,
        role: active.role,
        phase: active.phase,
        ...(active.platform ? { platform: active.platform } : {}),
        ...(active.branch ? { branch: active.branch } : {}),
        ...(active.origin ? { origin: active.origin } : {}),
        active: true,
      } } : {}),
    };
  }
  throw new Error(`Unknown handoff command: ${subcommand ?? ''}`);
}

function createPacketHash(packet: unknown): string { return createHash('sha256').update(JSON.stringify(packet)).digest('hex'); }

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

type TaskCandidate = {
  taskId: string;
  title: string;
  phase: string;
  nextSkill: string;
  branch?: string;
  suggestedRole: string;
  suggestedReason: string;
  priority: number;
  upstream: UpstreamSummary;
};

async function listTaskCandidates(root: string): Promise<TaskCandidate[]> {
  const tasksRoot = join(root, '.kata/tasks');
  let entries: string[];
  try {
    entries = await readdir(tasksRoot);
  } catch {
    return [];
  }
  const branch = currentGitBranch(root) ?? undefined;
  const candidates = [];
  for (const entry of entries.sort()) {
    const candidate = await readTaskCandidate(root, entry).catch(() => null);
    if (!candidate) continue;
    if (branch && candidate.branch && candidate.branch !== branch) continue;
    candidates.push(candidate);
  }
  return candidates.sort((a, b) => b.priority - a.priority || a.taskId.localeCompare(b.taskId));
}

async function readTaskCandidate(root: string, taskId: string): Promise<TaskCandidate> {
  const task = JSON.parse(await readFile(join(root, '.kata/tasks', taskId, 'task.json'), 'utf8')) as { title?: string; branch?: string };
  const terminal = await resolveTerminalTask(root, taskId);
  if (terminal.taskId !== taskId) {
    throw new Error(`Task ${taskId} is redirected to ${terminal.taskId}`);
  }
  const state = JSON.parse(await readFile(join(root, '.kata/tasks', taskId, 'current-state.json'), 'utf8')) as { phase?: Phase };
  const phase = state.phase ?? 'intake';
  const upstream = await readUpstreamSummary(root, taskId);
  const suggestion = suggestCandidateAction(phase, upstream);
  return {
    taskId,
    title: task.title ?? taskId,
    phase,
    nextSkill: suggestion.nextSkill,
    suggestedRole: suggestion.role,
    suggestedReason: suggestion.reason,
    priority: suggestion.priority,
    upstream,
    ...(task.branch ? { branch: task.branch } : {}),
  };
}

function recommendNextTask(candidates: TaskCandidate[]): TaskCandidate | undefined {
  return candidates.find((task) => task.phase !== 'archive') ?? candidates[0];
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
    ? ['opencode', 'codex', 'claude-code', 'github-copilot']
    : ['codex', 'claude-code', 'github-copilot', 'opencode'];
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

async function runOrientCommand(argv: string[]): Promise<Record<string, unknown>> {
  const args = parseOrientArgs(argv);
  const root = args.root ?? resolveWorkspaceRoot();
  const resolved = args.change ? null : await resolveTaskForCurrentBranch(root);
  let change = args.change ?? resolved?.taskId;
  if (!change) {
    throw new Error('Usage: kata orient [--change <id>] [--root <path>] [--role <role>] [--platform <name>] [--task-kind <kind>] [--mode <mode>] [--failures <n>]');
  }
  const terminal = await resolveTerminalTask(root, change);
  const relationRedirects = terminal.taskId !== change ? terminal.redirects : [];
  change = terminal.taskId;
  const role = (args.role ?? 'implementer') as HandoffRole;
  const handoff = await createHandoff(root, change, role);
  const contextPacket = await createContextPacket({ root, taskId: change, fromRole: role, toRole: role, ...(args.platform ? { platform: args.platform } : {}) });
  const taskContext = await readTaskContext(root, change);
  const state = JSON.parse(await readFile(join(root, '.kata/tasks', change, 'current-state.json'), 'utf8')) as Record<string, unknown>;
  const phase = (typeof state.phase === 'string' ? state.phase : handoff.fromPhase) as Phase;
  const upstream = await readUpstreamSummary(root, change);
  const suggestion = suggestCandidateAction(phase, upstream);
  const phaseNextSkill = nextSkillForPhase(phase);
  const nextAction = nextActionForTask(change, suggestion.nextSkill, suggestion.role, suggestion.reason);
  const hasArtifactOverride = suggestion.nextSkill !== phaseNextSkill || suggestion.reason.startsWith('repair_');
  const shouldAskUser = hasArtifactOverride || nextAction.requiresUserConfirmation;

  return {
    command: 'orient',
    taskId: change,
    ...(relationRedirects.length > 0 ? { redirectedFrom: relationRedirects[0]?.fromTaskId, relationRedirects } : {}),
    phase: handoff.fromPhase,
    role,
    ...(args.platform ? { platform: args.platform } : {}),
    ...(resolved?.source === 'active' && resolved.taskId === change ? { active: true } : {}),
    ...(resolved?.source === 'discovered' && resolved.taskId === change ? { discovered: true } : {}),
    ...(resolved?.source === 'active' && resolved.origin === 'discovered' ? { discovered: true } : {}),
    ...(resolved?.branch ? { branch: resolved.branch } : {}),
    ...(resolved?.origin ? { origin: resolved.origin } : {}),
    ...(args.taskKind ? { taskKind: args.taskKind } : {}),
    nextSkill: suggestion.nextSkill,
    phaseNextSkill,
    recommended: {
      taskId: change,
      nextSkill: suggestion.nextSkill,
      role: suggestion.role,
      reason: suggestion.reason,
      slashCommand: nextAction.slashCommand,
      cliCommand: nextAction.cliCommand,
    },
    nextAction,
    upstream,
    ...(shouldAskUser
      ? {
          ...(hasArtifactOverride ? { artifactOverride: true } : {}),
          askUser: statusActionPrompts(suggestion),
        }
      : {}),
    task: taskContext.task,
    state,
    requiredReads: taskContext.requiredReads,
    context: taskContext.context,
    guardInstructions: handoff.guardInstructions,
    handoff: { id: contextPacket.id, path: `.kata/tasks/${change}/handoffs/${contextPacket.id}.json`, sha256: createPacketHash(contextPacket), verificationCommand: `kata handoff verify --task ${change} --id ${contextPacket.id}` },
    legacyHandoff: handoff,
    reminders: [
      'Wiki reduces project-context mistakes; CI, tests, Reviewer, and Judge prevent code-correctness mistakes.',
      'Use the suggested /kata-* skill after reading required project and Wiki files.',
    ],
  };
}

async function runHooksCommand(argv: string[]): Promise<Record<string, unknown>> {
  const [subcommand, ...rest] = argv;
  const args = parseHooksArgs(rest);
  const root = args.root ?? resolveWorkspaceRoot();
  if (subcommand === 'activate') {
    if (!args.change) throw new Error('Usage: kata hooks activate --change <id> [--role <role>] [--platform <name>] [--root <path>]');
    const active = await activateHookTask({
      root,
      taskId: args.change,
      role: args.role ?? 'implementer',
      ...(args.platform ? { platform: args.platform } : {}),
    });
    return {
      command: 'hooks activate',
      taskId: active.taskId,
      role: active.role,
      phase: active.phase,
      ...(active.platform ? { platform: active.platform } : {}),
      ...(active.branch ? { branch: active.branch } : {}),
      ...(active.origin ? { origin: active.origin } : {}),
      activatedAt: active.activatedAt,
      active: true,
    };
  }
  if (subcommand === 'deactivate') {
    await deactivateHookTask(root);
    return { command: 'hooks deactivate', active: false };
  }
  if (subcommand === 'status') {
    const active = await readActiveHookTask(root);
    return active
      ? {
          command: 'hooks status',
          active: true,
          taskId: active.taskId,
          role: active.role,
          phase: active.phase,
          ...(active.platform ? { platform: active.platform } : {}),
          ...(active.branch ? { branch: active.branch } : {}),
          ...(active.origin ? { origin: active.origin } : {}),
          activatedAt: active.activatedAt,
        }
      : { command: 'hooks status', active: false };
  }
  throw new Error(`Unknown hooks command: ${subcommand ?? ''}. Usage: kata hooks <activate|deactivate|status>`);
}

async function runDoctorCommand(argv: string[]): Promise<Record<string, unknown>> {
  const hasExplicitPlatform = argv.includes('--platform');
  const args = parseInstallerArgs(argv, { requirePlatform: false });
  if (hasExplicitPlatform) return doctor(args.platform, args.scope, args.options);

  const discovered = await discoverPlatforms(args.options);
  const scoped = discovered.filter((platform) => platform.scope === args.scope);
  const realPlatforms = scoped.filter((platform) => platform.platform !== 'generic');
  const targets = realPlatforms.length > 0 ? realPlatforms : scoped.filter((platform) => platform.platform === 'generic');
  const reports = [];
  for (const target of targets) {
    reports.push(await doctor(target.platform, target.scope, { ...args.options, ...(target.scope === 'project' ? { root: target.root } : { home: target.root }) }));
  }
  return {
    command: 'doctor',
    mode: 'aggregate',
    scope: args.scope,
    ok: reports.every((report) => report.ok),
    reports,
    summary: aggregateDoctorSummary(reports),
  };
}

function aggregateDoctorSummary(reports: Array<{ summary: { ok: number; missing: number; conflicts: number; skipped: number } }>): {
  ok: number;
  missing: number;
  conflicts: number;
  skipped: number;
} {
  return reports.reduce(
    (summary, report) => ({
      ok: summary.ok + report.summary.ok,
      missing: summary.missing + report.summary.missing,
      conflicts: summary.conflicts + report.summary.conflicts,
      skipped: summary.skipped + report.summary.skipped,
    }),
    { ok: 0, missing: 0, conflicts: 0, skipped: 0 },
  );
}

function parseOrientArgs(argv: string[]): {
  change?: string;
  root?: string;
  role?: string;
  platform?: string;
  taskKind?: string;
  routingMode?: string;
  failureCount?: number;
} {
  const args: {
    change?: string;
    root?: string;
    role?: string;
    platform?: string;
    taskKind?: string;
    routingMode?: string;
    failureCount?: number;
  } = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];
    if (arg === '--change' && value !== undefined) {
      args.change = value;
      index += 1;
    } else if (arg === '--root' && value !== undefined) {
      args.root = value;
      index += 1;
    } else if (arg === '--role' && value !== undefined) {
      args.role = value;
      index += 1;
    } else if (arg === '--platform' && value !== undefined) {
      args.platform = value;
      index += 1;
    } else if (arg === '--task-kind' && value !== undefined) {
      args.taskKind = value;
      index += 1;
    } else if ((arg === '--mode' || arg === '--routing-mode') && value !== undefined) {
      args.routingMode = value;
      index += 1;
    } else if ((arg === '--failures' || arg === '--failure-count') && value !== undefined) {
      const parsed = Number.parseInt(value, 10);
      if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`Invalid failure count: ${value}`);
      args.failureCount = parsed;
      index += 1;
    } else {
      throw new Error(`Unknown orient option: ${arg}`);
    }
  }
  return args;
}

function parseTasksArgs(argv: string[]): {
  from?: string;
  to?: string;
  task?: string;
  type?: string;
  reason?: string;
  root?: string;
} {
  const args: { from?: string; to?: string; task?: string; type?: string; reason?: string; root?: string } = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];
    if (arg === '--from' && value !== undefined) {
      args.from = value;
      index += 1;
    } else if (arg === '--to' && value !== undefined) {
      args.to = value;
      index += 1;
    } else if ((arg === '--task' || arg === '--change') && value !== undefined) {
      args.task = value;
      index += 1;
    } else if (arg === '--type' && value !== undefined) {
      args.type = value;
      index += 1;
    } else if (arg === '--reason' && value !== undefined) {
      args.reason = value;
      index += 1;
    } else if (arg === '--root' && value !== undefined) {
      args.root = value;
      index += 1;
    } else if (arg?.startsWith('--')) {
      throw new Error(`Unknown tasks option: ${arg}`);
    } else if (!args.task) {
      args.task = arg;
    } else {
      throw new Error(`Unexpected tasks argument: ${arg}`);
    }
  }
  return args;
}

function parseRelationsArgs(argv: string[]): {
  from?: string;
  to?: string;
  id?: string;
  type?: string;
  reason?: string;
  root?: string;
} {
  const args: { from?: string; to?: string; id?: string; type?: string; reason?: string; root?: string } = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];
    if (arg === '--from' && value !== undefined) {
      args.from = value;
      index += 1;
    } else if (arg === '--to' && value !== undefined) {
      args.to = value;
      index += 1;
    } else if ((arg === '--id' || arg === '--endpoint') && value !== undefined) {
      args.id = value;
      index += 1;
    } else if (arg === '--type' && value !== undefined) {
      args.type = value;
      index += 1;
    } else if (arg === '--reason' && value !== undefined) {
      args.reason = value;
      index += 1;
    } else if (arg === '--root' && value !== undefined) {
      args.root = value;
      index += 1;
    } else {
      throw new Error(`Unknown relations option: ${arg}`);
    }
  }
  return args;
}

function parseRelationEndpoint(value: string): RelationEndpoint {
  const separator = value.indexOf(':');
  if (separator === -1) {
    return { type: 'task', id: value };
  }
  const type = value.slice(0, separator);
  const id = value.slice(separator + 1);
  if ((type === 'task' || type === 'change') && id.length > 0) return { type, id };
  throw new Error(`Invalid relation endpoint: ${value}`);
}

function parseTaskRelationType(value: string): TaskRelationType {
  const allowed: TaskRelationType[] = [
    'superseded_by',
    'covered_by',
    'duplicate_of',
    'merged_into',
    'parent_of',
    'spawned_from',
    'related_to',
    'contains',
    'implements',
    'repairs',
    'depends_on',
    'blocked_by',
  ];
  if (allowed.includes(value as TaskRelationType)) return value as TaskRelationType;
  throw new Error(`Invalid task relation type: ${value}`);
}

function parseHooksArgs(argv: string[]): { change?: string; root?: string; role?: string; platform?: string } {
  const args: { change?: string; root?: string; role?: string; platform?: string } = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];
    if (arg === '--change' && value !== undefined) {
      args.change = value;
      index += 1;
    } else if (arg === '--root' && value !== undefined) {
      args.root = value;
      index += 1;
    } else if (arg === '--role' && value !== undefined) {
      args.role = value;
      index += 1;
    } else if (arg === '--platform' && value !== undefined) {
      args.platform = value;
      index += 1;
    } else {
      throw new Error(`Unknown hooks option: ${arg}`);
    }
  }
  return args;
}

function parseWikiArgs(argv: string[]): { from?: string; root?: string; wikiPath?: string; query?: string; file?: boolean; by?: string; role?: string; reason?: string; kind?: string; task?: string; decision?: string; candidates?: string[]; force?: boolean } {
  const args: { from?: string; root?: string; wikiPath?: string; query?: string; file?: boolean; by?: string; role?: string; reason?: string; kind?: string; task?: string; decision?: string; candidates?: string[]; force?: boolean } = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];
    if (arg === '--from' && value !== undefined) {
      args.from = value;
      index += 1;
    } else if (arg === '--root' && value !== undefined) {
      args.root = value;
      index += 1;
    } else if (arg === '--wiki' && value !== undefined) {
      args.wikiPath = value;
      index += 1;
    } else if ((arg === '--q' || arg === '--query') && value !== undefined) {
      args.query = value;
      index += 1;
    } else if (arg === '--file') {
      args.file = true;
    } else if (arg === '--by' && value !== undefined) {
      args.by = value;
      index += 1;
    } else if (arg === '--role' && value !== undefined) {
      args.role = value;
      index += 1;
    } else if (arg === '--reason' && value !== undefined) {
      args.reason = value;
      index += 1;
    } else if (arg === '--kind' && value !== undefined) {
      args.kind = value;
      index += 1;
    } else if (arg === '--task' && value !== undefined) {
      args.task = value;
      index += 1;
    } else if (arg === '--decision' && value !== undefined) {
      args.decision = value;
      index += 1;
    } else if (arg === '--candidate' && value !== undefined) {
      args.candidates = [...(args.candidates ?? []), value];
      index += 1;
    } else if (arg === '--force') {
      args.force = true;
    } else {
      throw new Error(`Unknown wiki option: ${arg}`);
    }
  }
  return args;
}

function parseInstallerArgs(
  argv: string[],
  settings: { requirePlatform?: boolean; allowWizard?: boolean } = {},
): { platform: Platform; scope: InstallScope; options: InstallOptions; yes?: boolean } {
  let platform: Platform = 'generic';
  let scope: InstallScope = 'project';
  const options: InstallOptions = {};
  let yes = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];
    if (arg === '--platform' && value !== undefined) {
      platform = parsePlatform(value);
      index += 1;
    } else if (arg === '--scope' && value !== undefined) {
      scope = parseScope(value);
      index += 1;
    } else if (arg === '--root' && value !== undefined) {
      options.root = value;
      index += 1;
    } else if (arg === '--home' && value !== undefined) {
      options.home = value;
      index += 1;
    } else if (arg === '--language' && value !== undefined) {
      options.language = parseLanguage(value);
      index += 1;
    } else if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--force') {
      options.force = true;
    } else if (arg === '--wiki-from' && value !== undefined) {
      options.wikiFrom = value;
      index += 1;
    } else if (arg === '--no-wiki') {
      options.noWiki = true;
    } else if (settings.allowWizard && arg === '--yes') {
      yes = true;
    } else if (arg !== undefined) {
      throw new Error(`Unknown installer option: ${arg}`);
    }
  }

  if (settings.requirePlatform !== false && platform === 'generic' && argv.length === 0) {
    platform = 'generic';
  }
  return { platform, scope, options, ...(yes ? { yes } : {}) };
}

function parseLanguage(value: string): 'en' | 'zh' {
  if (value === 'en' || value === 'zh') return value;
  throw new Error(`Invalid language: ${value}`);
}

const CODEGRAPH_SUBCOMMANDS = ['explore', 'query', 'impact', 'affected', 'node', 'status', 'index', 'sync'] as const;
type CodegraphSubcommand = (typeof CODEGRAPH_SUBCOMMANDS)[number];

function isCodegraphSubcommand(value: string): value is CodegraphSubcommand {
  return (CODEGRAPH_SUBCOMMANDS as readonly string[]).includes(value);
}

async function runCodegraphCommand(argv: string[]): Promise<Record<string, unknown>> {
  const [subcommand, ...rest] = argv;
  if (!subcommand || !isCodegraphSubcommand(subcommand)) {
    throw new Error(`Unknown codegraph command: ${subcommand ?? ''}. Usage: kata codegraph <${CODEGRAPH_SUBCOMMANDS.join('|')}> [args...]`);
  }
  try {
    const stdout = execFileSync('codegraph', [subcommand, ...rest], {
      encoding: 'utf-8',
      maxBuffer: 10 * 1024 * 1024,
      cwd: resolveWorkspaceRoot(),
      env: codeGraphExecutionEnv(),
    }).trim();
    return {
      command: `codegraph ${subcommand}`,
      success: true,
      args: rest,
      ...(stdout ? { output: stdout } : {}),
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      command: `codegraph ${subcommand}`,
      success: false,
      args: rest,
      error: message,
    };
  }
}

async function runCometCommand(argv: string[], root = resolveWorkspaceRoot()): Promise<Record<string, unknown>> {
  const [subcommand, ...rest] = argv;
  const args = parseCometArgs(rest);

  if (subcommand === 'acknowledge-open') {
    if (!args.change) throw new Error('Usage: kata comet acknowledge-open --change <id>');
    return { command: 'comet acknowledge-open', taskId: args.change, workflowProfile: await acknowledgeCometOpen(root, args.change), nextAction: { slashCommand: `/kata-design ${args.change}`, cliCommand: `kata design --change ${args.change}` } };
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
    const compat = readCometCompatibility();
    const installed = await getCometVersion();
    return {
      command: 'comet version',
      compatibility: compat,
      installed: installed ?? null,
      compatMinVersion: compat.minVersion,
      compatMaxVersion: compat.maxVersion ?? null,
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

  throw new Error(`Unknown comet command: ${subcommand ?? ''}. Usage: kata comet <install|update|version|path|verify|acknowledge-open>`);
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

function parsePlatform(value: string): Platform {
  if (value in platformDefinitionById) return value as Platform;
  throw new Error(`Unknown platform: ${value}`);
}

function parseScope(value: string): InstallScope {
  if (value === 'project' || value === 'global') return value;
  throw new Error(`Unknown install scope: ${value}`);
}

function isCliEntrypoint(): boolean {
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1] ?? '');
  } catch {
    return false;
  }
}

function outputResult(result: Record<string, unknown>): void {
  if (quietOutput) return;
  if (!jsonOutput && isUpdateResult(result)) {
    process.stdout.write(renderUpdateSummary(result));
    return;
  }
  process.stdout.write(JSON.stringify(result) + '\n');
}

function writeUpdateProgress(message: string): void {
  if (!quietOutput && !jsonOutput) process.stdout.write(message);
}

function isUpdateResult(result: Record<string, unknown>): boolean {
  return result.command === 'update' || (typeof result.platform === 'string' && 'written' in result && 'unchanged' in result);
}

function formatUpdateReport(report: { platform: string; written: string[]; unchanged: string[]; conflicts: string[]; removed: string[]; dryRun: boolean }): string {
  const changes = [
    `写入 ${report.written.length}`,
    `保持 ${report.unchanged.length}`,
    `冲突 ${report.conflicts.length}`,
    `移除 ${report.removed.length}`,
  ].join(' · ');
  return `  ${report.dryRun ? '预览完成' : '完成'}：${changes}\n`;
}

function renderUpdateSummary(result: Record<string, unknown>): string {
  const reports = Array.isArray(result.reports)
    ? result.reports as Array<{ platform: string; summary: { written: number; unchanged: number; conflicts: number; removed: number; dryRun: boolean } }>
    : [{
        platform: String(result.platform),
        summary: {
          written: Array.isArray(result.written) ? result.written.length : 0,
          unchanged: Array.isArray(result.unchanged) ? result.unchanged.length : 0,
          conflicts: Array.isArray(result.conflicts) ? result.conflicts.length : 0,
          removed: Array.isArray(result.removed) ? result.removed.length : 0,
          dryRun: result.dryRun === true,
        },
      }];
  const total = reports.reduce((sum, report) => ({
    written: sum.written + report.summary.written,
    unchanged: sum.unchanged + report.summary.unchanged,
    conflicts: sum.conflicts + report.summary.conflicts,
    removed: sum.removed + report.summary.removed,
  }), { written: 0, unchanged: 0, conflicts: 0, removed: 0 });
  const status = total.conflicts > 0 ? '完成（存在需人工处理的冲突）' : '完成';
  const runtimeRefresh = result.runtimeRefresh as RuntimeRefreshResult | undefined;
  return `\n${status}\n平台：${reports.map((report) => report.platform).join('、')}\n变更：写入 ${total.written} · 保持 ${total.unchanged} · 冲突 ${total.conflicts} · 移除 ${total.removed}\n${runtimeRefresh ? formatRuntimeRefresh(runtimeRefresh) : ''}${jsonOutput ? '' : '提示：使用 --json 获取机器可读报告，使用 --quiet 静默执行。\n'}`;
}

function formatRuntimeRefresh(result: RuntimeRefreshResult): string {
  const status = (value: { success: boolean }) => value.success ? '完成' : '失败';
  const cometVersion = result.comet.success && result.comet.installedVersion ? ` (${result.comet.installedVersion})` : '';
  return `运行时：Comet 更新 ${status(result.comet)}${cometVersion} · CodeGraph sync ${status(result.codegraphSync)} · CodeGraph index ${status(result.codegraphIndex)}\n`;
}

if (isCliEntrypoint()) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
