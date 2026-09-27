import { readFile, writeFile } from 'node:fs/promises';
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
    issuedRunRequest,} from '../quality/adversarial.js';
import { loadEvaluationManifest, persistEvaluationReport, runEvaluation } from '../eval/runner.js';
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
    // **The subject of a disposition must be a finding that exists** (measured): four absences were recorded on this repository
    // under *short* ids — `kgsr14-f1`, which is how a listing renders a finding — while the task's records hold
    // `kgsr14-f1-the-seal-writes-its-record-...`. The ledger accepted all four, the preflight asked by the finding's own id, found
    // none of them, and the seal kept refusing for work that had been done. `falsify` validates every refusal it can measure — a
    // check that did not pass, a defect that did not redden, a tree that did not return — and took its *subject* on trust; a writer
    // whose key is never checked against its reader's vocabulary is the class this line spent a day removing.
    if (change && finding) {
        const { readTrackedFindings } = await import('../quality/finding-disposition.js');
        const known = await readTrackedFindings(process.cwd(), change).catch(() => null);
        if (known && known.length > 0 && !known.some((entry) => entry.id === finding)) {
            const prefixMatches = known.filter((entry) => entry.id.startsWith(finding)).map((entry) => entry.id);
            return {
                command: 'falsify',
                taskId: change,
                success: false,
                error: `No finding in ${change} carries the id '${finding}', so a disposition for it would be written against nothing. `
                    + (prefixMatches.length > 0
                        ? `Did you mean ${prefixMatches.map((id) => `'${id}'`).join(' or ')}?`
                        : `The task's records hold ${known.length} finding(s); the reader that has to be satisfied looks them up by this exact string.`),
            };
        }
    }
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
        // **An absence binds to content too**, and to the content it is *about*: a repair whose subject is a declaration or a
        // document still names the files it concerns, and without digests the record falls back to the revision id — which
        // every later seal replaces, so the three absences on this change stayed open through four seals while the reddenings
        // beside them closed. The surface is **the task's current declaration** (the revision's sealed set when the task
        // declares none) — the same `falsifierProofSurface` the reddening door uses (rba7-f5, rba7-f6). The two doors used
        // to read two different declarations (`task.ownedPaths` here, `revision.pathDigests` there) of the same quantity,
        // which is the class this change exists to remove.
        const { falsifierProofSurface } = await import('../workflow/revision.js');
        // Same binding as the reddening door, and for the same measured reason: the revision a seal mints from this tree carries
        // these digests, so recording anything else makes the recorder and the criterion disagree.
        const absenceSurface = revision
            ? await falsifierProofSurface(workspace, change, revision).catch(() => undefined)
            : undefined;
        const absenceDigests = absenceSurface?.pathDigests;
        const absence = await recordFalsifierAbsence(workspace, change, {
            findingId: finding,
            reason: why,
            revisionId: revision?.id ?? '(no revision)',
            ...(absenceDigests && Object.keys(absenceDigests).length > 0 ? { pathDigests: absenceDigests } : {}),
            recordedAt: new Date().toISOString(),
        });
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
    // **The proof records the content that will be sealed — the working tree — and that is the rule, not an accident.**
    //
    // The criterion compares a disposition's digests against the revision it is being resolved for. The revision a *successful*
    // seal mints is computed from the working tree at the moment of sealing, so a disposition recorded from that same tree
    // matches it by construction. Measured, both ways: `revision-71ed04c4248be3fe` (minted by a seal) has **19 of 19** digests
    // equal to the working tree, while a proof seeded from the *previous* revision's frozen set had **8 of 19** — because 11
    // paths had moved since that revision was sealed.
    //
    // I changed this to the revision's sealed set and it was wrong: it made the recorder and the criterion disagree for exactly
    // the reason the ordering discipline exists. The rule is *record, then seal immediately* — and it is checkable rather than a
    // promise, because both sides compute the same tree.
    let observedTreeDigest: string | undefined;
    let observedDrift: string[] = [];
    let observedPathDigests: Record<string, string> = {};
    if (revision) {
        const { falsifierProofSurface } = await import('../workflow/revision.js');
        const proof = await falsifierProofSurface(root, change!, revision);
        observedDrift = proof.drift;
        observedTreeDigest = proof.treeDigest;
        observedPathDigests = proof.pathDigests;
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
        pathDigests: observedPathDigests,
        at: new Date().toISOString(),
        run: async (command) => {
            const { runProcess } = await import('../process/run.js');
            const outcome = await runProcess('bash', ['-lc', command], { cwd: root });
            return outcome.exitCode;
        },
    });
    return { command: 'falsify', taskId: change, success: result.recorded, ...result };
}
