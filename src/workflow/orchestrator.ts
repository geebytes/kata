import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createTask, type CreateTaskInput } from '../core/task.js';
import { appendStateEvent, transition, writeCurrentState, type Phase, type Actor } from '../core/state.js';
import { buildContextManifest, type ContextManifest } from '../core/context.js';
import { checkFreshness, collectEvidence, computeDiffHash, type CheckCommand, type EvidenceEnvelope } from '../quality/evidence.js';
import { type ReviewFinding } from '../quality/reviewer.js';
import { judge, type JudgeAcceptanceResult, type JudgeResult } from '../quality/judge.js';
import { createHandoff } from './handoff.js';
import { CometGuard } from '../comet/guard.js';
import { assertValidTaskId } from '../core/ids.js';
import { loadConfig } from '../core/config.js';
import { resolveBuildChecks } from '../quality/project-checks.js';
import { acknowledgeCometOpen, defaultWorkflowProfile, isWorkflowProfile, type WorkflowProfile } from '../core/workflow-profile.js';
import { ensureWikiClosure, evaluateWikiClosure } from '../wiki/closure.js';
import { distillPassedTaskKnowledge } from '../wiki/provenance.js';
import { nextActionForTask } from './navigation.js';
import { computeManifestHash, createTaskRevision, findOwnershipConflicts, inferOwnedPathsFromWorkspace, readCurrentTaskRevision, readTaskRevision, revisionStatus, workspaceDrift } from './revision.js';
import { classifyCodeGraphCandidates, discoverCodeGraphCandidates, readWaivers, validateMatrix, validatePathCoverage, validateWaivers, writeWaivers, requiresMatrix, getMatrixRowForAc, evidenceMatchesRow, type CodeGraphCandidate, type CodeGraphCandidateDisposition, type Waiver } from '../quality/acceptance-matrix.js';
import { readObligations, hasUnresolvedObligations, persistBlockingFindings, persistBlockingJudgeResult, resolveObligationsForRevision } from '../quality/repair-obligations.js';
import type { CheckProgressEvent } from '../quality/evidence.js';

export type KataCommand = 'open' | 'design' | 'build' | 'review' | 'judge' | 'verify' | 'archive' | 'hotfix' | 'tweak';

export interface CommandResult {
  command: KataCommand;
  taskId: string;
  phase: Phase;
  success: boolean;
  diagnostics?: Record<string, unknown>;
  error?: string;
}

const defaultActor: Actor = { id: 'kata-agent', role: 'implementer' };
const reviewerActor: Actor = { id: 'kata-reviewer', role: 'reviewer' };
const judgeActor: Actor = { id: 'kata-judge', role: 'judge' };

export interface CommandOptions {
  title?: string;
  acceptance?: Array<{ id?: string; statement: string }>;
  checks?: CheckCommand[];
  guard?: CometGuard;
  platform?: string;
  seal?: boolean;
  approve?: boolean;
  reviewEvidence?: string;
  confirmHostModel?: boolean;
  allowOwnershipConflicts?: boolean;
  workflowProfile?: WorkflowProfile;
  ownedPaths?: string[];
  waivers?: Waiver[];
  signal?: AbortSignal;
  onProgress?: (event: CheckProgressEvent) => void;
}

function actorFor(actor: Actor, platform?: string): Actor {
  return platform ? { ...actor, platform } : actor;
}

async function guardTransition(
  guard: CometGuard | undefined,
  action: 'check' | 'apply',
  taskId: string,
  phase: string,
): Promise<void> {
  if (!guard) return;
  const result = await guard[action](taskId, phase);
  if (action === 'check' && !result.passed) {
    throw new Error(`Guard ${action} failed for ${phase}: ${result.reason ?? 'guard rejected'}`);
  }
}

export async function runCommand(
  command: KataCommand,
  taskId: string,
  root: string,
  options: CommandOptions = {},
): Promise<CommandResult> {
  assertValidTaskId(taskId);
  switch (command) {
    case 'open':
      return cmdOpen(taskId, root, options);
    case 'design':
      return cmdDesign(taskId, root, options);
    case 'build':
      return cmdBuild(taskId, root, options);
    case 'review':
      return cmdReview(taskId, root, options);
    case 'judge':
      return cmdJudge(taskId, root, options);
    case 'verify':
      return cmdVerify(taskId, root, options);
    case 'archive':
      return cmdArchive(taskId, root, options);
    case 'hotfix':
      return cmdHotfix(taskId, root, options);
    case 'tweak':
      return cmdTweak(taskId, root, options);
    default:
      return { command, taskId, phase: 'intake', success: false, error: `Unknown command: ${command}` };
  }
}

async function cmdOpen(
  taskId: string,
  root: string,
  options: CommandOptions = {},
): Promise<CommandResult> {
  const input: CreateTaskInput = {
    root,
    id: taskId,
    title: options.title ?? `Change ${taskId}`,
    acceptance: options.acceptance ?? [{ statement: 'Implement the change successfully.' }],
    workflowProfile: options.workflowProfile ?? defaultWorkflowProfile(),
    ...(options.ownedPaths?.length ? { ownedPaths: options.ownedPaths } : {}),
  };

  const task = await createTask(input);
  let context: ContextManifest;
  try {
    context = await buildContextManifest({ root, taskId, sourceRefs: [] });
  } catch {
    context = { taskId, sourceRefs: [], authoritativeWiki: [], excludedWiki: [], warnings: [] };
  }

  const ownershipConflicts = options.ownedPaths?.length
    ? await findOwnershipConflicts(root, taskId, options.ownedPaths)
    : [];
  const warnings = [
    ...context.warnings,
    ...(ownershipConflicts.length > 0 ? [`Ownership conflicts detected: ${ownershipConflicts.map((c) => `${c.taskId}:${c.path}`).join(', ')}`] : []),
  ];

  return {
    command: 'open',
    taskId: task.id,
    phase: 'intake',
    success: true,
    diagnostics: {
      acceptanceCount: task.acceptance.length,
      authoritativeWikiCount: context.authoritativeWiki.length,
      warnings,
      ...(ownershipConflicts.length > 0 ? { ownershipConflicts } : {}),
    },
  };
}

async function cmdDesign(taskId: string, root: string, options?: CommandOptions): Promise<CommandResult> {
  const actor: Actor = actorFor({ id: 'kata-designer', role: 'designer' }, options?.platform);
  const workflowProfile = await acknowledgeCometOpenIfRequired(root, taskId);

  const taskPath = join(root, '.kata/tasks', taskId, 'task.json');
  const task = JSON.parse(await readFile(taskPath, 'utf8')) as {
    acceptance?: Array<{ id?: string; statement: string }>;
    acceptanceMatrix?: import('../core/task.js').AcceptanceMatrix;
    workflowProfile?: { strictClosure?: boolean };
  };
  const current = JSON.parse(await readFile(join(root, '.kata/tasks', taskId, 'current-state.json'), 'utf8')) as { phase: Phase };
  if (!task.acceptanceMatrix && (current.phase === 'implement' || current.phase === 'hardVerify')) {
    const handoff = await createHandoff(root, taskId, 'designer');
    return {
      command: 'design', taskId, phase: current.phase, success: true,
      diagnostics: { migrationMode: 'acceptance_matrix', nextRole: 'designer', guardInstructions: handoff.guardInstructions },
    };
  }
  if (requiresMatrix(task.workflowProfile) && !task.acceptanceMatrix) {
    return {
      command: 'design', taskId, phase: 'intake', success: false,
      error: 'Strict closure requires an acceptanceMatrix; add it to task.json before designing.',
      diagnostics: { missingMatrix: true },
    };
  }
  const matrixErrors = validateMatrix(task.acceptance ?? [], task.acceptanceMatrix);
  if (requiresMatrix(task.workflowProfile) && matrixErrors.length > 0) {
    return {
      command: 'design', taskId, phase: 'intake', success: false,
      error: `Acceptance matrix validation failed during design: ${matrixErrors.length} error(s).`,
      diagnostics: { matrixErrors },
    };
  }

  await guardTransition(options?.guard, 'check', taskId, 'plan');
  const state = await transition(taskId, 'plan', actor, { root });
  await guardTransition(options?.guard, 'apply', taskId, 'plan');
  const handoff = await createHandoff(root, taskId, 'implementer');

  return {
    command: 'design',
    taskId,
    phase: state.phase,
    success: true,
    diagnostics: {
      nextRole: 'implementer',
      actor,
      guardInstructions: handoff.guardInstructions,
      ...(workflowProfile ? { workflowProfile } : {}),
    },
  };
}

