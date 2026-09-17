import { runGit as runGitCommand } from './git.js';
import { runProcess, runProcessSync } from '../process/run.js';

export type GitFlowStrategy = 'git-flow' | 'manual';
export type GitFlowStatus = 'active' | 'pending_confirmation' | 'failed';
export type GitFlowBranchKind = 'feature' | 'hotfix';
export type GitFlowInstallationStatus = 'installed' | 'failed' | 'unsupported';

export interface GitFlowState {
    strategy: GitFlowStrategy;
    branch: string;
    baseBranch: string;
    status: GitFlowStatus;
    installation?: GitFlowInstallation;
    /** Why the operation failed, captured from the runner rather than left to the terminal. */
    reason?: string;
    /** The runner's captured output, truncated — the audit record used to carry neither this nor a reason. */
    output?: string;
    /** True when the operation was allowed to write to the terminal because it genuinely needed the user. */
    interactive?: boolean;
}

export interface GitFlowPlan extends GitFlowState {
    command: string[];
    reason?: string;
    /** Set when this plan's command may write to the terminal because it needs the user (an explicit opt-in). */
    interactive?: boolean;
}

export interface GitCommandResult { ok: boolean; stdout: string; }
export type GitCommandRunner = (root: string, args: string[]) => GitCommandResult;
export interface GitFlowInstallation {
    status: GitFlowInstallationStatus;
    command?: string[];
    manualCommand?: string;
}
export type GitFlowInstaller = (root: string) => GitFlowInstallation;

export interface GitFlowInitializationResult {
    status: 'initialized' | 'already_initialized' | 'skipped' | 'failed';
    command?: string[];
    /** True when the child ran with the terminal attached because the user had to answer a prompt. */
    interactive?: boolean;
    installation?: GitFlowInstallation;
    reason?: string;
    /** Suggested manual command for the user to finish what kata deferred. */
    manualCommand?: string;
    /** Human-readable hint surfaced to the user when kata skips init. */
    userHint?: string;
}

export interface GitFlowInitializationOptions {
    interactive: boolean;
    run?: GitCommandRunner;
    install?: GitFlowInstaller;
    execute?: (root: string, args: string[]) => void;
    executeInteractive?: (root: string, args: string[]) => Promise<void>;
}

/** Git Flow's runner contract over the shared reader: the same reads, reported rather than thrown. */
const runGit: GitCommandRunner = (root, args) => {
    const result = runGitCommand(root, args);
    return { ok: result.ok, stdout: result.stdout.replace(/\s+$/, '') };
};

export function inspectGitFlow(
    root: string,
    taskId: string,
    run: GitCommandRunner = runGit,
    branchKind: GitFlowBranchKind = 'feature',
    install: GitFlowInstaller = installGitFlow,
): GitFlowPlan {
    const dirty = run(root, ['status', '--porcelain']);
    if (!dirty.ok) return failed('repository_unavailable');
    const unmanagedChanges = (dirty.stdout ?? '').split('\n').filter((line) => line.trim() && !line.slice(3).startsWith('.kata/'));
    if (unmanagedChanges.length > 0) return failed('worktree_dirty');

    const currentBranch = run(root, ['branch', '--show-current']);
    const configuredBase = run(root, ['config', '--get', baseConfigKey(branchKind)]);
    const fallbackBase = branchKind === 'hotfix' ? 'master' : 'develop';
    const baseBranch = configuredBase.ok && configuredBase.stdout
        ? configuredBase.stdout
        : run(root, ['rev-parse', '--verify', '--quiet', fallbackBase]).ok
            ? fallbackBase
            : currentBranch.ok && currentBranch.stdout
                ? currentBranch.stdout
                : '';
    if (!baseBranch) return failed('base_branch_unresolved');

    const branch = `${branchKind}/${taskId}`;
    const existing = run(root, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]).ok;
    let flowVersion = configuredBase.ok ? run(root, ['flow', 'version']) : { ok: false, stdout: '' };
    let installation = configuredBase.ok && !flowVersion.ok ? install(root) : undefined;
    if (installation?.status === 'installed') {
        flowVersion = run(root, ['flow', 'version']);
        if (!flowVersion.ok) installation = { ...installation, status: 'failed' };
    }
    const gitFlowAvailable = configuredBase.ok && flowVersion.ok;
    const strategy: GitFlowStrategy = gitFlowAvailable ? 'git-flow' : 'manual';
    if (existing) {
        if (currentBranch.stdout === branch) return { strategy, branch, baseBranch, status: 'active', command: [], ...(installation ? { installation } : {}) };
        return { strategy, branch, baseBranch, status: 'failed', command: [], reason: 'target_branch_exists', ...(installation ? { installation } : {}) };
    }
    return {
        strategy,
        branch,
        baseBranch,
        status: 'pending_confirmation',
        command: strategy === 'git-flow' ? ['flow', branchKind, 'start', taskId] : ['switch', '-c', branch, baseBranch],
        ...(installation ? { installation } : {}),
    };
}

