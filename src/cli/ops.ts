import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveWorkspaceRoot } from '../core/layout.js';
import { acknowledgeCometOpen } from '../core/workflow-profile.js';
import { codeGraphInvocation } from '../codegraph/runtime.js';
import { createWorktree, listWorktrees, removeWorktree, worktreesDir } from '../workflow/worktree.js';
import {
    adversarialGateFor,
    adversarialReasonFor,
    blockingAdversarialFindings,
    buildAdversarialBrief,
    readAdversarialRecord,
    writeAdversarialRecord,
    type AdversarialNode,
    type AdversarialRecord,
    adversarialNodes,
} from '../quality/adversarial.js';
import { loadEvaluationManifest, persistEvaluationReport, runEvaluation } from '../eval/runner.js';
import { runProcessSync } from '../process/run.js';

/** The CodeGraph subcommands this CLI dispatches to the installed binary. */
const CODEGRAPH_SUBCOMMANDS = ['explore', 'query', 'impact', 'affected', 'node', 'status', 'index', 'sync'] as const;
type CodegraphSubcommand = (typeof CODEGRAPH_SUBCOMMANDS)[number];
import { getCometVersion, installComet, readCometCompatibility, resolveCometPath, updateComet, verifyComet } from '../comet/install.js';
import { nextActionForTask } from '../workflow/navigation.js';
import { argValue, parseChangeArg } from './invocation.js';
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
 * `kata-cli worktree …` — linked worktrees with kata's own convention.
 *
 * `isolated_worktree` used to be a declaration kata could not act on: every host nested worktrees in its own place, and
 * from inside a nested one no task-addressed command could resolve `--root` without help. Kata now creates, lists and
 * removes them under `.kata/worktrees/` (ignored, so a nested worktree never shows up as untracked paths in its primary
 * checkout) and carries the task's state into the checkout.
 */
/** `kata-cli revision digests --change <task> [--since <revision-id|manifestHash>]` — the per-path content table. */
export async function runRevisionCommand(argv: string[]): Promise<Record<string, unknown>> {
    const [subcommand, ...rest] = argv;
    const { readCurrentTaskRevision, readTaskRevision, computePathDigests } = await import('../workflow/revision.js');
    const { changeSurface, changeSurfaceAgainstWorkspace } = await import('../quality/revision-delta.js');

    if (subcommand !== 'digests') {
        throw new Error('Usage: kata-cli revision digests --change <task-id> [--since <revision-id|manifestHash>]');
    }
    const taskId = parseChangeArg(rest);
    if (!taskId) throw new Error('Usage: kata-cli revision digests --change <task-id> [--since <revision-id|manifestHash>]');
    const root = resolveWorkspaceRoot();
    const revision = await readCurrentTaskRevision(root, taskId);
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
        return { command: 'worktree remove', ...(await removeWorktree({ root, path, ...(rest.includes('--force') ? { force: true } : {}) })) };
    }

    throw new Error(`Unknown worktree command: ${subcommand}. Usage: kata-cli worktree <create|list|remove>`);
}

/**
 * `kata-cli adversarial …` — the independent adversarial pass at the verify and review nodes.
 *
 * `brief` renders the self-contained brief for a clean-context subagent and reports the hash the result must carry;
 * `record` validates and files the result; `status` reports both nodes. The gate that consumes the record lives in the
 * workflow (verify and review refuse to conclude without one), so this command is the only way in.
 */
export async function runAdversarialCommand(argv: string[]): Promise<Record<string, unknown>> {
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
        const since = argValue(rest, '--since');
        const brief = await buildAdversarialBrief(root, change, node, since ? { since } : {});
        const { reverificationCostFor } = await import('../quality/adversarial.js');
        return {
            command: 'adversarial brief',
            taskId: change,
            node,
            revisionId: brief.revisionId,
            briefSha256: brief.sha256,
            // Design §F3: what acting on this brief will cost in re-verification, stated where the decision is made.
            reverificationCost: await reverificationCostFor(root, change),
            ...(since ? { since } : {}),
            // A requested delta that could not be measured is reported as such: the caller is never handed a full brief
            // that quietly pretends to be the narrower pass it asked for.
            ...(brief.delta ? { delta: brief.delta } : {}),
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
        const since = argValue(rest, '--since');
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
            // A delta pass's scope is what the gate checks it against, so a pass that names `--since` is recorded with
            // the change surface kata itself measured — not with whatever the reviewer typed.
            ...(since ? { scope: await currentDeltaScope(root, change, since) } : {}),
        });
        const gate = await adversarialGateFor(root, change, node);
        return {
            command: 'adversarial record',
            taskId: change,
            node,
            status: record.status,
            verdict: record.verdict ?? null,
            findings: (record.findings ?? []).map((finding) => ({ id: finding.id, severity: finding.severity, message: finding.message })),
            ...(parsed.findingOrigins ? { findingOrigins: parsed.findingOrigins } : {}),
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

export function isAdversarialNode(value: string): value is AdversarialNode {
    return (adversarialNodes as readonly string[]).includes(value);
}

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
            recommended?.upstream?.blockingFindings
                ? '检测到上游 blocking review findings；建议作为 implementer repair。'
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

/**
 * The scope a `--since` pass is recorded with: the base revision and the paths kata measured as changed (F2.3).
 *
 * The reviewer declares *that* it is a delta pass; the platform declares *over what*, because the gate has to be able to
 * verify the claim without trusting the reviewer. If the change surface cannot be measured the scope says so, and the
 * gate refuses the pass as `delta_unavailable` rather than accepting a delta nobody can check.
 */
async function currentDeltaScope(root: string, taskId: string, since: string): Promise<{ kind: 'full' | 'delta'; from?: string; changedPaths?: string[] }> {
    const { readTaskRevision } = await import('../workflow/revision.js');
    const { changeSurfaceAgainstWorkspace } = await import('../quality/revision-delta.js');
    const base = await readTaskRevision(root, taskId, since).catch(() => null);
    if (!base) return { kind: 'delta', from: since, changedPaths: [] };
    const surface = await changeSurfaceAgainstWorkspace(root, base);
    return {
        kind: 'delta',
        from: base.id,
        changedPaths: surface.status === 'available' ? surface.changedPaths : [],
    };
}

async function currentRevisionManifest(root: string, taskId: string): Promise<{ manifestHash?: string }> {
    const { readCurrentTaskRevision } = await import('../workflow/revision.js');
    const revision = await readCurrentTaskRevision(root, taskId);
    return revision?.manifestHash ? { manifestHash: revision.manifestHash } : {};
}