async function acknowledgeCometOpenIfRequired(root: string, taskId: string): Promise<WorkflowProfile | undefined> {
  const task = JSON.parse(await readFile(join(root, '.kata/tasks', taskId, 'task.json'), 'utf8')) as { workflowProfile?: unknown };
  if (!isWorkflowProfile(task.workflowProfile)) return undefined;
  if (task.workflowProfile.comet.openStatus !== 'required') return task.workflowProfile;
  return acknowledgeCometOpen(root, taskId);
}

async function cmdBuild(
  taskId: string,
  root: string,
  options: CommandOptions = {},
): Promise<CommandResult> {
  const current = JSON.parse(
    await readFile(join(root, '.kata/tasks', taskId, 'current-state.json'), 'utf8'),
  ) as { phase: Phase };
  let enteredReviewRepair = false;
  if (current.phase === 'plan') {
    await guardTransition(options.guard, 'check', taskId, 'implement');
    await transition(taskId, 'implement', actorFor(defaultActor, options.platform), { root });
    await guardTransition(options.guard, 'apply', taskId, 'implement');
  } else if (current.phase === 'hardVerify') {
    await reenterImplementForVerifyRepair(taskId, root, actorFor(defaultActor, options.platform));
  } else if (current.phase === 'review') {
    await reenterImplementForReviewRepair(taskId, root, actorFor(defaultActor, options.platform));
    enteredReviewRepair = true;
  } else if (current.phase === 'judge') {
    await reenterImplementForRepair(taskId, root, actorFor(defaultActor, options.platform));
  } else if (current.phase !== 'implement') {
    throw new Error(`Build cannot run from ${current.phase}`);
  }

  if (enteredReviewRepair) {
    return {
      command: 'build',
      taskId,
      phase: 'implement',
      success: true,
      diagnostics: {
        mode: 'implement',
        implementationPrompt: 'Review repair 已进入 implement。先修复 repair.json 中的 findings、写聚焦 RED/GREEN 测试；本次不会 seal 或创建 revision。',
        sealCommand: `kata build --change ${taskId} --seal`,
      },
    };
  }

  if (!(options.seal ?? true)) {
    let buildOwnedPaths: string[] = [];
    try {
      const currentTask = JSON.parse(
        await readFile(join(root, '.kata/tasks', taskId, 'task.json'), 'utf8'),
      ) as { ownedPaths?: string[] };
      if (currentTask.ownedPaths?.length) {
        buildOwnedPaths = currentTask.ownedPaths;
      }
    } catch { /* task may not exist yet */ }
    if (buildOwnedPaths.length === 0 && options.ownedPaths?.length) {
      buildOwnedPaths = options.ownedPaths;
    }
    const ownershipConflicts = buildOwnedPaths.length
      ? await findOwnershipConflicts(root, taskId, buildOwnedPaths)
      : [];
    return {
      command: 'build',
      taskId,
      phase: 'implement',
      success: true,
      diagnostics: {
        mode: 'implement',
        implementationPrompt: '先写聚焦的失败测试（RED），再最小实现并运行聚焦 GREEN；不要在编码前封存 build 证据。',
        sealCommand: `kata build --change ${taskId} --seal`,
        ...(ownershipConflicts.length > 0 ? { ownershipConflicts } : {}),
      },
    };
  }

  const taskPath = join(root, '.kata/tasks', taskId, 'task.json');
  const task = JSON.parse(await readFile(taskPath, 'utf8')) as {
    ownedPaths?: string[];
    acceptance?: Array<{ id?: string; statement: string }>;
    acceptanceMatrix?: import('../core/task.js').AcceptanceMatrix;
    workflowProfile?: { strictClosure?: boolean };
  };
  const projectChecks = options.checks?.length
    ? options.checks
    : await resolveBuildChecks(root, await loadConfig(root), task.ownedPaths ?? []);
  let matrixDerivedChecks: CheckCommand[] = [];
  if (!options.checks?.length && task.acceptanceMatrix) {
    try {
      matrixDerivedChecks = matrixChecks(root, task.acceptanceMatrix);
    } catch (error) {
      return {
        command: 'build', taskId, phase: 'implement', success: false,
        error: error instanceof Error ? error.message : String(error),
        diagnostics: { matrixError: true },
      };
    }
  }
  const checks = dedupeCheckCommands([
    ...projectChecks,
    ...matrixDerivedChecks,
  ]);

  if (requiresMatrix(task.workflowProfile) && !task.acceptanceMatrix) {
    return {
      command: 'build', taskId, phase: 'implement', success: false,
      error: 'Strict closure requires an acceptanceMatrix; add it to task.json before sealing.',
      diagnostics: { missingMatrix: true },
    };
  }
  const matrixErrors = validateMatrix(task.acceptance ?? [], task.acceptanceMatrix);
  if (requiresMatrix(task.workflowProfile) && matrixErrors.length > 0) {
    return {
      command: 'build', taskId, phase: 'implement', success: false,
      error: `Acceptance matrix validation failed: ${matrixErrors.length} error(s).`,
      diagnostics: { matrixErrors },
    };
  }

  if (!task.acceptanceMatrix) {
    const obligations = await readObligations(root, taskId);
    const unresolved = obligations.filter((o) => !o.resolvedAt);
    if (unresolved.length > 0) {
      return {
        command: 'build', taskId, phase: 'implement', success: false,
        error: 'Legacy task has unresolved repair obligations; add an acceptanceMatrix to task.json so closure can record matrix-matched evidence for the affected AC(s).',
        diagnostics: {
          unresolvedObligations: unresolved.length,
          unresolvedAcceptanceIds: [...new Set(unresolved.map((o) => o.acceptanceId).filter((id): id is string => Boolean(id)))],
        },
      };
    }
  }

  let ownedPaths: string[];
  try {
    ownedPaths = await resolveSealOwnedPaths(root, taskId, task, options);
  } catch (error) {
    return {
      command: 'build', taskId, phase: 'implement', success: false,
      error: error instanceof Error ? error.message : String(error),
      diagnostics: { missingOwnedPaths: true },
    };
  }
  const reviewRepairBaseline = await readActiveReviewRepairBaseline(root, taskId);
  if (reviewRepairBaseline) {
    const manifestHash = await computeManifestHash(root, ownedPaths);
    if (manifestHash === reviewRepairBaseline) {
      return {
        command: 'build',
        taskId,
        phase: 'implement',
        success: false,
        error: 'Cannot seal review repair without a changed task manifest; fix the recorded findings and tests before retrying --seal.',
        diagnostics: { mode: 'implement', repairRequired: true },
      };
    }
  }
  let codeGraphCandidates: CodeGraphCandidate[] = [];
  let codeGraphDisposition: CodeGraphCandidateDisposition | undefined;
  const ownershipConflicts = ownedPaths.length
    ? await findOwnershipConflicts(root, taskId, ownedPaths)
    : [];
  if (ownershipConflicts.length > 0 && !options.allowOwnershipConflicts) {
    return {
      command: 'build', taskId, phase: 'implement', success: false,
      error: 'Cannot seal while declared task ownership overlaps another task. Use --allow-ownership-conflicts to confirm and proceed.',
      diagnostics: { ownershipConflicts },
    };
  }

  if (requiresMatrix(task.workflowProfile)) {
    const coverage = validatePathCoverage(task.acceptanceMatrix!, ownedPaths);
    const persistedWaivers = await readWaivers(root, taskId);
    const waivers = [...new Map([...persistedWaivers, ...(options.waivers ?? [])].map((waiver) => [waiver.path, waiver])).values()];
    const waiverErrors = validateWaivers(waivers);
    if (waiverErrors.length > 0) {
      return { command: 'build', taskId, phase: 'implement', success: false, error: 'Invalid recorded waiver.', diagnostics: { waiverErrors } };
    }
    if (task.workflowProfile?.strictClosure) {
      codeGraphCandidates = await discoverCodeGraphCandidates(root, task.acceptanceMatrix!, ownedPaths);
      codeGraphDisposition = classifyCodeGraphCandidates(task.acceptanceMatrix!, ownedPaths, waivers, codeGraphCandidates);
    }
    const waivedPaths = new Set(waivers.map((w) => w.path));
    const unwaivedMissingImpl = coverage.missingImplementationPaths.filter((p) => !waivedPaths.has(p));
    const unwaivedMissingTest = coverage.missingTestPaths.filter((p) => !waivedPaths.has(p));
    if (unwaivedMissingImpl.length > 0 || unwaivedMissingTest.length > 0 || (codeGraphDisposition?.unresolvedCandidates.length ?? 0) > 0) {
      return {
        command: 'build', taskId, phase: 'implement', success: false,
        error: 'Owned path coverage incomplete: matrix implementation and test paths must be covered by owned paths or waived.',
        diagnostics: {
          missingImplementationPaths: unwaivedMissingImpl,
          missingTestPaths: unwaivedMissingTest,
          waivedImplementationPaths: coverage.missingImplementationPaths.filter((p) => waivedPaths.has(p)),
          waivedTestPaths: coverage.missingTestPaths.filter((p) => waivedPaths.has(p)),
          ...(codeGraphCandidates.length > 0 ? { codeGraphCandidates, ...(codeGraphDisposition ?? {}) } : {}),
          waivers,
        },
      };
    }
    await writeWaivers(root, taskId, waivers);
  }
  const revision = ownedPaths.length
    ? await createTaskRevision({
        root,
        taskId,
        ownedPaths,
        ...(ownershipConflicts.length > 0 && options.allowOwnershipConflicts
          ? { ownershipConflicts, ownershipConflictsAcknowledged: true }
          : {}),
      })
    : undefined;

  const evidence = await collectEvidence(taskId, checks, {
    ...(revision ? { revision } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.onProgress ? { onProgress: options.onProgress } : {}),
  });
  await writeEvidence(root, taskId, evidence);
  if (evidence.some((item) => item.exitCode !== 0)) {
    return {
      command: 'build',
      taskId,
      phase: 'implement',
      success: false,
      error: 'Evidence sealing failed; fix the failing checks before retrying --seal.',
      diagnostics: {
        mode: 'seal',
        evidenceCount: evidence.length,
        passing: evidence.filter((item) => item.exitCode === 0).length,
        failing: evidence.filter((item) => item.exitCode !== 0).length,
      },
    };
  }

  if (revision && task.acceptanceMatrix) {
    const acIds = task.acceptanceMatrix.rows.map((r) => r.acceptanceId);
    await resolveObligationsForRevision(
      root, taskId, revision.id, acIds,
      evidence.filter((e) => e.exitCode === 0).map((e) => e.id),
      task.acceptanceMatrix,
      evidence,
    );
  }
  if (revision && reviewRepairBaseline) {
    await resolveReviewRepair(root, taskId, revision.id);
  }

  const wikiClosure = await ensureWikiClosure(root, taskId);
  await guardTransition(options.guard, 'check', taskId, 'hardVerify');
  await transition(taskId, 'hardVerify', actorFor(defaultActor, options.platform), { root });
  await guardTransition(options.guard, 'apply', taskId, 'hardVerify');

  return {
    command: 'build',
    taskId,
    phase: 'hardVerify',
    success: evidence.every((e) => e.exitCode === 0),
    diagnostics: {
      evidenceCount: evidence.length,
      passing: evidence.filter((e) => e.exitCode === 0).length,
      failing: evidence.filter((e) => e.exitCode !== 0).length,
      wikiClosure,
      ...(ownedPaths.length ? { ownedPaths, ownedPathsSource: task.ownedPaths?.length ? 'task' : 'build-option' } : {}),
      ...(codeGraphCandidates.length > 0 ? { codeGraphCandidates, ...(codeGraphDisposition ?? {}) } : {}),
      ...(revision ? { revisionId: revision.id } : {}),
      ...(ownershipConflicts.length > 0 ? { ownershipConflicts } : {}),
    },
  };
}

