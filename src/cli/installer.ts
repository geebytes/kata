import { platformDefinitionById } from '../adapters/platforms.js';
import { doctor } from '../adapters/doctor.js';
import { discoverPlatforms, listManagedPlatforms, update } from '../adapters/discovery.js';
import { mergeInstallReports } from '../init-wizard.js';
import type { InstallOptions, InstallScope, Platform } from '../adapters/manifest.js';
import { updateComet } from '../comet/install.js';
import { codeGraphInvocation } from '../codegraph/runtime.js';
import { runProcess } from '../process/run.js';
import { currentOutput, writeProgress } from './output.js';

/**
 * The installer and runtime family: `init` / `update` / `uninstall` / `discover` / `doctor`, their typed invocation
 * parser, the runtime refresh they trigger afterwards, and the human rendering of an update report.
 *
 * L0-01 extracts these out of `cli.ts` a family at a time. What stays in the entry point is dispatch: it parses the
 * invocation, calls a handler here, and prints the returned result through the output boundary. Nothing in this module
 * imports the entry point, which is what keeps the move one-directional.
 */

export async function runAggregateUpdate(
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
    writeProgress(`Kata update · ${scope === 'project' ? '当前项目' : '全局安装'}\n`);
    const reports = [];
    for (const platform of targets) {
        writeProgress(`\n→ 更新 ${platform}\n`);
        const report = await update(platform, scope, options);
        reports.push(report);
        writeProgress(formatUpdateReport(report));
    }
    const runtimeRefresh = await runRuntimeRefresh(options.root!);
    writeProgress(formatRuntimeRefresh(runtimeRefresh));
    return { ...mergeInstallReports({ command: 'update', mode: 'auto', scope, reports }), runtimeRefresh };
}

type RefreshStageStatus = 'completed' | 'failed' | 'timed_out' | 'skipped';
type RefreshStageOutcome = {
    stage: 'comet' | 'codegraph-sync' | 'codegraph-index';
    status: RefreshStageStatus;
    durationMs: number;
    /** Whatever the stage printed, for the stages that run a child process. */
    output?: string;
    /** Why a stage failed, timed out or was skipped. */
    detail?: string;
};

/**
 * The runtime refresh is **best-effort**: it runs after the platforms are installed and updated, and no stage failure
 * aborts the update. Each stage is bounded by its own timeout, runs asynchronously (it used to block the event loop with
 * `execFileSync`), and reports its own outcome — so a timed-out CodeGraph index is visible as `timed_out` rather than as
 * a generic failure, and the update still reports success.
 *
 * The two CodeGraph stages are independent and run in order (`sync`, then `index`); a failure in one does not skip the
 * other, because either can be useful on its own.
 */
type RuntimeRefreshResult = {
    policy: 'best-effort';
    stages: RefreshStageOutcome[];
    // The per-stage fields the update report and `--json` consumers already read, kept as the compatibility surface.
    comet: { success: boolean; previousVersion?: string | null; installedVersion?: string | null; error?: string };
    codegraphSync: { success: boolean; output?: string; error?: string };
    codegraphIndex: { success: boolean; output?: string; error?: string };
};