function baseConfigKey(branchKind: GitFlowBranchKind): string {
    return branchKind === 'hotfix' ? 'gitflow.branch.master' : 'gitflow.branch.develop';
}

const installAttemptConfigKey = 'kata.gitflow-install-attempted';

const packageManagers: Record<string, Array<{ binary: string; args: string[]; manualCommand: string }>> = {
    darwin: [{ binary: 'brew', args: ['install', 'git-flow-avh'], manualCommand: 'brew install git-flow-avh' }],
    linux: [
        { binary: 'apt-get', args: ['install', '-y', 'git-flow'], manualCommand: 'sudo apt-get install -y git-flow' },
        { binary: 'dnf', args: ['install', '-y', 'gitflow'], manualCommand: 'sudo dnf install -y gitflow' },
        { binary: 'pacman', args: ['-S', '--noconfirm', 'gitflow'], manualCommand: 'sudo pacman -S --noconfirm gitflow' },
        { binary: 'apk', args: ['add', 'git-flow'], manualCommand: 'sudo apk add git-flow' },
    ],
};

/** The installer's probe and install run through the same facility; both are bounded and capture nothing to report. */
const commandExists = (command: string): boolean => {
    return runProcessSync(command, ['--version'], { cwd: process.cwd(), timeoutMs: 30_000, captureStderr: false }).ok;
};

export const installGitFlow: GitFlowInstaller = (root) => {
    const candidate = packageManagers[process.platform]?.find(({ binary }) => commandExists(binary));
    if (!candidate) {
        return {
            status: 'unsupported',
            manualCommand: process.platform === 'win32' ? 'Install Git Flow for Windows, then rerun the Kata command.' : 'Install git-flow with your system package manager, then rerun the Kata command.',
        };
    }
    if (runGit(root, ['config', '--local', '--get', installAttemptConfigKey]).ok) {
        return { status: 'failed', command: [candidate.binary, ...candidate.args], manualCommand: candidate.manualCommand };
    }
    const installed = runProcessSync(candidate.binary, candidate.args, { cwd: root, timeoutMs: 120_000, captureStderr: false });
    try {
        if (!installed.ok) throw new Error(installed.stderr.trim() || `${candidate.binary} exited ${installed.exitCode}`);
        runGit(root, ['config', '--local', '--unset-all', installAttemptConfigKey]);
        return { status: 'installed', command: [candidate.binary, ...candidate.args], manualCommand: candidate.manualCommand };
    } catch {
        runGit(root, ['config', '--local', installAttemptConfigKey, new Date().toISOString()]);
        return { status: 'failed', command: [candidate.binary, ...candidate.args], manualCommand: candidate.manualCommand };
    }
};