const selectorCapableRunners = new Set(['vitest', 'pytest', 'uv']);

function resolveCheckForRow(
  row: import('../core/task.js').AcceptanceMatrixRow,
  evidence: import('../core/task.js').MatrixEvidenceItem,
  root: string,
): CheckCommand | Error {
  const hasSelector = typeof evidence.testSelector === 'string' && evidence.testSelector.length > 0;
  const template = evidence.command.trim();
  const hasPlaceholder = template.includes('{{selector}}');

  if (hasSelector && hasPlaceholder) {
    const filled = template.replace('{{selector}}', evidence.testSelector!);
    const [rawCommand, ...args] = filled.split(/\s+/);
    const runtimeProjectDir = row.testPaths.every((path) => path.startsWith('kata/')) ? join(root, 'kata') : root;
    const runtimeEntry = rawCommand === 'vitest'
      ? join(runtimeProjectDir, 'node_modules', 'vitest', 'vitest.mjs')
      : rawCommand === 'tsc'
        ? join(runtimeProjectDir, 'node_modules', 'typescript', 'bin', 'tsc')
        : undefined;
    const command = runtimeEntry ? process.execPath : rawCommand;
    return {
      name: `${row.acceptanceId}-${evidence.kind}-${evidence.testSelector ?? evidence.command}`,
      kind: evidence.kind,
      command,
      args: [...(runtimeEntry ? [runtimeEntry] : []), ...args],
      cwd: root,
      timeoutMs: evidence.kind === 'test' || evidence.kind === 'integration' || evidence.kind === 'entrypoint' ? 120_000 : 60_000,
    } satisfies CheckCommand;
  }

  if (hasSelector) {
    const knownRunners = ['vitest', 'pytest', 'uv run pytest'];
    const isKnownRunner = knownRunners.some((runner) => template === runner || template.startsWith(runner + ' '));
    if (isKnownRunner) {
      const [rawCommand, ...args] = template.split(/\s+/);
      const runtimeProjectDir = row.testPaths.every((path) => path.startsWith('kata/')) ? join(root, 'kata') : root;
      const runtimeEntry = rawCommand === 'vitest'
        ? join(runtimeProjectDir, 'node_modules', 'vitest', 'vitest.mjs')
        : rawCommand === 'pytest'
          ? rawCommand
          : undefined;
      const command = runtimeEntry === undefined && rawCommand === 'uv' ? template : (runtimeEntry ? process.execPath : rawCommand);
      return {
        name: `${row.acceptanceId}-${evidence.kind}-${evidence.testSelector ?? evidence.command}`,
        kind: evidence.kind,
        command: runtimeEntry ? process.execPath : rawCommand,
        args: [...(runtimeEntry ? [runtimeEntry] : []), ...args, ...(evidence.testSelector ? [evidence.testSelector] : [])],
        cwd: root,
        timeoutMs: evidence.kind === 'test' || evidence.kind === 'integration' || evidence.kind === 'entrypoint' ? 120_000 : 60_000,
      } satisfies CheckCommand;
    }
    return new Error(`Matrix row ${row.acceptanceId} declares a testSelector but command "${template}" does not support selectors. Use vitest, pytest, uv run pytest, or a command template with {{selector}} placeholder.`);
  }

  const [rawCommand, ...args] = template.split(/\s+/);
  const runtimeProjectDir = row.testPaths.every((path) => path.startsWith('kata/')) ? join(root, 'kata') : root;
  const runtimeEntry = rawCommand === 'vitest'
    ? join(runtimeProjectDir, 'node_modules', 'vitest', 'vitest.mjs')
    : rawCommand === 'tsc'
      ? join(runtimeProjectDir, 'node_modules', 'typescript', 'bin', 'tsc')
      : undefined;
  const command = runtimeEntry ? process.execPath : rawCommand;
  return {
    name: `${row.acceptanceId}-${evidence.kind}-${evidence.testSelector ?? evidence.command}`,
    kind: evidence.kind,
    command,
    args: [...(runtimeEntry ? [runtimeEntry] : []), ...args, ...(evidence.testSelector ? [evidence.testSelector] : [])],
    cwd: root,
    timeoutMs: evidence.kind === 'test' || evidence.kind === 'integration' || evidence.kind === 'entrypoint' ? 120_000 : 60_000,
  } satisfies CheckCommand;
}

