import { readFile, writeFile } from 'node:fs/promises';
import { requiredCapabilitiesForNode, unmeasuredTelemetry, type ExecutionNode } from '../quality/review-execution.js';
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
    persistAdversarialBrief,
    prepareAdversarialCertification,
    issuedBriefPool,
    readAdversarialRecord,
    writeAdversarialRecord,
    type AdversarialNode,
    type AdversarialRecord,
    type AdversarialBriefScope,
    adversarialNodes,
} from '../quality/adversarial.js';
import { loadEvaluationManifest, persistEvaluationReport, runEvaluation } from '../eval/runner.js';
import { deriveVerdict, type ReviewState } from '../quality/review-state.js';
import { isTerminalSeverity } from '../quality/finding-lifecycle.js';
import { runProcess, runProcessSync } from '../process/run.js';

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
 * §3.2.2 retired caller-stated telemetry, and it is one fact in two encodings.
 *
 * The retirement was written against `argv` only, so the same duration typed into a result line JSON body was still
 * accepted and written into the progress record — measured, then reproduced as a failing test. A second encoding of the
 * same self-report is the same defect, so the names and the remedy come from one place and both channels refuse them.
 */
export const RETIRED_TELEMETRY_FLAGS = ['--elapsed-ms', '--tool-uses'] as const;
export const RETIRED_TELEMETRY_FIELDS = ['elapsedMs', 'toolUses'] as const;
const TELEMETRY_RETIREMENT_REMEDY =
    'telemetry is reported by the execution receipt, which binds to the issued request and cannot be typed in. Record the receipt instead of a duration, or leave telemetry unreported.';

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
        // K2: the request is the contract a host answers. Emitting it here means a host never has to read kata's private
        // state to obtain one — and what it gets is the very object the gate will verify against, not a re-derivation.
        const emitRequest = argValue(rest, '--emit-request');
        const requestedMode = argValue(rest, '--mode');
        // Issued, not merely rendered: this is the copy the recorded pass will be bound to (D2, second fix).
        const prepared = await prepareAdversarialCertification(root, change, node, {
            ...(since ? { since } : {}),
            ...(requestedMode === 'cold' || requestedMode === 'verify' ? { mode: requestedMode } : {}),
        });
        if (prepared.kind === 'reuse') {
            return {
                command: 'adversarial brief',
                taskId: change,
                node,
                certification: 'reused',
                priorBriefSha256: prepared.priorBriefSha256,
                reCertification: prepared.decision,
                ...(emitRequest
                    ? {
                        emittedRequest: false,
                        note: 'No request was emitted: reuse issues no new brief, so there is no new run to bind. The prior '
                            + 'certification still applies; a fresh pass needs a changed surface.',
                    }
                    : { note: 'No formal brief issued: the planner mechanically proved the prior certification still applies.' }),
            };
        }
        const brief = await persistAdversarialBrief(root, change, node, prepared.brief);
        if (emitRequest) {
            if (!brief.runRequest) {
                return {
                    command: 'adversarial brief', taskId: change, node, emittedRequest: false,
                    error: 'The issued brief carries no run request, so there is nothing to emit.',
                };
            }
            // The packet a round is run from: the request, and **verbatim** the brief it names. Emitting the request
            // alone left a host unable to feed the session the material its own `briefSha256` refers to, which made
            // reading kata's private state the only alternative — the dependency K2 exists to remove.
            await writeFile(
                emitRequest,
                `${JSON.stringify({ request: brief.runRequest, brief: { sha256: brief.sha256, text: brief.text } }, null, 2)}\n`,
                'utf8',
            );
        }
        const { reverificationCostFor } = await import('../quality/adversarial.js');
        return {
            command: 'adversarial brief',
            taskId: change,
            node,
            revisionId: brief.revisionId,
            briefSha256: brief.sha256,
            ...(prepared.decision ? { reCertification: prepared.decision } : {}),
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
            // The printed command carries the procedure the skill text states. The duration flags are gone from it:
            // telemetry arrives on the receipt (§3.2.2), so a caller who copies this line records the pass without
            // hand-typing a number the platform cannot check.
            recordCommand: [
                `kata-cli adversarial record --change ${change} --node ${node} --from-file <result.json>`,
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
        let parsed: { hypothesis?: string; method?: string; outcome?: 'refuted' | 'confirmed' | 'inconclusive'; type?: string; findingId?: string; message?: string };
        try {
            parsed = JSON.parse(raw) as typeof parsed;
        } catch (error) {
            throw new Error(`adversarial note could not parse the line: ${error instanceof Error ? error.message : String(error)}`);
        }
        // The same fact, through the other channel: a duration typed into the line body is the self-report the
        // receipt replaced. Refused rather than dropped, for the reason stated at the argv check above.
        const typedTelemetry = RETIRED_TELEMETRY_FIELDS.filter((field) => (parsed as Record<string, unknown>)[field] !== undefined);
        if (typedTelemetry.length > 0) {
            return {
                command: 'adversarial note',
                taskId: change,
                node,
                status: 'refused',
                error: `${typedTelemetry.join(' and ')} ${typedTelemetry.length > 1 ? 'are' : 'is'} retired: ${TELEMETRY_RETIREMENT_REMEDY}`,
            };
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
        });
        return { command: 'adversarial note', taskId: change, node, written };
    }

    if (subcommand === 'finding') {
        // K2: a finding lands as it is confirmed, so a crash costs the unfinished tail rather than the finished part.
        const action = rest[0];
        if (action !== 'add') throw new Error('Usage: kata-cli adversarial finding add --change <task-id> --node verify --from-file <finding.json>');
        // The task id comes from the flag, not from the positional helper: `rest` still begins with the `add` action word
        // here, and `parseChangeArg` returns the first non-flag token — so the documented invocation resolved the task id
        // to `add` and died with `ENOENT: .kata/tasks/add/adversarial-review.json`. The shape the docs and the generated
        // Skills use is `--change <id>`, so that is what is read.
        const addressed = argValue(rest, '--change');
        if (!addressed) {
            throw new Error('Usage: kata-cli adversarial finding add --change <task-id> --node verify|review --from-file <finding.json>');
        }
        const fromFile = argValue(rest, '--from-file');
        const { addAdversarialFinding } = await import('../quality/adversarial.js');
        const raw = fromFile ? await readFile(fromFile, 'utf8') : await readStdin();
        if (!raw.trim()) throw new Error('adversarial finding add requires the finding JSON on stdin or via --from-file');
        const finding = await addAdversarialFinding(root, addressed, node, JSON.parse(raw) as Record<string, unknown>);
        // `addressed`, not `change`: the latter is the positional read, which for this subcommand is the action word.
        return { command: 'adversarial finding add', taskId: addressed, node, findingId: finding.id, severity: finding.severity, findings: 'stored on the node record; `record` seals the verdict and the revision binding' };
    }

    if (subcommand === 'execute') {
        // Option A: kata runs a **declared** command and validates the receipt it writes. Kata does not decide how a
        // session is isolated — the command does — and that is what keeps a change to kata from loosening the envelope it
        // certifies. This entry point is therefore shaped like the one that runs a declared check: an opaque command, a
        // result read back, nothing decided here about flags, tools or models.
        const packetPath = argValue(rest, '--packet');
        const executor = argValue(rest, '--executor');
        const receiptOut = argValue(rest, '--receipt-out');
        if (!packetPath) {
            throw new Error('Usage: kata-cli adversarial execute --change <task-id> --node review --packet <packet.json> --executor "<command>" [--receipt-out <path>]');
        }
        if (!executor?.trim()) {
            return {
                command: 'adversarial execute', taskId: change, node, status: 'refused',
                error: 'No executor command was declared. Pass --executor "<command>": kata runs a declared command and '
                    + 'reads the receipt it writes, and it does not decide how a session is isolated.',
            };
        }

        const packetRaw = await readFile(packetPath, 'utf8').catch(() => null);
        if (packetRaw === null) {
            return { command: 'adversarial execute', taskId: change, node, status: 'refused', error: `--packet could not be read: ${packetPath}. Nothing was run.` };
        }
        let packet: { request?: { runId?: string; requestSha256?: string; briefSha256?: string; requiredCapabilities?: string[]; budget?: { maxWallMs?: number } }; brief?: { sha256?: string; text?: string } };
        try {
            packet = JSON.parse(packetRaw) as typeof packet;
        } catch (error) {
            return { command: 'adversarial execute', taskId: change, node, status: 'refused', error: `--packet is not JSON: ${error instanceof Error ? error.message : String(error)}. Nothing was run.` };
        }
        const request = packet.request;
        if (!request?.runId || !request.requestSha256) {
            return { command: 'adversarial execute', taskId: change, node, status: 'refused', error: 'The packet carries no request, so there is nothing to bind a receipt to. Nothing was run.' };
        }
        // The same binding the executor refuses on, checked here too: a packet whose halves disagree cannot be run by
        // anyone, and saying so before launching a session is cheaper than saying it after.
        if (packet.brief?.sha256 !== request.briefSha256) {
            return {
                command: 'adversarial execute', taskId: change, node, status: 'refused', reason: 'packet_unbound',
                error: `The packet's brief does not bind to its request: brief.sha256 is ${packet.brief?.sha256}, request.briefSha256 is ${request.briefSha256}. Nothing was run.`,
            };
        }

        const out = receiptOut ?? `${packetPath.replace(/\.json$/, '')}.receipt.json`;
        const run = await runProcess('sh', ['-c', executor], {
            cwd: root,
            env: { ...process.env, KATA_REVIEW_PACKET: packetPath, KATA_REVIEW_RECEIPT: out },
            ...(request.budget?.maxWallMs ? { timeoutMs: request.budget.maxWallMs + 30_000 } : {}),
        });

        const receiptRaw = await readFile(out, 'utf8').catch(() => null);
        if (receiptRaw === null) {
            return {
                command: 'adversarial execute', taskId: change, node, status: 'executor_unavailable', receiptPath: out,
                error: `The declared executor wrote no receipt at ${out} (exit ${run.exitCode}). A round that produced no receipt is not a round: kata does not write one on the executor's behalf. ${run.stderr.trim()}`,
            };
        }
        let receipt: { runId?: string; requestSha256?: string; capabilities?: string[]; status?: string };
        try {
            receipt = JSON.parse(receiptRaw) as typeof receipt;
        } catch (error) {
            return { command: 'adversarial execute', taskId: change, node, status: 'executor_unavailable', receiptPath: out, error: `The receipt at ${out} is not JSON: ${error instanceof Error ? error.message : String(error)}.` };
        }
        if (receipt.runId !== request.runId || receipt.requestSha256 !== request.requestSha256) {
            return {
                command: 'adversarial execute', taskId: change, node, status: 'refused', reason: 'receipt_unbound', receiptPath: out,
                error: 'The receipt does not bind to the issued request: its runId or requestSha256 names a different round.',
            };
        }
        const missing = (request.requiredCapabilities ?? []).filter((capability) => !(receipt.capabilities ?? []).includes(capability));
        if (missing.length > 0) {
            return {
                command: 'adversarial execute', taskId: change, node, status: 'refused', reason: 'capability_missing', receiptPath: out,
                error: `The receipt does not advertise ${missing.join(', ')}, which this node requires. Recorded telemetry does not stand in for a capability the host did not provide.`,
            };
        }

        return {
            command: 'adversarial execute', taskId: change, node, status: 'executed', receiptPath: out,
            receiptStatus: receipt.status ?? null,
            capabilities: receipt.capabilities ?? [],
            note: `Record it with: kata-cli adversarial record --change ${change} --node ${node} --from-file <result.json> --receipt-file ${out}`,
        };
    }

    if (subcommand === 'record') {
        // §3.2.2: refused rather than ignored. A flag that is accepted and silently dropped teaches the caller that
        // telemetry can be typed in, which is the belief this retirement exists to end.
        const retiredFlags = RETIRED_TELEMETRY_FLAGS.filter((flag) => rest.includes(flag));
        if (retiredFlags.length > 0) {
            return {
                command: 'adversarial record',
                taskId: change,
                node,
                recorded: false,
                status: 'refused',
                error: `${retiredFlags.join(' and ')} ${retiredFlags.length > 1 ? 'are' : 'is'} retired: ${TELEMETRY_RETIREMENT_REMEDY}`,
            };
        }
        const fromFile = argValue(rest, '--from-file');
        const raw = fromFile ? await readFile(fromFile, 'utf8') : await readStdin();
        if (!raw.trim()) throw new Error('adversarial record requires the result JSON on stdin or via --from-file');
        let parsed: AdversarialRecord;
        try {
            parsed = JSON.parse(raw) as AdversarialRecord;
        } catch (error) {
            throw new Error(`adversarial record could not parse the result: ${error instanceof Error ? error.message : String(error)}`);
        }
        // K1: the receipt schema says it is written by the host and never by the reviewer. The write path enforced only
        // *which round* a receipt binds to, so a receipt inside the reviewer's own result body was accepted — measured.
        // Unforgeability comes from not being able to write it in, not from not being able to guess the nonce.
        const receiptFile = argValue(rest, '--receipt-file');
        if ((parsed as unknown as Record<string, unknown>).executedBy !== undefined) {
            return {
                command: 'adversarial record', taskId: change, node, recorded: false, status: 'refused',
                error: 'The result body may not carry executedBy: provenance is recorded from the execution receipt, not '
                    + 'written by the party being reviewed. Nothing was recorded.',
            };
        }
        if ((parsed as unknown as Record<string, unknown>).receipt !== undefined) {
            return {
                command: 'adversarial record',
                taskId: change,
                node,
                recorded: false,
                status: 'refused',
                error: 'The result body may not carry a receipt: a receipt inside the reviewer\'s own result file is the '
                    + `reviewer writing its own provenance. Pass it on its own channel instead: kata-cli adversarial record `
                    + `--change ${change} --node ${node} --from-file <result.json> --receipt-file <receipt.json>. Nothing was recorded.`,
            };
        }
        let fileReceipt: unknown;
        let executorPlatform: string | undefined;
        if (receiptFile) {
            const receiptRaw = await readFile(receiptFile, 'utf8').catch(() => null);
            if (receiptRaw === null) {
                return {
                    command: 'adversarial record', taskId: change, node, recorded: false, status: 'refused',
                    error: `--receipt-file could not be read: ${receiptFile}. Nothing was recorded.`,
                };
            }
            try {
                fileReceipt = JSON.parse(receiptRaw);
                const provenance = (fileReceipt as { executor?: { platform?: string } }).executor;
                if (provenance?.platform) executorPlatform = provenance.platform;
            } catch (error) {
                return {
                    command: 'adversarial record', taskId: change, node, recorded: false, status: 'refused',
                    error: `--receipt-file is not JSON: ${error instanceof Error ? error.message : String(error)}. Nothing was recorded.`,
                };
            }
        }
        const binding = await currentRevisionManifest(root, change, node);
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
            ...(fileReceipt !== undefined ? { receipt: fileReceipt as AdversarialRecord['receipt'] } : {}),
            // K5's open item: the field that implied provenance and had no producer. It is filled from the receipt — a real
            // source — and the gate does not read it, because platform is provenance and capability is the contract.
            ...(executorPlatform ? { executedBy: executorPlatform } : {}),
            node,
            ...binding,
            // The scope comes from the **brief that was answered**, never from a flag on this command: a delta round's
            // surface was fixed when kata issued it, and re-deriving it here would let the two disagree.
            scope: await scopeForIssuedBrief(issued),
            // §3.2.2: telemetry comes from the receipt, never from the caller. `--elapsed-ms` was retired because a
            // number typed here is an assertion about itself — the same reason `executedInFreshContext` stopped being a
            // proof. The receipt reports what the CLI could not observe, so it is the only telemetry source that means
            // anything. The *field* stays on the schema: past records carry it, and reporting is not a conclusion.
            // M2: the framing is the one the *issued* brief carried — the round answered that brief, and the next
            // rotation reads the mode from here. Taken from a flag instead, the record could contradict the brief.
            mode: issued.mode,
            // M3: the turn term arrives the same way, for the same reason.
        });
        // C1: a recorded pass's gating findings open (or join) this task's repair batch — the write is where they become
        // known, and it is reached regardless of which refusal the node reports first.
        const { recordPassFindingsForBatching } = await import('../quality/repair-batch.js');
        await recordPassFindingsForBatching(root, change, node, record.findings ?? []).catch(() => null);
        // The batch the line above opens has to be closable, and closure reads `answered` from resolved obligations — so a
        // terminal finding recorded in a verdict needs an obligation too. Without this the batch opened here held a finding
        // nothing could ever answer, which is the same gap as the pass's `finding add` path had.
        const { persistBlockingFindings } = await import('../quality/repair-obligations.js');
        for (const finding of record.findings ?? []) {
            if (!isTerminalSeverity(finding.severity)) continue;
            await persistBlockingFindings(root, change, [{
                id: finding.id,
                severity: finding.severity,
                message: finding.message,
            }]).catch(() => null);
        }
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
            // §4 Phase 1: the verdict is **derived**, so this reports what kata computed from the hypotheses rather than
            // echoing a field the caller wrote. Null when the record carries no judgement basis (a pre-§3.1 record), which
            // is the honest answer — it is not "no defect found", it is "reached by a shape the predicate cannot read".
            verdict: derivedVerdictFor(record),
            findings: (record.findings ?? []).map((finding) => ({ id: finding.id, severity: finding.severity, message: finding.message })),
            ...(parsed.findingOrigins ? { findingOrigins: parsed.findingOrigins } : {}),
            gate: { satisfied: gate.satisfied, reason: gate.reason ?? null },
            ...(gate.satisfied ? {} : { error: adversarialReasonFor(gate.reason, gate.detail) }),
        };
    }

    if (subcommand === 'status') {
        const { progressSummary } = await import('../quality/adversarial-progress.js');
        const progress = await progressSummary(root, change);
        // AC-4 promises a routed finding is visible in this command, so the dispositions come from the tracked view — the
        // same one the disposition commands write through, so the report cannot disagree with what they stored.
        const { readTrackedFindings } = await import('../quality/finding-disposition.js');
        // AC-3: an obligation answered by evidence and one answered **and falsified** were indistinguishable, so a batch that
        // closed on evidence alone read exactly like one whose repairs were shown to bite. Reported per obligation, from the
        // same ledger the criterion reads — and a change sealed before the criterion existed shows up here as evidence-only
        // rather than silently, which is the reason this criterion is not optional.
        const { readObligations } = await import('../quality/repair-obligations.js');
        const { readFalsifierReddenings, hasReddening } = await import('../quality/falsifier-reddenings.js');
        const obligations = await readObligations(root, change).catch(() => []);
        const reddenings = await readFalsifierReddenings(root, change).catch(() => []);
        // The same predicate the criterion applies, narrowing included: a report computed with a weaker rule can disagree
        // with the rule it reports on (cg3-f4).
        const { readCurrentTaskRevision } = await import('../workflow/revision.js');
        const currentRevisionId = (await readCurrentTaskRevision(root, change).catch(() => null))?.id;
        const trackedForStatus = await readTrackedFindings(root, change).catch(() => [] as Array<{ id: string; severity: string; source: string; disposition: string; dispositionReason?: string }>);
        // C1: the repair batch the platform opens and closes on this task's behalf, named here so acting on the user's
        // behalf is never something they have to infer. `batchSaving` counts from the record, not from an estimate.
        const { batchSaving, openBatch } = await import('../quality/repair-batch.js');
        const batch = await openBatch(root, change);
        const saving = await batchSaving(root, change);
        const nodes: Record<string, unknown> = {};
        for (const candidate of adversarialNodes) {
            const record = await readAdversarialRecord(root, change, candidate);
            const gate = await adversarialGateFor(root, change, candidate);
            const requiredForNode = requiredCapabilitiesForNode(candidate as ExecutionNode);
            const missing = record?.receipt
                ? requiredForNode.filter((capability) => !record.receipt!.capabilities.includes(capability))
                : [];
            nodes[candidate] = {
                recorded: record !== null,
                status: record?.status ?? null,
                revisionId: record?.revisionId ?? null,
                // Derived, like the line above: §3.1 makes the conclusion Kata's, so a report must not re-expose the
                // retired field even for a record that still carries one.
                verdict: record ? derivedVerdictFor(record) : null,
                executedInFreshContext: record?.executedInFreshContext ?? null,
                scope: record?.scope?.kind ?? null,
                mode: record?.mode ?? null,
                ...(record?.elapsedMs ? { elapsedMs: record.elapsedMs } : {}),
                ...(record?.toolUses ? { toolUses: record.toolUses } : {}),
                ...(await deltaSaving(root, change, candidate, record)),
                blockingFindings: blockingAdversarialFindings(record).length,
                // K3: a strict node that cannot be certified used to show only `satisfied: false`, so an operator could
                // not tell "the host cannot do this" from "the pass was bad" — and the legacy path Phase 4 requires to be
                // *visible and reasoned* was invisible. Answerable from this command alone: can this host certify this
                // node, and if not, what is missing.
                requiredCapabilities: requiredCapabilitiesForNode(candidate as ExecutionNode),
                receipt: record?.receipt ? 'recorded' as const : 'absent' as const,
                ...(record?.receipt ? { capabilities: record.receipt.capabilities } : {}),
                // b1's consumer: which figures the platform actually reported. Without this, an unmeasured field and a
                // measured zero read alike, and the operator cannot tell a measured round from a partially reported one.
                ...(record?.receipt ? { unmeasuredTelemetry: unmeasuredTelemetry(record.receipt.telemetry) } : {}),
                ...(record?.executedBy ? { executedBy: record.executedBy } : {}),
                // A relaying route — which is what a subagent round is — should record where it ran, because its figures
                // passed through a session. Reported here rather than required: the gate owns what is required.
                ...(record?.receipt && !record.receipt.executor ? { provenanceMissing: true } : {}),
                ...(missing.length > 0 ? { missingCapabilities: missing } : {}),
                path: record?.status === 'waived'
                    ? { kind: 'waived' as const, reason: record.waivedReason ?? null }
                    : record?.receipt
                        ? { kind: 'receipt' as const }
                        : { kind: 'legacy' as const, note: 'no execution receipt: this node is certified by the agent\'s own report, which is what a receipt replaces' },
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
            // AC-4's "is visible in adversarial status", which was **untrue** when the criterion was certified: the command
            // reported nodes, progress and the open batch's finding ids, and never a finding's disposition — so a routed
            // finding's disposition and the change carrying it were invisible exactly where the criterion promised them.
            // Reported from the tracked view, which is the one the disposition commands write through.
            obligations: obligations.map((obligation) => ({
                id: obligation.id,
                findingId: obligation.findingId ?? null,
                acceptanceId: obligation.acceptanceId ?? null,
                resolvedAt: obligation.resolvedAt ?? null,
                // The distinction AC-3 exists for. `null` when unresolved, because "not answered" and "answered one way" are
                // different facts and a default would erase it.
                answeredBy: obligation.resolvedAt
                    ? obligation.findingId
                        ? (hasReddening(reddenings, obligation.findingId, currentRevisionId) ? 'evidence-and-falsifier' : 'evidence-only')
                        : 'evidence'
                    : null,
            })),
            findings: trackedForStatus.map((finding) => ({
                id: finding.id,
                severity: finding.severity,
                source: finding.source,
                disposition: finding.disposition,
                // The carrier, for a routed finding: 'routed' without a destination does not answer "where did it go".
                ...(finding.dispositionReason ? { dispositionReason: finding.dispositionReason } : {}),
            })),
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

/** The sealed revision's id and content hash, for binding a recorded pass to the revision it reviewed. */
/** The scope a pass is judged against: whatever the brief it answered was issued with. */
async function scopeForIssuedBrief(
    issued: { scope?: AdversarialBriefScope; since?: string },
): Promise<AdversarialBriefScope> {
    if (issued.scope) return issued.scope;
    // A legacy delta brief did not persist its measured paths. Refuse unsafe reuse by preserving its delta claim with no
    // coverage, so the existing delta gate fails closed instead of silently widening it to a full pass.
    return issued.since
        ? { kind: 'delta', from: issued.since, changedPaths: [] }
        : { kind: 'full' };
}


function derivedVerdictFor(record: { hypotheses?: unknown } | null | undefined): string | null {
    const hypotheses = record?.hypotheses;
    if (!Array.isArray(hypotheses) || hypotheses.length === 0) return null;
    // The verdict implied by the hypotheses alone, from the **same exported derivation** the gate starts from. Coverage
    // and grounding are predicates against a revision the CLI does not hold here, so the gate applies those on top; what
    // this must not do is apply its own weaker rule, which is how `outcome: confirmed` came to be reported as
    // `no_defect_found` (R7).
    return deriveVerdict({
        coverage: [],
        hypotheses: hypotheses as ReviewState['hypotheses'],
        findings: ((record as { findings?: ReviewState['findings'] }).findings ?? []),
    });
}
async function currentRevisionManifest(
    root: string,
    taskId: string,
    node?: AdversarialNode,
): Promise<{ revisionId?: string; manifestHash?: string; codeManifestHash?: string; candidateFreezeSha256?: string }> {
    const { readCurrentTaskRevision } = await import('../workflow/revision.js');
    const { codeManifestHash } = await import('../quality/code-surface.js');
    const revision = await readCurrentTaskRevision(root, taskId);
    const codeHash = revision ? codeManifestHash(revision) : null;
    // §7.4: the freeze travels with the record, so a later certification is compared against the candidate it answered
    // rather than against a revision id that moves on every re-seal.
    const { candidateFreezeHashFor } = await import('../quality/adversarial.js');
    const freeze = node ? await candidateFreezeHashFor(root, taskId, node).catch(() => undefined) : undefined;
    return {
        ...(revision ? { revisionId: revision.id } : {}),
        ...(revision?.manifestHash ? { manifestHash: revision.manifestHash } : {}),
        // C2: the code-only identity, stamped beside the full manifest so a text-only re-seal can be recognised later.
        ...(codeHash ? { codeManifestHash: codeHash } : {}),
        ...(freeze ? { candidateFreezeSha256: freeze } : {}),
    };
}

/**
 * `kata-cli falsify` — the CLI entry for closure-gate's producer.
 *
 * It exists so the chain is closed: a repair runs the check, re-introduces the defect, watches it redden, restores, and the
 * fact is recorded — which is what the closure criterion now requires before a finding-shaped obligation can be answered.
 * Without this entry the producer was reachable only from a test, which is the "mechanism with no consumer" class this line
 * keeps finding.
 *
 * Every refusal is a reason rather than a silent failure, and nothing is recorded unless all three steps behaved: a check that
 * does not pass first, does not redden under the mutation, or does not come back after the restore leaves the ledger empty.
 */
function valueAfter(argv: string[], flag: string): string | undefined {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
}

export async function runFalsifyCommand(argv: string[]): Promise<Record<string, unknown>> {
    const change = valueAfter(argv, '--change');
    const finding = valueAfter(argv, '--finding');
    const none = argv.includes('--none');
    const why = valueAfter(argv, '--reason');
    const check = valueAfter(argv, '--check');
    const mutation = valueAfter(argv, '--mutation');
    const restore = valueAfter(argv, '--restore');
    // A repair whose subject is not code has no check that can redden, so its disposition is a **recorded absence with a
    // reason** — a fact written by this command rather than an exception the repair grants itself (cg3-f1, cg3-f3).
    if (none) {
        if (!change || !finding || !why?.trim()) {
            return { command: 'falsify', success: false, error: '--none needs --change, --finding and --reason: the absence is recorded so it can be audited, not so it can be claimed.' };
        }
        const workspace = process.cwd();
        const { readCurrentTaskRevision: readRevision } = await import('../workflow/revision.js');
        const { recordFalsifierAbsence } = await import('../quality/falsifier-reddenings.js');
        const revision = await readRevision(workspace, change).catch(() => null);
        const absence = await recordFalsifierAbsence(workspace, change, { findingId: finding, reason: why, revisionId: revision?.id ?? '(no revision)', recordedAt: new Date().toISOString() });
        return { command: 'falsify', taskId: change, success: true, recorded: true, absence };
    }
    const missing = [
        ['--change', change], ['--finding', finding], ['--check', check], ['--mutation', mutation], ['--restore', restore],
    ].filter(([, value]) => !value).map(([flag]) => flag as string);
    if (missing.length > 0) {
        return {
            command: 'falsify',
            success: false,
            error: `falsify needs ${missing.join(', ')}. The mutation and its restore are declared because re-introducing a defect is knowledge only the repairer has; the tool runs them and records what it saw.`,
        };
    }

    const root = process.cwd();
    const { readCurrentTaskRevision } = await import('../workflow/revision.js');
    const { runFalsification } = await import('../quality/falsifier-run.js');
    const revision = await readCurrentTaskRevision(root, change!).catch(() => null);
    // **The tree has to be what the revision describes.** A proof is about content: binding it to the last sealed revision
    // while the working tree has moved on records a fact about something that no longer exists, and the next seal mints a
    // different revision and invalidates it — which is exactly how four proofs were lost this round. Refusing here is the
    // difference between a proof and a claim about a proof.
    // **The drift is recorded, not refused**, and the change is measured rather than argued.
    //
    // The guard's purpose is real: a proof is about content, and one recorded against a tree that has moved on is a claim about
    // something that no longer exists. But refusing here made the sequence unreachable — the seal refuses while an obligation
    // lacks a disposition, the proof refused while the tree was not what the sealed revision described, and the seal is what
    // would make the tree match. Measured: `cg5-f2` could not be proved at all in that state, while `cg5-f1`'s absence went
    // through because the absence path has no guard — the same defect one door over, in the fix written for it.
    //
    // And the guard's own claim was weaker than its message: it compared digests over the revision's **owned** paths only, so a
    // change outside ownership was invisible while the message said "the working tree is not what the revision describes"
    // (`cg4-f2`, confirmed by the tool refusing over six paths that did not include the one I had edited).
    //
    // So the fact travels with the proof instead: `observedTreeDigest` is what the tree was when the three steps ran, and the
    // reader can see whether it still matches. Detection rather than prevention is the honest shape here, because prevention
    // cannot be reached when the proof is what the seal needs.
    let observedTreeDigest: string | undefined;
    let observedDrift: string[] = [];
    if (revision) {
        const { computePathDigests } = await import('../workflow/revision.js');
        const sealed = revision.pathDigests ?? {};
        const current = await computePathDigests(root, Object.keys(sealed));
        observedDrift = Object.keys(sealed).filter((path) => current[path] !== sealed[path]);
        observedTreeDigest = Object.keys(sealed).sort()
            .map((path) => `${path}:${current[path] ?? ''}`)
            .join('\n');
    }

    const result = await runFalsification({
        root,
        taskId: change!,
        findingId: finding!,
        check: check!,
        mutation: mutation!,
        restore: restore!,
        revisionId: revision?.id ?? '(no revision)',
        observedTreeDigest,
        observedDrift,
        at: new Date().toISOString(),
        run: async (command) => {
            const { runProcess } = await import('../process/run.js');
            const outcome = await runProcess('bash', ['-lc', command], { cwd: root });
            return outcome.exitCode;
        },
    });
    return { command: 'falsify', taskId: change, success: result.recorded, ...result };
}
