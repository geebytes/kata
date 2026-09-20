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
    issueAdversarialBrief,
    issuedBriefPool,
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
 * checkout) and carries the task's state into the checkout.
 */
/**
 * The saving a delta pass actually delivered, against the full pass it narrowed (design §11).
 *
 * The design's largest unverified assumption was that a delta pass costs a fraction of a full one, and it could not be
 * measured because nothing recorded how long a pass took. Now the passes do; this reports the comparison, and reports
 * that it is *not yet measurable* rather than inventing an answer when only one side exists.
 */
async function deltaSaving(
    root: string,
    taskId: string,
    node: 'verify' | 'review',
    record: AdversarialRecord | null,
): Promise<Record<string, unknown>> {
    if (!record || record.scope?.kind !== 'delta' || !record.elapsedMs) return {};
    const { readdir } = await import('node:fs/promises');
    const { join } = await import('node:path');
    // Every recorded pass for this node lives in `.kata/tasks/<id>/adversarial-<node>.json`; the previous full pass is
    // whatever that file held before, so the comparison the design wants needs the historical snapshot — which the
    // workspace keeps only for the current record. Where it is absent, say so plainly.
    const directory = join(root, '.kata/tasks', taskId, 'passes');
    const snapshots = await readdir(directory).catch(() => [] as string[]);
    const full = [];
    for (const file of snapshots.filter((name) => name.includes(node) && name.endsWith('.json'))) {
        const previous = JSON.parse(await readFile(join(directory, file), 'utf8')) as { scope?: { kind?: string }; elapsedMs?: number };
        if (previous.scope?.kind === 'full' && previous.elapsedMs) full.push(previous.elapsedMs);
    }
    if (full.length === 0) {
        return { deltaSaving: { measurable: false, note: 'the previous full pass recorded no elapsed time, so the saving cannot be computed yet' } };
    }
    const baseline = full.reduce((sum, value) => sum + value, 0) / full.length;
    return {
        deltaSaving: {
            measurable: true,
            fullMs: Math.round(baseline),
            deltaMs: record.elapsedMs,
            savedMs: Math.round(baseline - record.elapsedMs),
            factor: baseline > 0 ? Number((baseline / record.elapsedMs).toFixed(2)) : null,
        },
    };
}

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
        const requestedMode = argValue(rest, '--mode');
        // Issued, not merely rendered: this is the copy the recorded pass will be bound to (D2, second fix).
        const brief = await issueAdversarialBrief(root, change, node, {
            ...(since ? { since } : {}),
            ...(requestedMode === 'cold' || requestedMode === 'verify' ? { mode: requestedMode } : {}),
        });
        const { reverificationCostFor } = await import('../quality/adversarial.js');
        return {
            command: 'adversarial brief',
            taskId: change,
            node,
            revisionId: brief.revisionId,
            briefSha256: brief.sha256,
            // M2: the framing and why it was chosen, so the rotation is visible rather than silent.
            mode: brief.mode,
            modeReason: brief.modeReason,
            // C4: the scope and why, so a delta default is never something the reader has to infer.
            scopeReason: brief.scopeReason,
            // Design §F3: what acting on this brief will cost in re-verification, stated where the decision is made.
            reverificationCost: await reverificationCostFor(root, change),
            ...(since ? { since } : {}),
            // A requested delta that could not be measured is reported as such: the caller is never handed a full brief
            // that quietly pretends to be the narrower pass it asked for.
            ...(brief.delta ? { delta: brief.delta } : {}),
            brief: brief.text,
            // The printed command carries the procedure the skill text states: pass the same --since (kata measures the
            // scope itself) and report the pass's duration, which is the only place that number exists.
            recordCommand: [
                `kata-cli adversarial record --change ${change} --node ${node} --from-file <result.json>`,
                '--elapsed-ms <milliseconds the pass took>',
                '--tool-uses <how many tool calls the pass made>',
            ].join(' '),
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

    if (subcommand === 'note') {
        // K1: one line per batch of work, meant to ride along with a check the pass is already running.
        const fromFile = argValue(rest, '--from-file');
        const { appendProgressLine } = await import('../quality/adversarial-progress.js');
        const raw = fromFile ? await readFile(fromFile, 'utf8') : await readStdin();
        if (!raw.trim()) throw new Error('adversarial note requires a JSON line on stdin or via --from-file');
        let parsed: { hypothesis?: string; method?: string; outcome?: 'refuted' | 'confirmed' | 'inconclusive'; type?: string; findingId?: string; message?: string; toolUses?: number };
        try {
            parsed = JSON.parse(raw) as typeof parsed;
        } catch (error) {
            throw new Error(`adversarial note could not parse the line: ${error instanceof Error ? error.message : String(error)}`);
        }
        const written = await appendProgressLine(root, change, {
            type: parsed.type === 'finding' ? 'finding' : 'attempt',
            at: new Date().toISOString(),
            node,
            ...(parsed.hypothesis ? { hypothesis: parsed.hypothesis } : {}),
            ...(parsed.method ? { method: parsed.method } : {}),
            ...(parsed.outcome ? { outcome: parsed.outcome } : {}),
            ...(parsed.findingId ? { findingId: parsed.findingId } : {}),
            ...(parsed.message ? { message: parsed.message } : {}),
            ...(typeof parsed.toolUses === 'number' ? { toolUses: parsed.toolUses } : {}),
        });
        return { command: 'adversarial note', taskId: change, node, written };
    }

    if (subcommand === 'finding') {
        // K2: a finding lands as it is confirmed, so a crash costs the unfinished tail rather than the finished part.
        const action = rest[0];
        if (action !== 'add') throw new Error('Usage: kata-cli adversarial finding add --change <task-id> --node verify --from-file <finding.json>');
        const fromFile = argValue(rest, '--from-file');
        const { addAdversarialFinding } = await import('../quality/adversarial.js');
        const raw = fromFile ? await readFile(fromFile, 'utf8') : await readStdin();
        if (!raw.trim()) throw new Error('adversarial finding add requires the finding JSON on stdin or via --from-file');
        const finding = await addAdversarialFinding(root, change, node, JSON.parse(raw) as Record<string, unknown>);
        return { command: 'adversarial finding add', taskId: change, node, findingId: finding.id, severity: finding.severity, findings: 'stored on the node record; `record` seals the verdict and the revision binding' };
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
        const binding = await currentRevisionManifest(root, change);
        // The record is bound to the brief kata **issued** (D2). An unissued hash is refused before anything is
        // written: it could never satisfy the gate, and writing it would destroy whatever pass is already recorded.
        const pool = await issuedBriefPool(root, change, node, {
            revisionIds: [binding.revisionId, parsed.revisionId],
            manifestHashes: [binding.manifestHash, parsed.manifestHash],
        });
        const issued = pool.accepted.find((entry) => entry.briefSha256 === parsed.briefSha256) ?? null;
        if (!issued) {
            const reason = parsed.briefSha256 && pool.otherRevision.some((entry) => entry.briefSha256 === parsed.briefSha256)
                ? 'brief_mismatch' as const
                : 'brief_not_issued' as const;
            return {
                command: 'adversarial record',
                taskId: change,
                node,
                recorded: false,
                claimedStatus: parsed.status ?? null,
                gate: { satisfied: false, reason },
                error: `${adversarialReasonFor(reason)} Nothing was recorded, so any earlier pass for this node is untouched.`
                    + ` The hash on the result must be the one \`kata-cli adversarial brief --change ${change} --node ${node}\` reported.`,
            };
        }
        const record = await writeAdversarialRecord(root, change, {
            ...parsed,
            node,
            ...binding,
            // The scope comes from the **brief that was answered**, never from a flag on this command: a delta round's
            // surface was fixed when kata issued it, and re-deriving it here would let the two disagree.
            scope: await scopeForIssuedBrief(root, change, issued),
            // Reported by the executor rather than measured here: the pass happens in another context, and §11 of the
            // design is precisely that nobody had the number.
            ...(argValue(rest, '--elapsed-ms') ? { elapsedMs: Number(argValue(rest, '--elapsed-ms')) } : {}),
            // M2: the framing is the one the *issued* brief carried — the round answered that brief, and the next
            // rotation reads the mode from here. Taken from a flag instead, the record could contradict the brief.
            mode: issued.mode,
            // M3: the turn term alongside the clock, so the two halves of a pass's cost are separable in the record.
            ...(argValue(rest, '--tool-uses') ? { toolUses: Number(argValue(rest, '--tool-uses')) } : {}),
        });
        // C1: a recorded pass's gating findings open (or join) this task's repair batch — the write is where they become
        // known, and it is reached regardless of which refusal the node reports first.
        const { recordPassFindingsForBatching } = await import('../quality/repair-batch.js');
        await recordPassFindingsForBatching(root, change, node, record.findings ?? []).catch(() => null);
        const gate = await adversarialGateFor(root, change, node);
        // `--mode` is accepted but never authoritative: the round answered the issued brief, so a flag that disagrees
        // is reported rather than allowed to misdescribe the round (M2's rotation reads the mode from here).
        const claimedMode = argValue(rest, '--mode');
        const modeConflict = (claimedMode === 'cold' || claimedMode === 'verify') && claimedMode !== issued.mode ? claimedMode : null;
        return {
            command: 'adversarial record',
            taskId: change,
            node,
            status: record.status,
            // The framing and the binding are reported back: both were taken from the issued brief, so a caller can
            // see which round it just recorded rather than infer it.
            mode: record.mode ?? null,
            briefSha256: record.briefSha256 ?? null,
            ...(modeConflict ? { modeNote: `--mode ${modeConflict} was ignored: the issued brief framed this round as ${issued.mode}, and the record follows the brief it answered.` } : {}),
            verdict: record.verdict ?? null,
            findings: (record.findings ?? []).map((finding) => ({ id: finding.id, severity: finding.severity, message: finding.message })),
            ...(parsed.findingOrigins ? { findingOrigins: parsed.findingOrigins } : {}),
            gate: { satisfied: gate.satisfied, reason: gate.reason ?? null },
            ...(gate.satisfied ? {} : { error: adversarialReasonFor(gate.reason) }),
        };
    }

    if (subcommand === 'status') {
        const { progressSummary } = await import('../quality/adversarial-progress.js');
        const progress = await progressSummary(root, change);
        // C1: the repair batch the platform opens and closes on this task's behalf, named here so acting on the user's
        // behalf is never something they have to infer. `batchSaving` counts from the record, not from an estimate.
        const { batchSaving, openBatch } = await import('../quality/repair-batch.js');
        const batch = await openBatch(root, change);
        const saving = await batchSaving(root, change);
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
                scope: record?.scope?.kind ?? null,
                mode: record?.mode ?? null,
                ...(record?.elapsedMs ? { elapsedMs: record.elapsedMs } : {}),
                ...(record?.toolUses ? { toolUses: record.toolUses } : {}),
                ...(await deltaSaving(root, change, candidate, record)),
                blockingFindings: blockingAdversarialFindings(record).length,
                satisfied: gate.satisfied,
                reason: gate.reason ?? null,
            };
        }
        // K1's read side: "is a pass alive, and where is it" must be answerable from outside — the same reason the seal
        // got a heartbeat — and a pass that died mid-way is visible here as lines whose verdict never arrived.
        return {
            command: 'adversarial status',
            taskId: change,
            nodes,
            progress: {
                lines: progress.lines,
                lastAt: progress.lastAt,
                last: progress.last,
            },
            repairBatch: {
                open: batch ? { id: batch.id, openedAt: batch.openedAt, findings: batch.findings.map((finding) => finding.id), baseRevisionId: batch.baseRevisionId ?? null } : null,
                ...saving,
            },
        };
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