function matrixChecks(root: string, matrix: import('../core/task.js').AcceptanceMatrix): CheckCommand[] {
  const checks: CheckCommand[] = [];
  for (const row of matrix.rows) {
    for (const evidence of row.evidence) {
      const result = resolveCheckForRow(row, evidence, root);
      if (result instanceof Error) {
        throw result;
      }
      checks.push(result);
    }
  }
  return checks.filter((check, index) => checks.findIndex((candidate) =>
    candidate.kind === check.kind
      && candidate.command === check.command
      && (candidate.args ?? []).join('\0') === (check.args ?? []).join('\0')
      && candidate.cwd === check.cwd,
  ) === index);
}

function dedupeCheckCommands(checks: CheckCommand[]): CheckCommand[] {
  return checks.filter((check, index) => checks.findIndex((candidate) =>
    candidate.kind === check.kind
      && candidate.command === check.command
      && (candidate.args ?? []).join('\0') === (check.args ?? []).join('\0')
      && candidate.cwd === check.cwd,
  ) === index);
}

async function resolveSealOwnedPaths(
  root: string,
  taskId: string,
  task: { ownedPaths?: string[] },
  options: CommandOptions,
): Promise<string[]> {
  if (task.ownedPaths?.length) {
    const cliPaths = options.ownedPaths?.length ? options.ownedPaths : [];
    const merged = cliPaths.length
      ? [...new Set([...task.ownedPaths, ...cliPaths])].sort()
      : task.ownedPaths;
    if (merged.length > task.ownedPaths.length) {
      await persistTaskOwnedPaths(root, taskId, task, merged);
    }
    return merged;
  }
  if (!options.ownedPaths?.length) {
    throw new Error('seal requires at least one --owned-path when the task has no ownedPaths');
  }
  const ownedPaths = [...new Set(options.ownedPaths)].sort();
  await persistTaskOwnedPaths(root, taskId, task, ownedPaths);
  return ownedPaths;
}

async function persistTaskOwnedPaths(
  root: string,
  taskId: string,
  task: { ownedPaths?: string[] },
  ownedPaths: string[],
): Promise<void> {
  await writeFile(
    join(root, '.kata/tasks', taskId, 'task.json'),
    `${JSON.stringify({ ...task, ownedPaths }, null, 2)}\n`,
    'utf8',
  );
}

async function writeEvidence(root: string, taskId: string, evidence: EvidenceEnvelope[]): Promise<void> {
  const evidenceDir = join(root, '.kata/evidence');
  await mkdir(evidenceDir, { recursive: true });

  const { readdir, unlink } = await import('node:fs/promises');
  try {
    const files = await readdir(evidenceDir);
    for (const file of files) {
      if (file.startsWith(`${taskId}-`) && file.endsWith('.json')) {
        await unlink(join(evidenceDir, file)).catch(() => {});
      }
    }
  } catch {}

  for (const envelope of evidence) {
    await writeFile(
      join(evidenceDir, `${taskId}-${evidenceFileSuffix(envelope)}.json`),
      `${JSON.stringify(envelope, null, 2)}\n`,
      'utf8',
    );
  }

  const testEvidence = evidence.find((item) => item.kind === 'test');
  if (testEvidence) {
    await writeFile(
      join(evidenceDir, `${taskId}-hard.json`),
      `${JSON.stringify(testEvidence, null, 2)}\n`,
      'utf8',
    );
  }
}

function evidenceFileSuffix(envelope: EvidenceEnvelope): string {
  return (envelope.name ?? envelope.kind).replace(/[^A-Za-z0-9_.-]+/g, '-').replace(/^-|-$/g, '') || envelope.kind;
}

async function reenterImplementForReviewRepair(taskId: string, root: string, actor: Actor): Promise<void> {
  const reviewRaw = await readFile(join(root, '.kata/tasks', taskId, 'review.json'), 'utf8');
  const review = JSON.parse(reviewRaw) as {
    findings?: Array<{ severity?: string; title?: string; message?: string; fix?: string }>;
  };
  const taskRaw = await readFile(join(root, '.kata/tasks', taskId, 'task.json'), 'utf8');
  const task = JSON.parse(taskRaw) as { workflowProfile?: { reviewMode?: string } };
  const isStrict = task.workflowProfile?.reviewMode === 'strict';
  const blockingFindings = (review.findings ?? []).filter((finding) => finding.severity === 'blocking');
  const majorFindings = isStrict
    ? (review.findings ?? []).filter((finding) => finding.severity === 'major')
    : [];
  if (blockingFindings.length === 0 && majorFindings.length === 0) {
    throw new Error('Build cannot run from review without blocking (or strict-mode major) review findings');
  }

  const now = new Date().toISOString();
  const revision = await readCurrentTaskRevision(root, taskId);
  await appendStateEvent(root, {
    taskId,
    from: 'review',
    to: 'implement',
    actor,
    at: now,
  });
  await writeCurrentState(root, {
    taskId,
    phase: 'implement',
    actor,
    updatedAt: now,
  });
  await writeFile(
    join(root, '.kata/tasks', taskId, 'repair.json'),
    `${JSON.stringify({
      taskId,
      fromPhase: 'review',
      toPhase: 'implement',
      actor,
      reason: 'review_findings',
      ...(revision ? { baselineRevisionId: revision.id, baselineManifestHash: revision.manifestHash } : {}),
      findings: [...blockingFindings, ...majorFindings].map((finding) => ({
        title: finding.title,
        message: finding.message,
        fix: finding.fix,
      })),
      createdAt: now,
    }, null, 2)}\n`,
    'utf8',
  );
}

