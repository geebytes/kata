import { execFileSync, spawn } from 'node:child_process';

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
}

export interface GitFlowPlan extends GitFlowState {
    command: string[];
    reason?: string;
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

const runGit: GitCommandRunner = (root, args) => {
    try {
        return { ok: true, stdout: execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() };
    } catch {
        return { ok: false, stdout: '' };
    }
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

const commandExists = (command: string): boolean => {
    try {
        execFileSync(command, ['--version'], { stdio: 'ignore' });
        return true;
    } catch {
        return false;
    }
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
    try {
        execFileSync(candidate.binary, candidate.args, { stdio: 'ignore', timeout: 120_000 });
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
    const execute = options.execute ?? ((cwd, args) => { execFileSync('git', args, { cwd, stdio: 'ignore', timeout: 120_000 }); });
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
        return { status: 'initialized', command, ...(installation ? { installation } : {}) };
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

function runInteractiveGitFlow(root: string, args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
        const child = spawn('git', args, { cwd: root, stdio: 'inherit', env: { ...process.env } });
        child.once('error', reject);
        child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`git ${args.join(' ')} exited with code ${code}`)));
    });
}

export function applyGitFlowPlan(root: string, plan: GitFlowPlan, run: GitCommandRunner = runGit): GitFlowState {
    if (plan.status !== 'pending_confirmation' || plan.command.length === 0) return { ...plan, status: 'failed' };
    const result = run(root, plan.command);
    return {
        strategy: plan.strategy,
        branch: plan.branch,
        baseBranch: plan.baseBranch,
        status: result.ok ? 'active' : 'failed',
        ...(plan.installation ? { installation: plan.installation } : {}),
    };
}

function failed(reason: string): GitFlowPlan {
    return { strategy: 'manual', branch: '', baseBranch: '', status: 'failed', command: [], reason };
}