/** The sealed revision's id and content hash, for binding a recorded pass to the revision it reviewed. */
/** The scope a pass is judged against: whatever the brief it answered was issued with. */
async function scopeForIssuedBrief(
    root: string,
    taskId: string,
    issued: { since?: string },
): Promise<{ kind: 'full' } | { kind: 'delta'; from: string; changedPaths: string[] }> {
    if (!issued.since) return { kind: 'full' };
    const scope = await currentDeltaScope(root, taskId, issued.since);
    return { kind: 'delta', from: scope.from ?? issued.since, changedPaths: scope.changedPaths ?? [] };
}


async function currentRevisionManifest(root: string, taskId: string): Promise<{ revisionId?: string; manifestHash?: string; codeManifestHash?: string }> {
    const { readCurrentTaskRevision } = await import('../workflow/revision.js');
    const { codeManifestHash } = await import('../quality/code-surface.js');
    const revision = await readCurrentTaskRevision(root, taskId);
    const codeHash = revision ? codeManifestHash(revision) : null;
    return {
        ...(revision ? { revisionId: revision.id } : {}),
        ...(revision?.manifestHash ? { manifestHash: revision.manifestHash } : {}),
        // C2: the code-only identity, stamped beside the full manifest so a text-only re-seal can be recognised later.
        ...(codeHash ? { codeManifestHash: codeHash } : {}),
    };
}