async function readActiveReviewRepairBaseline(root: string, taskId: string): Promise<string | undefined> {
  try {
    const repair = JSON.parse(await readFile(join(root, '.kata/tasks', taskId, 'repair.json'), 'utf8')) as {
      reason?: string;
      baselineManifestHash?: string;
      resolvedAt?: string;
    };
    if (repair.reason !== 'review_findings' || repair.resolvedAt || !repair.baselineManifestHash) return undefined;
    return repair.baselineManifestHash;
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
    throw error;
  }
}

async function resolveReviewRepair(root: string, taskId: string, revisionId: string): Promise<void> {
  const repairPath = join(root, '.kata/tasks', taskId, 'repair.json');
  const repair = JSON.parse(await readFile(repairPath, 'utf8')) as Record<string, unknown>;
  await writeFile(repairPath, `${JSON.stringify({
    ...repair,
    resolvedAt: new Date().toISOString(),
    resolvedRevisionId: revisionId,
  }, null, 2)}\n`, 'utf8');
}

async function reenterImplementForVerifyRepair(taskId: string, root: string, actor: Actor): Promise<void> {
  let verifyRaw: string | undefined;
  try {
    verifyRaw = await readFile(join(root, '.kata/tasks', taskId, 'verify.json'), 'utf8');
  } catch (error: unknown) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
  }
  if (!verifyRaw) {
    const now = new Date().toISOString();
    await appendStateEvent(root, { taskId, from: 'hardVerify', to: 'implement', actor, at: now });
    await writeCurrentState(root, { taskId, phase: 'implement', actor, updatedAt: now });
    return;
  }
  const verify = JSON.parse(verifyRaw) as {
    result?: string;
    acceptance?: Array<{ id?: string; result?: string; repairScope?: string }>;
  };
  const repairableScopes = new Set([
    'missing_test_evidence',
    'stale_evidence',
    'failing_evidence',
    'blocking_review_finding',
    'revision_superseded',
    'insufficient_evidence_level',
    'unresolved_repair_obligation',
  ]);
  const failedAcceptance = verify.acceptance?.filter((criterion) => criterion.result === 'FAIL') ?? [];
  const isRepairable = verify.result === 'FAIL'
    && (failedAcceptance.length === 0
      || failedAcceptance.every((criterion) => criterion.repairScope && repairableScopes.has(criterion.repairScope)));
  if (!isRepairable) {
    throw new Error('Build cannot run from hardVerify without a repairable verify FAIL result');
  }

  const now = new Date().toISOString();
  await appendStateEvent(root, {
    taskId,
    from: 'hardVerify',
    to: 'implement',
    actor,
    at: now,
  });
  await writeCurrentState(root, {
    taskId,
    phase: 'implement',
    actor,
    updatedAt: now,
  });
  await writeFile(
    join(root, '.kata/tasks', taskId, 'repair.json'),
    `${JSON.stringify({
      taskId,
      fromPhase: 'hardVerify',
      toPhase: 'implement',
      actor,
      reason: failedAcceptance.length === 0 ? 'verify_reseal' : 'verify_fail',
      scopes: failedAcceptance.map((criterion) => ({
        id: criterion.id,
        repairScope: criterion.repairScope,
      })),
      createdAt: now,
    }, null, 2)}\n`,
    'utf8',
  );
}

async function reenterImplementForRepair(taskId: string, root: string, actor: Actor): Promise<void> {
  const judgeRaw = await readFile(join(root, '.kata/tasks', taskId, 'judge.json'), 'utf8');
  const judgeResult = JSON.parse(judgeRaw) as {
    result?: string;
    acceptance?: Array<{ id?: string; result?: string; repairScope?: string }>;
  };
  const repairableScopes = new Set([
    'missing_test_evidence',
    'stale_evidence',
    'failing_evidence',
    'blocking_review_finding',
    'insufficient_evidence_level',
    'unresolved_repair_obligation',
  ]);
  const failedAcceptance = judgeResult.acceptance?.filter((criterion) => criterion.result === 'FAIL') ?? [];
  const isRepairable = judgeResult.result === 'FAIL'
    && failedAcceptance.length > 0
    && failedAcceptance.every((criterion) => criterion.repairScope && repairableScopes.has(criterion.repairScope));
  if (!isRepairable) {
    throw new Error('Build cannot run from judge without a repairable judge FAIL result');
  }

  const now = new Date().toISOString();
  await appendStateEvent(root, {
    taskId,
    from: 'judge',
    to: 'implement',
    actor,
    at: now,
  });
  await writeCurrentState(root, {
    taskId,
    phase: 'implement',
    actor,
    updatedAt: now,
  });
  await writeFile(
    join(root, '.kata/tasks', taskId, 'repair.json'),
    `${JSON.stringify({
      taskId,
      fromPhase: 'judge',
      toPhase: 'implement',
      actor,
      reason: 'judge_fail',
      scopes: failedAcceptance.map((criterion) => ({
        id: criterion.id,
        repairScope: criterion.repairScope,
      })),
      createdAt: now,
    }, null, 2)}\n`,
    'utf8',
  );
}