export async function runRuntimeRefresh(root: string): Promise<RuntimeRefreshResult> {
    const timeoutMs = runtimeRefreshTimeoutMs();
    const stages: RefreshStageOutcome[] = [];
    const started = (): number => Date.now();

    const cometStart = started();
    const comet: RuntimeRefreshResult['comet'] = await withTimeout(updateComet(), timeoutMs, `Comet update timed out after ${timeoutMs}ms`)
        .then((result) => ({ success: true, previousVersion: result.previousVersion, installedVersion: result.installedVersion }))
        .catch((error: unknown) => ({ success: false, error: error instanceof Error ? error.message : String(error) }));
    stages.push({
        stage: 'comet',
        status: comet.success ? 'completed' : /timed out/i.test(comet.error ?? '') ? 'timed_out' : 'failed',
        durationMs: started() - cometStart,
        ...(comet.error ? { detail: comet.error } : {}),
    });

    const runCodegraphStage = async (subcommand: 'sync' | 'index'): Promise<{ success: boolean; output?: string; error?: string }> => {
        const stage = subcommand === 'sync' ? 'codegraph-sync' : 'codegraph-index';
        const invocation = codeGraphInvocation(root);
        const stageStart = started();
        const result = await runProcess(invocation.command, [subcommand], {
            cwd: invocation.cwd,
            env: invocation.env,
            timeoutMs,
        });
        const output = result.stdout.trim();
        const detail = result.failure === 'timeout'
            ? `codegraph ${subcommand} timed out after ${timeoutMs}ms`
            : result.failure === 'spawn_failed'
                ? `codegraph is not installed (or not executable) at ${invocation.command}`
                : result.stderr.trim() || `codegraph ${subcommand} exited ${result.exitCode}`;

        stages.push({
            stage,
            // Three structural cases, no matching on CodeGraph's own wording: a missing binary is nothing to do
            // (`skipped`), a child that outlived its budget was cut off (`timed_out`), anything else ran and failed.
            status: result.ok
                ? 'completed'
                : result.failure === 'timeout'
                    ? 'timed_out'
                    : result.failure === 'spawn_failed'
                        ? 'skipped'
                        : 'failed',
            durationMs: started() - stageStart,
            ...(output ? { output } : {}),
            ...(result.ok ? {} : { detail }),
        });
        return result.ok
            ? { success: true, ...(output ? { output } : {}) }
            : { success: false, error: detail };
    };

    const codegraphSync = await runCodegraphStage('sync');
    const codegraphIndex = await runCodegraphStage('index');
    return { policy: 'best-effort', stages, comet, codegraphSync, codegraphIndex };
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

export async function runDoctorCommand(argv: string[]): Promise<Record<string, unknown>> {
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

function parseLanguage(value: string): 'en' | 'zh' {
    if (value === 'en' || value === 'zh') return value;
    throw new Error(`Invalid language: ${value}`);
}

export function parseInstallerArgs(
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

function parsePlatform(value: string): Platform {
    if (value in platformDefinitionById) return value as Platform;
    throw new Error(`Unknown platform: ${value}`);
}

function parseScope(value: string): InstallScope {
    if (value === 'project' || value === 'global') return value;
    throw new Error(`Unknown install scope: ${value}`);
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

export function renderUpdateSummary(result: Record<string, unknown>): string {
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
    return `\n${status}\n平台：${reports.map((report) => report.platform).join('、')}\n变更：写入 ${total.written} · 保持 ${total.unchanged} · 冲突 ${total.conflicts} · 移除 ${total.removed}\n${runtimeRefresh ? formatRuntimeRefresh(runtimeRefresh) : ''}${currentOutput().format === 'json' ? '' : '提示：使用 --json 获取机器可读报告，使用 --quiet 静默执行。\n'}`;
}

function formatRuntimeRefresh(result: RuntimeRefreshResult): string {
    const stage = (name: RefreshStageOutcome['stage']): string => result.stages.find((entry) => entry.stage === name)?.status ?? '';
    const label = (value: string): string => value === 'completed' ? '完成' : value === 'timed_out' ? '超时' : value === 'skipped' ? '跳过' : '失败';
    const cometVersion = result.comet.success && result.comet.installedVersion ? ` (${result.comet.installedVersion})` : '';
    const failed = result.stages.filter((entry) => entry.status !== 'completed');
    // Best-effort means the update still succeeded; saying which stage did not keeps that from reading as a clean run.
    const partial = failed.length > 0
        ? `\n运行时刷新为尽力而为：${failed.map((entry) => `${entry.stage} ${label(entry.status)}${entry.detail ? `（${entry.detail}）` : ''}`).join('；')}。平台安装与更新不受影响。`
        : '';
    return `运行时：Comet 更新 ${label(stage('comet'))}${cometVersion} · CodeGraph sync ${label(stage('codegraph-sync'))} · CodeGraph index ${label(stage('codegraph-index'))}\n${partial}`;
}