export async function initializeGitFlowProject(
    root: string,
    options: GitFlowInitializationOptions,
): Promise<GitFlowInitializationResult> {
    const run = options.run ?? runGit;
    const install = options.install ?? installGitFlow;
    const execute = options.execute ?? ((cwd, args) => {
        // The same facility as every other child kata starts: bounded, own process group, and captured — the output was
        // discarded before, so a failure had nothing to report.
        const result = runProcessSync('git', args, { cwd, timeoutMs: gitFlowTimeoutMs() });
        if (!result.ok) throw new Error(result.stderr.trim() || `git ${args.join(' ')} exited ${result.exitCode}`);
    });
    const executeInteractive = options.executeInteractive ?? runInteractiveGitFlow;
    const repository = run(root, ['rev-parse', '--is-inside-work-tree']);
    if (!repository.ok || repository.stdout !== 'true') return { status: 'skipped', reason: 'not_a_git_repository' };

    const master = run(root, ['config', '--get', 'gitflow.branch.master']);
    const develop = run(root, ['config', '--get', 'gitflow.branch.develop']);
    if (master.ok && develop.ok) return { status: 'already_initialized' };
    if (master.ok || develop.ok) return { status: 'skipped', reason: 'git_flow_partially_initialized' };

    // Pre-flight: `git flow init` itself runs `git checkout -b develop`, which
    // git refuses on a dirty worktree. Rather than letting git-flow's raw
    // "Fatal: Working tree contains unstaged changes" blast through stderr
    // and look like a catastrophic failure of `kata-cli init`, we detect this
    // state up front and defer to the user with a clean hint.
    const dirty = run(root, ['status', '--porcelain']);
    const unmanagedChanges = (dirty.stdout ?? '').split('\n').filter((line) => line.trim());
    if (unmanagedChanges.length > 0) {
        return {
            status: 'skipped',
            reason: 'worktree_dirty_deferred',
            manualCommand: 'git flow init -d',
            userHint: `Comet 安装在工作树留下了 ${unmanagedChanges.length} 个未提交改动；已跳过 git flow 初始化以避免覆盖。请提交或 stash 后手动执行 'git flow init -d'。`,
        };
    }

    let flowVersion = run(root, ['flow', 'version']);
    const installation = flowVersion.ok ? undefined : install(root);
    if (installation?.status === 'installed') flowVersion = run(root, ['flow', 'version']);
    if (!flowVersion.ok) {
        return {
            status: 'failed',
            ...(installation ? { installation } : {}),
            reason: installation?.status === 'failed' ? 'git_flow_install_failed' : 'git_flow_unavailable',
        };
    }

    const command = ['flow', 'init', ...(options.interactive ? [] : ['-d'])];
    try {
        if (options.interactive) await executeInteractive(root, command);
        else execute(root, command);
        return {
            status: 'initialized',
            command,
            ...(installation ? { installation } : {}),
            // The opt-in is recorded, so the audit trail says whether a child wrote to the terminal.
            ...(options.interactive ? { interactive: true } : {}),
        };
    } catch (error) {
        // Capture git-flow output but do NOT inherit stderr verbatim — historical
        // bug: `git flow init` walked interactive prompts to stderr even with -d
        // and `git checkout` raised "Fatal: Working tree contains unstaged
        // changes" there, making kata-cli init look like it had crashed. Surface
        // only the captured message as a clean reason.
        return {
            status: 'failed',
            command,
            ...(installation ? { installation } : {}),
            reason: error instanceof Error ? error.message : String(error),
            manualCommand: command.join(' '),
        };
    }
}

/**
 * The one interactive execution model: the child keeps the terminal (a prompt needs it) and is still bounded and
 * cancellable through the process facility. The previous version spawned git with `stdio: 'inherit'` and no timeout, so
 * the operation with the largest blast radius — creating or switching a branch — was the one that could hang an
 * invocation and left no captured output for the plan record.
 */
async function runInteractiveGitFlow(root: string, args: string[]): Promise<void> {
    const result = await runProcess('git', args, {
        cwd: root,
        env: { ...process.env },
        timeoutMs: gitFlowTimeoutMs(),
        inheritOutput: true,
    });
    if (!result.ok) {
        throw new Error(result.failure === 'timeout'
            ? `git ${args.join(' ')} timed out after ${gitFlowTimeoutMs()}ms`
            : `git ${args.join(' ')} exited with code ${result.exitCode}`);
    }
}

/** The bound every git-flow child runs under; configurable because an interactive `git flow init` may need longer. */
export function gitFlowTimeoutMs(): number {
    const configured = Number.parseInt(process.env.KATA_GITFLOW_TIMEOUT_MS ?? '', 10);
    return Number.isSafeInteger(configured) && configured >= 1_000 && configured <= 600_000 ? configured : 120_000;
}

export function applyGitFlowPlan(root: string, plan: GitFlowPlan, run: GitCommandRunner = runGit): GitFlowState {
    if (plan.status !== 'pending_confirmation' || plan.command.length === 0) {
        return { ...plan, status: 'failed', reason: 'no_branch_command_recorded' };
    }
    const result = run(root, plan.command);
    const output = result.stdout.trim();
    return {
        strategy: plan.strategy,
        branch: plan.branch,
        baseBranch: plan.baseBranch,
        status: result.ok ? 'active' : 'failed',
        ...(plan.installation ? { installation: plan.installation } : {}),
        // Branch creation is the operation with the largest blast radius; the record says why it failed, and what the
        // runner printed, rather than leaving both on a terminal nobody kept.
        ...(result.ok ? {} : { reason: output || `git ${plan.command.join(' ')} failed` }),
        ...(output && !result.ok ? { output: output.slice(0, 2_000) } : {}),
        ...(plan.interactive ? { interactive: true } : {}),
    };
}

function failed(reason: string): GitFlowPlan {
    return { strategy: 'manual', branch: '', baseBranch: '', status: 'failed', command: [], reason };
}