async function cmdVerify(
  taskId: string,
  root: string,
  options: CommandOptions = {},
): Promise<CommandResult> {
  const taskRaw = await readFile(join(root, '.kata/tasks', taskId, 'task.json'), 'utf8');
  const task = JSON.parse(taskRaw) as {
    acceptance: Array<{ id?: string; statement: string }>;
    acceptanceMatrix?: import('../core/task.js').AcceptanceMatrix;
    workflowProfile?: { reviewMode?: string };
  };

  const current = JSON.parse(await readFile(join(root, '.kata/tasks', taskId, 'current-state.json'), 'utf8')) as { phase: Phase };
  const currentDiffHash = await computeDiffHash(root);
  const evidence = await readTaskEvidence(root, taskId, options);
  const scopeHashes = await currentScopeHashes(root, evidence);
  const revisionId = revisionIdForEvidence(evidence);
  const review = await readReview(root, taskId);
  const ignoredReviewFindings = revisionId && review.revisionId !== revisionId ? review.findings.length : 0;
  const findings = ignoredReviewFindings > 0 ? [] : review.findings;
  const revision = revisionId ? await readTaskRevision(root, taskId, revisionId) : undefined;
  const status = revision ? await revisionStatus(root, revision) : undefined;
  const drift = revision ? await workspaceDrift(root, revision.ownedPaths) : [];
  const obligations = await readObligations(root, taskId);
  const unresolvedObligations = obligations.filter((o) => !o.resolvedAt);
  const matrix = task.acceptanceMatrix;
  const verifyResult = status?.status === 'superseded'
    ? supersededReadiness(taskId, task.acceptance, currentDiffHash, revision!.id)
    : evaluateReadiness(taskId, task.acceptance, evidence, findings, currentDiffHash, scopeHashes, matrix, unresolvedObligations, task.workflowProfile?.reviewMode);
  if (revisionId) verifyResult.revisionId = revisionId;
  const implementationReady = verifyResult.result === 'PASS';
  const wikiClosure = await evaluateWikiClosure(root, taskId);
  if (!wikiClosure.valid) verifyResult.result = 'FAIL';
  await writeFile(join(root, '.kata/tasks', taskId, 'verify.json'), `${JSON.stringify(verifyResult, null, 2)}\n`, 'utf8');

  const failedScopes = verifyResult.acceptance
    .filter((acceptance) => acceptance.result === 'FAIL')
    .map((acceptance) => acceptance.repairScope)
    .filter((scope): scope is Exclude<typeof scope, undefined> => scope !== undefined);
  const repairReason = failedScopes.length > 0 && failedScopes.every((scope) => scope === 'revision_superseded')
    ? 'rebuild_superseded_revision'
    : failedScopes.length > 0 && failedScopes.every((scope) => scope === 'stale_evidence')
    ? 'rebuild_stale_evidence'
    : failedScopes.length > 0 && failedScopes.every((scope) => scope === 'insufficient_evidence_level')
    ? 'add_entrypoint_evidence'
    : failedScopes.length > 0 && failedScopes.every((scope) => scope === 'unresolved_repair_obligation')
    ? 'resolve_repair_obligations'
    : 'repair_failed_verify';
  const repairAction = nextActionForTask(taskId, '/kata-build', 'implementer', repairReason);
  const wikiClosureAction = nextActionForTask(taskId, '/kata-wiki-enrich', 'implementer', 'resolve_wiki_closure');
  const nextAction = implementationReady && !wikiClosure.valid
    ? wikiClosureAction
    : verifyResult.result === 'PASS'
      ? {
          nextSkill: current.phase === 'review' ? '/kata-judge' : '/kata-review',
          requiresUserConfirmation: true,
          modelOrPlatformSwitchAllowed: true,
          trustBoundary: current.phase === 'review' ? 'judge_gate' : 'review_gate',
        }
      : repairAction;

  return {
    command: 'verify',
    taskId,
    phase: current.phase,
    success: verifyResult.result === 'PASS',
    ...(verifyResult.result === 'FAIL' ? { error: implementationReady && !wikiClosure.valid
      ? `Implementation verification passed; complete Wiki closure (${wikiClosure.reason}) before review/judge.`
      : wikiClosure.valid
      ? repairReason === 'rebuild_stale_evidence'
        ? 'Verify found stale evidence; reseal checks against the current implementation before review/judge.'
        : repairReason === 'add_entrypoint_evidence'
        ? 'Verify requires integration/entrypoint evidence for at least one AC; unit evidence alone is insufficient.'
        : repairReason === 'resolve_repair_obligations'
        ? 'Verify blocked by unresolved repair obligations; supply matrix-linked evidence and mark obligations resolved.'
        : 'Verify failed; repair evidence or blocking findings before review/judge.'
      : `Verify failed; complete Wiki closure (${wikiClosure.reason}) before review/judge.` } : {}),
    diagnostics: {
      verifyResult: verifyResult.result,
      acceptanceResults: verifyResult.acceptance.map((a) => ({
        id: a.id,
        result: a.result,
        repairScope: a.repairScope,
      })),
      evidenceCount: evidence.length,
      findingCount: findings.length,
      blockingFindings: findings.filter((f) => f.severity === 'blocking').length,
      implementationReady,
      governanceReady: wikiClosure.valid,
      wikiClosure,
      ...(unresolvedObligations.length > 0 ? { unresolvedObligations: unresolvedObligations.length } : {}),
      ...(revisionId ? { revisionId } : {}),
      ...(status ? { revisionStatus: status.status } : {}),
      ...(revision ? { workspaceDrift: drift } : {}),
      ...(ignoredReviewFindings > 0 ? {
        ignoredReviewFindings,
        ignoredReviewRevisionId: review.revisionId ?? null,
      } : {}),
      nextAction,
    },
  };
}

async function cmdReview(taskId: string, root: string, options: CommandOptions = {}): Promise<CommandResult> {
  try {
    const isApprove = options.approve === true;
    if (isApprove) {
      const current = JSON.parse(await readFile(join(root, '.kata/tasks', taskId, 'current-state.json'), 'utf8')) as { phase: Phase };
      if (current.phase !== 'review') {
        return {
          command: 'review', taskId, phase: current.phase, success: false,
          error: `Review approval requires review phase; current phase is ${current.phase}.`,
        };
      }
      const reviewEvidence = options.reviewEvidence?.trim();
      if (!reviewEvidence) {
        return {
          command: 'review', taskId, phase: 'review', success: false,
          error: 'Review approval requires non-empty review evidence.',
        };
      }
      const reviewPath = join(root, '.kata/tasks', taskId, 'review.json');
      const revisionId = revisionIdForEvidence(await readTaskEvidence(root, taskId, options));
      const existing = await readReview(root, taskId);
      if (revisionId && existing.revisionId !== revisionId) {
        return {
          command: 'review', taskId, phase: 'review', success: false,
          error: 'Review approval requires findings recorded for the same sealed revision as current evidence. Re-run /kata-review before approving.',
        };
      }
      if (existing.findings.some((f) => f.severity === 'blocking' || f.severity === 'major')) {
        return {
          command: 'review', taskId, phase: 'review', success: false,
          error: 'Cannot approve review with blocking or major findings; resolve findings first.',
        };
      }
      await writeFile(reviewPath, `${JSON.stringify({ ...(revisionId ? { revisionId } : {}), findings: existing.findings, status: 'approved', reviewEvidence, approvedAt: new Date().toISOString() }, null, 2)}\n`, 'utf8');
      return { command: 'review', taskId, phase: 'review', success: true, diagnostics: { role: 'reviewer', approval: true, reviewEvidence, ...(revisionId ? { revisionId } : {}) } };
    }

    if (!options.confirmHostModel) {
      return {
        command: 'review', taskId, phase: 'hardVerify', success: false,
        error: 'Review requires explicit user confirmation at the review trust boundary.',
        diagnostics: { requiresUserConfirmation: true, trustBoundary: 'review_gate' },
      };
    }

    await guardTransition(options.guard, 'check', taskId, 'review');
    const state = await transition(taskId, 'review', actorFor(reviewerActor, options.platform), { root });
    await guardTransition(options.guard, 'apply', taskId, 'review');
    const reviewPath = join(root, '.kata/tasks', taskId, 'review.json');
    const revisionId = revisionIdForEvidence(await readTaskEvidence(root, taskId, options));
    try {
      const previous = JSON.parse(await readFile(reviewPath, 'utf8')) as {
        revisionId?: string;
        findings?: ReviewFinding[];
      };
      if (revisionId && previous.revisionId !== revisionId) {
        await writeFile(reviewPath, `${JSON.stringify({ revisionId, findings: [], status: 'pending' }, null, 2)}\n`, 'utf8');
      }
    } catch {
      await writeFile(reviewPath, `${JSON.stringify({ ...(revisionId ? { revisionId } : {}), findings: [], status: 'pending' }, null, 2)}\n`, 'utf8');
    }
    return { command: 'review', taskId, phase: state.phase, success: true, diagnostics: { role: 'reviewer', ...(revisionId ? { revisionId } : {}) } };
  } catch (error) { return { command: 'review', taskId, phase: 'hardVerify', success: false, error: `Review transition failed: ${(error as Error).message}` }; }
}

async function cmdJudge(taskId: string, root: string, options: CommandOptions = {}): Promise<CommandResult> {
  const current = JSON.parse(await readFile(join(root, '.kata/tasks', taskId, 'current-state.json'), 'utf8')) as { phase: Phase };
  if (current.phase !== 'review') {
    return {
      command: 'judge',
      taskId,
      phase: current.phase,
      success: false,
      error: `Judge requires review phase; current phase is ${current.phase}. Run /kata-review first, then ask the user whether to keep this platform/model or switch before /kata-judge.`,
      diagnostics: {
        requiresUserConfirmation: true,
        trustBoundary: 'judge_gate',
        nextSkill: current.phase === 'hardVerify' ? '/kata-review' : '/kata',
        modelOrPlatformSwitchAllowed: true,
      },
    };
  }
  if (!options.confirmHostModel) {
    return {
      command: 'judge', taskId, phase: 'review', success: false,
      error: 'Judge requires explicit user confirmation at the judge trust boundary.',
      diagnostics: { requiresUserConfirmation: true, trustBoundary: 'judge_gate' },
    };
  }
  const taskRaw = await readFile(join(root, '.kata/tasks', taskId, 'task.json'), 'utf8');
  const task = JSON.parse(taskRaw) as {
    acceptance: Array<{ id?: string; statement: string }>;
    acceptanceMatrix?: import('../core/task.js').AcceptanceMatrix;
    workflowProfile?: { reviewMode?: string };
  };
  const review = await readReview(root, taskId);
  if (review.status !== 'approved' || !review.reviewEvidence?.trim()) {
    return {
      command: 'judge', taskId, phase: 'review', success: false,
      error: review.status === 'pending'
        ? 'Review has no explicit evidence-backed conclusion. Approve review with /kata-review --approve --review-evidence <summary> or record findings before judge.'
        : 'Review has no explicit conclusion. Run /kata-review first.',
    };
  }
  const currentDiffHash = await computeDiffHash(root);
  const evidence = await readTaskEvidence(root, taskId, options);
  const findings = review.findings;
  const evidenceRevisionId = revisionIdForEvidence(evidence);
  const reviewRevisionId = await readReviewRevisionId(root, taskId);
  if (evidenceRevisionId && reviewRevisionId !== evidenceRevisionId) {
    return {
      command: 'judge', taskId, phase: 'review', success: false,
      error: 'Judge requires review findings bound to the same sealed revision as evidence. Re-run /kata-review for the current revision.',
      diagnostics: { revisionId: evidenceRevisionId, reviewRevisionId: reviewRevisionId ?? null, repairScope: 'cross_revision_review' },
    };
  }
  const scopeHashes = await currentScopeHashes(root, evidence);
  const obligations = await readObligations(root, taskId);
  const judgeResult = await judge({
    root,
    taskId,
    acceptance: task.acceptance,
    evidence,
    findings,
    currentDiffHash,
    currentScopeHashes: scopeHashes,
    matrix: task.acceptanceMatrix,
    reviewMode: task.workflowProfile?.reviewMode,
  } as import('../quality/judge.js').JudgeInput);

  if (judgeResult.result === 'FAIL') {
    await persistBlockingJudgeResult(
      root,
      taskId,
      judgeResult.acceptance.filter((a) => a.result === 'FAIL').map((a) => ({ id: a.id, result: a.result })),
    );
  }

  let judgePhase: Phase = 'judge';
  let judgeTransitionError: string | null = null;
  try {
    await guardTransition(options.guard, 'check', taskId, 'judge');
    await transition(taskId, 'judge', actorFor(judgeActor, options.platform), { root });
    await guardTransition(options.guard, 'apply', taskId, 'judge');
  } catch (error) {
    judgePhase = 'review';
    judgeTransitionError = error instanceof Error ? error.message : String(error);
  }

  return {
    command: 'judge',
    taskId,
    phase: judgeResult.result === 'PASS' && judgeTransitionError === null ? 'judge' : judgePhase,
    success: judgeResult.result === 'PASS' && judgeTransitionError === null,
    ...(judgeTransitionError ? { error: `Judge transition failed: ${judgeTransitionError}` } : {}),
    diagnostics: {
      judgeResult: judgeResult.result,
      acceptanceResults: judgeResult.acceptance.map((a) => ({
        id: a.id,
        result: a.result,
        repairScope: a.repairScope,
      })),
      evidenceCount: evidence.length,
      findingCount: findings.length,
      blockingFindings: findings.filter((f) => f.severity === 'blocking').length,
    },
  };
}

async function readTaskEvidence(root: string, taskId: string, options: CommandOptions = {}): Promise<EvidenceEnvelope[]> {
  const evidenceDir = join(root, '.kata/evidence');
  let evidence: EvidenceEnvelope[] = [];
  try {
    const { readdir } = await import('node:fs/promises');
    const files = await readdir(evidenceDir);
    const candidateFiles = files.filter((f) => f.startsWith(`${taskId}-`));
    for (const file of candidateFiles) {
      const raw = await readFile(join(evidenceDir, file), 'utf8');
      const parsed = JSON.parse(raw) as EvidenceEnvelope;
      if (parsed.taskId === taskId) evidence.push(parsed);
    }
  } catch {
    evidence = options.checks
      ? await collectEvidence(taskId, options.checks)
      : [];
  }
  return evidence;
}

async function readReviewFindings(root: string, taskId: string): Promise<ReviewFinding[]> {
  return (await readReview(root, taskId)).findings;
}

async function readReview(root: string, taskId: string): Promise<{ revisionId?: string; status?: string; reviewEvidence?: string; findings: ReviewFinding[] }> {
  try {
    const reviewRaw = await readFile(join(root, '.kata/tasks', taskId, 'review.json'), 'utf8');
    const reviewParsed = JSON.parse(reviewRaw) as { revisionId?: string; status?: string; reviewEvidence?: string; findings?: ReviewFinding[] };
    return { revisionId: reviewParsed.revisionId, status: reviewParsed.status, reviewEvidence: reviewParsed.reviewEvidence, findings: reviewParsed.findings ?? [] };
  } catch {
    return { findings: [] };
  }
}

async function readReviewRevisionId(root: string, taskId: string): Promise<string | undefined> {
  try {
    const raw = await readFile(join(root, '.kata/tasks', taskId, 'review.json'), 'utf8');
    return (JSON.parse(raw) as { revisionId?: string }).revisionId;
  } catch {
    return undefined;
  }
}

function evaluateReadiness(
  taskId: string,
  acceptance: Array<{ id?: string; statement: string }>,
  evidence: EvidenceEnvelope[],
  findings: ReviewFinding[],
  currentDiffHash: string,
  scopeHashes: Map<string, string>,
  matrix?: import('../core/task.js').AcceptanceMatrix,
  unresolvedObligations: Array<{ acceptanceId?: string; id: string; message: string }> = [],
  reviewMode?: string,
): JudgeResult {
  const freshEvidence = evidence.filter((item) => checkFreshness(item, currentDiffHash, scopeHashes.get(item.id)).fresh);
  const freshPassingTestEvidence = freshEvidence.filter((item) => item.kind === 'test' && item.exitCode === 0);
  const failingTestEvidence = freshEvidence.find((item) => item.kind === 'test' && item.exitCode !== 0);
  const blockingFindings = findings.filter((finding) => finding.severity === 'blocking'
    || (reviewMode === 'strict' && finding.severity === 'major'));
  const acceptanceResults = acceptance.map((criterion): JudgeAcceptanceResult => {
    const acceptanceId = criterion.id ?? '';
    const blockingFinding = blockingFindings.find((finding) => !finding.acceptanceId || finding.acceptanceId === acceptanceId);
    const obligation = unresolvedObligations.find((o) => o.acceptanceId === acceptanceId || !o.acceptanceId);
    if (failingTestEvidence) return { id: acceptanceId, result: 'FAIL', repairScope: 'failing_evidence' };
    if (obligation) return { id: acceptanceId, result: 'FAIL', repairScope: 'unresolved_repair_obligation' };
    if (freshPassingTestEvidence.length === 0 && evidence.some((item) => item.kind === 'test')) {
      return { id: acceptanceId, result: 'FAIL', repairScope: 'stale_evidence' };
    }
    if (freshPassingTestEvidence.length === 0) return { id: acceptanceId, result: 'FAIL', repairScope: 'missing_test_evidence' };
    if (matrix) {
      const row = getMatrixRowForAc(matrix, acceptanceId);
      if (row && (row.verificationLevel === 'integration' || row.verificationLevel === 'entrypoint')) {
        const hasRowSpecificEvidence = freshEvidence.some((item) => evidenceMatchesRow(row, item.command, item.kind));
        if (!hasRowSpecificEvidence) return { id: acceptanceId, result: 'FAIL', repairScope: 'insufficient_evidence_level' };
      }
    }
    if (blockingFinding) return { id: acceptanceId, result: 'FAIL', repairScope: 'blocking_review_finding' };
    return { id: acceptanceId, result: 'PASS', evidenceIds: freshPassingTestEvidence.map((item) => item.id) };
  });
  return {
    taskId,
    result: acceptanceResults.every((item) => item.result === 'PASS') ? 'PASS' : 'FAIL',
    diffHash: currentDiffHash,
    acceptance: acceptanceResults,
    evidenceIds: freshPassingTestEvidence.map((item) => item.id),
  };
}

function supersededReadiness(
  taskId: string,
  acceptance: Array<{ id?: string; statement: string }>,
  currentDiffHash: string,
  revisionId: string,
): JudgeResult {
  return {
    taskId,
    result: 'FAIL',
    diffHash: currentDiffHash,
    revisionId,
    acceptance: acceptance.map((criterion) => ({
      id: criterion.id ?? '',
      result: 'FAIL' as const,
      repairScope: 'revision_superseded' as const,
    })),
  };
}

function revisionIdForEvidence(evidence: EvidenceEnvelope[]): string | undefined {
  const revisionIds = [...new Set(evidence.map((item) => item.revisionId).filter((id): id is string => Boolean(id)))];
  if (revisionIds.length > 1) throw new Error('Evidence from multiple task revisions cannot be verified together');
  return revisionIds[0];
}

async function currentScopeHashes(root: string, evidence: EvidenceEnvelope[]): Promise<Map<string, string>> {
  const { computeScopeHash } = await import('../quality/evidence.js');
  return new Map(await Promise.all(evidence
    .filter((item) => item.scope)
    .map(async (item) => [item.id, await computeScopeHash(root, item.scope?.paths ?? [])] as const)));
}


async function cmdArchive(taskId: string, root: string, options: CommandOptions = {}): Promise<CommandResult> {
  let archivePhase: Phase = 'distill';
  const current = JSON.parse(await readFile(join(root, '.kata/tasks', taskId, 'current-state.json'), 'utf8')) as { phase: Phase };

  if (!options.confirmHostModel) {
    return {
      command: 'archive', taskId, phase: current.phase, success: false,
      error: 'Archive requires explicit user confirmation at the archive trust boundary.',
      diagnostics: { requiresUserConfirmation: true, trustBoundary: 'archive_gate' },
    };
  }

  if (current.phase === 'judge') {
    await guardTransition(options.guard, 'check', taskId, 'distill');
    await transition(taskId, 'distill', actorFor(defaultActor, options.platform), { root });
    await guardTransition(options.guard, 'apply', taskId, 'distill');
  } else if (current.phase !== 'distill' && current.phase !== 'archive') {
    return { command: 'archive', taskId, phase: current.phase, success: false, error: `Archive cannot run from ${current.phase}` };
  }

  const distillation = await distillPassedTaskKnowledge(root, taskId);
  const wikiClosure = await evaluateWikiClosure(root, taskId);
  if (!wikiClosure.valid) {
    const latest = JSON.parse(await readFile(join(root, '.kata/tasks', taskId, 'current-state.json'), 'utf8')) as { phase: Phase };
    return {
      command: 'archive',
      taskId,
      phase: latest.phase,
      success: false,
      error: `Archive blocked; complete Wiki closure (${wikiClosure.reason}).`,
      diagnostics: { wikiClosure, distillation },
    };
  }

  const taskRaw = await readFile(join(root, '.kata/tasks', taskId, 'task.json'), 'utf8');
  const task = JSON.parse(taskRaw) as {
    title: string;
    acceptance: Array<{ id?: string; statement: string }>;
  };

  let judgeRaw: string | null = null;
  try {
    judgeRaw = await readFile(join(root, '.kata/tasks', taskId, 'judge.json'), 'utf8');
  } catch { /* judge result may not exist yet */ }

  let reviewRaw: string | null = null;
  try {
    reviewRaw = await readFile(join(root, '.kata/tasks', taskId, 'review.json'), 'utf8');
  } catch { /* review may not exist yet */ }

  let evidenceIds: string[] = [];
  try {
    const { readdir } = await import('node:fs/promises');
    const files = await readdir(join(root, '.kata/evidence'));
    evidenceIds = files.filter((f) => f.startsWith(`${taskId}-`));
  } catch { /* no evidence yet */ }

  try {
    await guardTransition(options.guard, 'check', taskId, 'archive');
    await transition(taskId, 'archive', actorFor(defaultActor, options.platform), { root });
    await guardTransition(options.guard, 'apply', taskId, 'archive');
    archivePhase = 'archive';
  } catch {
    archivePhase = 'distill';
  }

  let codegraphRefresh: { ok: boolean; output?: string } | undefined;
  if (archivePhase === 'archive') {
    try {
      const { stat } = await import('node:fs/promises');
      await stat(join(root, '.codegraph/index.db'));
      const { execFileSync } = await import('node:child_process');
      const output = execFileSync('codegraph', ['index'], {
        encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 30_000,
      });
      codegraphRefresh = { ok: true, output: output.trim() };
    } catch (error) {
      const nodeError = error as { code?: string };
      if (nodeError?.code === 'ENOENT') {
        codegraphRefresh = { ok: false, output: 'CodeGraph not initialized; skip index refresh.' };
      } else {
        const detail = error instanceof Error ? error.message : String(error);
        codegraphRefresh = { ok: false, output: detail };
      }
    }
  }

  return {
    command: 'archive',
    taskId,
    phase: archivePhase,
    success: archivePhase === 'archive',
    diagnostics: {
      taskTitle: task.title,
      acceptanceCount: task.acceptance.length,
      acceptance: task.acceptance.map((a) => ({ id: a.id, statement: a.statement })),
      evidenceFiles: evidenceIds,
      hasJudgeResult: judgeRaw !== null,
      hasReviewResult: reviewRaw !== null,
      distillation,
      distillationHint: 'Read task artifacts, acceptance criteria, review findings, and judge result. Synthesize decisions, constraints, and norms into a wiki record via proposeFromPassedTask() or kata wiki ingest.',
      ...(codegraphRefresh ? { codegraphRefresh } : {}),
    },
  };
}

async function cmdHotfix(
  taskId: string,
  root: string,
  options: CommandOptions,
): Promise<CommandResult> {
  const openResult = await cmdOpen(taskId, root, {
    title: options.title ?? `Hotfix ${taskId}`,
    acceptance: options.acceptance ?? [{ id: 'AC-1', statement: 'Fix is correct.' }],
    guard: options.guard,
    workflowProfile: options.workflowProfile,
  });
  if (!openResult.success) return openResult;

  const designResult = await cmdDesign(taskId, root, options);
  if (!designResult.success) return designResult;

  const buildResult = await cmdBuild(taskId, root, options);
  if (!buildResult.success) return buildResult;

  const verifyResult = await cmdVerify(taskId, root, options);
  if (!verifyResult.success) return verifyResult;
  return verifyResult;
}

async function cmdTweak(
  taskId: string,
  root: string,
  options: CommandOptions,
): Promise<CommandResult> {
  const openResult = await cmdOpen(taskId, root, {
    title: options.title ?? `Tweak ${taskId}`,
    acceptance: options.acceptance ?? [{ id: 'AC-1', statement: 'Tweak is correct.' }],
    guard: options.guard,
    workflowProfile: options.workflowProfile,
  });
  if (!openResult.success) return openResult;

  await cmdDesign(taskId, root, options);
  const buildResult = await cmdBuild(taskId, root, options);
  if (!buildResult.success) return buildResult;

  const verifyResult = await cmdVerify(taskId, root, options);
  return verifyResult;
}
