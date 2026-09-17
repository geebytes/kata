import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { codeGraphExecutionEnv } from '../codegraph/runtime.js';
import type { AcceptanceCriterion, AcceptanceMatrix, AcceptanceMatrixRow } from '../core/task.js';

const execFileAsync = promisify(execFile);

export interface MatrixValidationError {
  acceptanceId?: string;
  message: string;
}

export interface PathCoverageResult {
  missingImplementationPaths: string[];
  missingTestPaths: string[];
}

export interface CodeGraphCandidate {
  path: string;
  reason: string;
  sourcePaths: string[];
}

export type CodeGraphAffectedRunner = (root: string, sourcePaths: string[]) => Promise<string[]>;

export interface CodeGraphCandidateDisposition {
  evidenceCoveredCandidates: CodeGraphCandidate[];
  ownedCandidates: CodeGraphCandidate[];
  waivedCandidates: CodeGraphCandidate[];
  unresolvedCandidates: CodeGraphCandidate[];
}

export interface Waiver {
  path: string;
  reason: string;
  approvedBy: string;
  createdAt: string;
}

export function requiresMatrix(workflowProfile?: { strictClosure?: boolean; reviewMode?: string }): boolean {
  return workflowProfile?.strictClosure === true || workflowProfile?.reviewMode === 'strict';
}

/**
 * Upstream coverage (mapping upstream doc requirements to ACs, or marking them
 * out-of-scope) is a **new** gate and is therefore opt-in via the dedicated
 * `strictClosure` flag only — it must NOT be inferred from `reviewMode: 'strict'`.
 *
 * Why the distinction matters: `requiresMatrix` (strict ⇒ acceptance matrix) is a
 * long-standing requirement that existing strict tasks already satisfy; upstream
 * coverage is stricter still and would retroactively block every in-flight strict
 * task that never declared coverage. Coupling them silently breaks the existing
 * lifecycle (observed: design returns phase=intake, then build fails with
 * "Build cannot run from intake").
 */
export function requiresUpstreamCoverage(workflowProfile?: { strictClosure?: boolean; reviewMode?: string }): boolean {
  return workflowProfile?.strictClosure === true;
}

export function validateMatrix(
  acceptance: AcceptanceCriterion[],
  matrix: AcceptanceMatrix | undefined,
): MatrixValidationError[] {
  if (!matrix) return [];

  const errors: MatrixValidationError[] = [];
  const acIds = new Set(acceptance.map((ac) => ac.id).filter((id): id is string => Boolean(id)));
  const matrixAcIds = new Set<string>();

  if (matrix.version !== 1) {
    errors.push({ message: 'Unsupported acceptance matrix version' });
    return errors;
  }

  for (const row of matrix.rows) {
    if (!acIds.has(row.acceptanceId)) {
      errors.push({
        acceptanceId: row.acceptanceId,
        message: `Matrix row references unknown acceptance criterion: ${row.acceptanceId}`,
      });
    }
    matrixAcIds.add(row.acceptanceId);

    if (!row.implementationPaths || row.implementationPaths.length === 0) {
      errors.push({
        acceptanceId: row.acceptanceId,
        message: `Matrix row for ${row.acceptanceId} must declare at least one implementation path`,
      });
    }

    if (!row.testPaths || row.testPaths.length === 0) {
      errors.push({
        acceptanceId: row.acceptanceId,
        message: `Matrix row for ${row.acceptanceId} must declare at least one test path`,
      });
    }

    if (!row.evidence || row.evidence.length === 0) {
      errors.push({
        acceptanceId: row.acceptanceId,
        message: `Matrix row for ${row.acceptanceId} must declare at least one evidence item`,
      });
    }

    for (const declaration of row.evidence ?? []) {
      if (!hasRequiredEvidenceLevel(row, declaration.kind)) {
        errors.push({
          acceptanceId: row.acceptanceId,
          message: `Matrix row for ${row.acceptanceId} declares a ${row.verificationLevel}-level acceptance but only ${declaration.kind} evidence`,
        });
      }
    }

    for (const path of [...row.implementationPaths, ...row.testPaths]) {
      if (path.includes('..') || path.startsWith('/') || path.includes(':\\')) {
        errors.push({
          acceptanceId: row.acceptanceId,
          message: `Matrix path must be repository-relative: ${path}`,
        });
      }
    }
  }

  for (const acId of acIds) {
    if (!matrixAcIds.has(acId)) {
      errors.push({
        acceptanceId: acId,
        message: `Acceptance criterion ${acId} has no matrix row`,
      });
    }
  }

  return errors;
}

export function isLegacyTask(matrix: AcceptanceMatrix | undefined): boolean {
  return !matrix;
}

export function getMatrixRowForAc(
  matrix: AcceptanceMatrix | undefined,
  acceptanceId: string,
): AcceptanceMatrixRow | undefined {
  return matrix?.rows.find((row) => row.acceptanceId === acceptanceId);
}


export interface UpstreamCoverageError {
  requirementId?: string;
  sourceRef?: string;
  message: string;
}

/**
 * Validate that every upstream requirement maps to an existing AC or is explicitly
 * out-of-scope, and that every mapped AC exists in the matrix. This prevents the
 * self-authored-AC failure mode where task scope silently excludes upstream docs.
 *
 * Rules:
 *  1. Every requirement maps to an AC or declares outOfScopeReason.
 *  2. A mapped AC must exist in `acceptance` and have a matrix row.
 *  3. Reverse completeness: every acceptance AC is covered by ≥1 requirement
 *     (no orphan ACs that no upstream requirement justifies).
 *  4. When `root` is given, each source ref must point to an existing file.
 */
export function validateUpstreamCoverage(
  acceptance: Array<{ id?: string; statement: string }>,
  matrix: AcceptanceMatrix | undefined,
  coverage: import('../core/task.js').UpstreamCoverage | undefined,
  root?: string,
): UpstreamCoverageError[] {
  if (!coverage) return [];
  if (coverage.version !== 1) return [{ message: 'Unsupported upstream coverage version' }];
  const acIds = new Set(acceptance.map((ac) => ac.id).filter((id): id is string => Boolean(id)));
  const matrixAcIds = new Set((matrix?.rows ?? []).map((r) => r.acceptanceId));
  const errors: UpstreamCoverageError[] = [];

  for (const source of coverage.sources) {
    if (root && source.ref) {
      try {
        if (!existsSync(join(root, source.ref))) {
          errors.push({ sourceRef: source.ref, message: `Upstream source ref does not exist: ${source.ref}` });
        }
      } catch {
        errors.push({ sourceRef: source.ref, message: `Upstream source ref unreadable: ${source.ref}` });
      }
    }
    if (!source.ref || !source.requirements?.length) {
      errors.push({ sourceRef: source.ref, message: `Upstream source ${source.ref} must declare a ref and at least one requirement` });
      continue;
    }
    for (const req of source.requirements) {
      const mapped = req.mappedTo ?? null;
      const hasReason = Boolean(req.outOfScopeReason?.trim());
      if (!mapped && !hasReason) {
        errors.push({
          requirementId: req.id,
          sourceRef: source.ref,
          message: `Requirement ${req.id} in ${source.ref} must map to an AC or declare outOfScopeReason`,
        });
      }
      if (mapped) {
        if (!acIds.has(mapped)) {
          errors.push({ requirementId: req.id, sourceRef: source.ref, message: `Requirement ${req.id} maps to unknown AC ${mapped}` });
        } else if (!matrixAcIds.has(mapped)) {
          errors.push({ requirementId: req.id, sourceRef: source.ref, message: `Requirement ${req.id} maps to AC ${mapped} which has no matrix row` });
        }
      }
    }
  }
  return errors;
}

/**
 * Rule 3 (warning, not error): find acceptance criteria not justified by any
 * upstream requirement (orphan ACs). Reported as a warning so tasks with an
 * intentionally broader AC surface are not blocked, but reviewers see the gap.
 */
export function findOrphanAcs(
  acceptance: Array<{ id?: string; statement: string }>,
  coverage: import('../core/task.js').UpstreamCoverage | undefined,
): Array<{ acId: string }> {
  if (!coverage) return [];
  const coveredAcIds = new Set<string>();
  for (const source of coverage.sources) {
    for (const req of source.requirements ?? []) {
      if (req.mappedTo) coveredAcIds.add(req.mappedTo);
    }
  }
  return acceptance
    .map((ac) => ac.id)
    .filter((id): id is string => Boolean(id))
    .filter((id) => !coveredAcIds.has(id))
    .map((acId) => ({ acId }));
}

export function validatePathCoverage(
  matrix: AcceptanceMatrix | undefined,
  ownedPaths: string[],
): PathCoverageResult {
  if (!matrix) return { missingImplementationPaths: [], missingTestPaths: [] };

  const missingImplementationPaths: string[] = [];
  const missingTestPaths: string[] = [];

  for (const row of matrix.rows) {
    for (const implPath of row.implementationPaths) {
      if (!ownedPaths.some((owned) => pathOverlaps(owned, implPath))) {
        missingImplementationPaths.push(implPath);
      }
    }
    for (const testPath of row.testPaths) {
      if (!ownedPaths.some((owned) => pathOverlaps(owned, testPath))) {
        missingTestPaths.push(testPath);
      }
    }
  }

  return { missingImplementationPaths, missingTestPaths };
}

export function pathOverlaps(owned: string, target: string): boolean {
  const o = normalizePath(owned);
  const t = normalizePath(target);
  return o === t || t.startsWith(`${o}/`) || o.startsWith(`${t}/`);
}

function normalizePath(path: string): string {
  return path.replaceAll('\\', '/').replace(/\/+$/, '');
}

export function isEntrypointEvidenceKind(kind: string): boolean {
  return kind === 'integration' || kind === 'entrypoint';
}

export function hasRequiredEvidenceLevel(
  row: AcceptanceMatrixRow,
  evidenceKind: string,
): boolean {
  if (row.verificationLevel === 'unit') return true;
  if (row.verificationLevel === 'integration') {
    return evidenceKind === 'integration' || evidenceKind === 'entrypoint' || evidenceKind === 'test';
  }
  if (row.verificationLevel === 'entrypoint') {
    return evidenceKind === 'entrypoint' || evidenceKind === 'integration';
  }
  return true;
}

function selectorMatches(evidenceCommand: string, testSelector: string): boolean {
  if (evidenceCommand.includes(testSelector)) return true;
  const withoutCommonPrefix = testSelector.replace(/^(?:kata\/|packages\/[^/]+\/)?/, '');
  if (withoutCommonPrefix !== testSelector && evidenceCommand.includes(withoutCommonPrefix)) return true;
  return false;
}

/**
 * Whether a recorded envelope satisfies a matrix row.
 *
 * Identity first: the declaration carries an `id`, the runner resolved it to a check carrying the same id, and the
 * evidence names it — so a rename, a wrapper script or a differently worded but equivalent command cannot change the
 * verdict. A declaration without an id, or evidence recorded before ids existed, falls back to the textual comparison
 * this used to be the only path.
 */
export function evidenceMatchesRow(
  row: AcceptanceMatrixRow,
  evidenceCommand: string,
  evidenceKind: string,
  checkId?: string,
): boolean {
  for (const decl of row.evidence) {
    const kindMatch = decl.kind === evidenceKind && hasRequiredEvidenceLevel(row, evidenceKind);
    if (decl.id !== undefined && checkId !== undefined) {
      if (decl.id === checkId && kindMatch) return true;
      continue;
    }
    const commandMatch = evidenceCommand.includes(decl.command)
      || (decl.command.startsWith('vitest ') && /(?:^|\/)vitest(?:\.mjs)?\s+run\b/.test(evidenceCommand))
      || (decl.command.startsWith('tsc ') && /(?:^|\/)tsc\s+/.test(evidenceCommand));
    const selectorMatch = !decl.testSelector || selectorMatches(evidenceCommand, decl.testSelector);
    if (kindMatch && commandMatch && selectorMatch) return true;
  }
  return false;
}

export async function discoverCodeGraphCandidates(
  root: string,
  matrix: AcceptanceMatrix,
  ownedPaths: string[],
  runAffected: CodeGraphAffectedRunner = runCodeGraphAffected,
): Promise<CodeGraphCandidate[]> {
  const sourcePaths = [...new Set(matrix.rows
    .flatMap((row) => row.implementationPaths)
    .filter((path) => ownedPaths.some((owned) => pathOverlaps(owned, path))))];
  if (sourcePaths.length === 0) return [];

  // One query per implementation path, run concurrently: each answer attributes an affected test to the path that
  // dragged it in, which is what the reviewer reads. A single batched `affected` call would return a flat list and lose
  // that attribution, so the cost is paid in parallel rather than by dropping the information.
  const sourcesByCandidate = new Map<string, string[]>();
  const perPath = await Promise.all(sourcePaths.map(async (sourcePath) => ({
    sourcePath,
    affectedTests: await runAffected(root, [sourcePath]),
  })));
  for (const { sourcePath, affectedTests } of perPath) {
    for (const affectedTest of affectedTests) {
      const path = normalizePath(affectedTest);
      const sources = sourcesByCandidate.get(path) ?? [];
      if (!sources.includes(sourcePath)) sources.push(sourcePath);
      sourcesByCandidate.set(path, sources);
    }
  }

  return [...sourcesByCandidate.entries()].map(([path, candidateSources]) => ({
    path,
    sourcePaths: candidateSources,
    reason: `CodeGraph reports this test is affected by sealed implementation paths: ${candidateSources.join(', ')}`,
  }));
}

export interface RequirementWithoutEvidence {
  requirementId: string;
  sourceRef: string;
  mappedTo: string;
}

/**
 * Find upstream requirements whose mappedTo AC has NO matching passing evidence.
 * This is the seal-time check that a requirement is genuinely implemented (not just
 * declared): every mapped requirement must be backed by the AC's matrix evidence.
 */
export function findRequirementsWithoutEvidence(
  coverage: import('../core/task.js').UpstreamCoverage | undefined,
  matrix: AcceptanceMatrix | undefined,
  evidence: Array<{ id: string; kind: string; command: string; exitCode: number; checkId?: string }>,
): RequirementWithoutEvidence[] {
  if (!coverage) return [];
  const passing = evidence.filter((e) => e.exitCode === 0);
  const missing: RequirementWithoutEvidence[] = [];
  for (const source of coverage.sources) {
    for (const req of source.requirements ?? []) {
      const mapped = req.mappedTo ?? null;
      if (!mapped) continue; // out-of-scope or unmapped handled elsewhere
      const row = matrix?.rows.find((r) => r.acceptanceId === mapped);
      if (!row) {
        missing.push({ requirementId: req.id, sourceRef: source.ref, mappedTo: mapped });
        continue;
      }
      const hasEvidence = passing.some((e) => evidenceMatchesRow(row, e.command, e.kind, e.checkId));
      if (!hasEvidence) {
        missing.push({ requirementId: req.id, sourceRef: source.ref, mappedTo: mapped });
      }
    }
  }
  return missing;
}


export function classifyCodeGraphCandidates(
  matrix: AcceptanceMatrix,
  ownedPaths: string[],
  waivers: Waiver[],
  candidates: CodeGraphCandidate[],
): CodeGraphCandidateDisposition {
  const disposition: CodeGraphCandidateDisposition = {
    evidenceCoveredCandidates: [],
    ownedCandidates: [],
    waivedCandidates: [],
    unresolvedCandidates: [],
  };
  const waivedPaths = new Set(waivers.map((waiver) => normalizePath(waiver.path)));

  for (const candidate of candidates) {
    const path = normalizePath(candidate.path);
    if (isEvidenceCoveredCandidate(matrix, path)) {
      disposition.evidenceCoveredCandidates.push(candidate);
    } else if (ownedPaths.some((owned) => pathOverlaps(owned, path))) {
      disposition.ownedCandidates.push(candidate);
    } else if (waivedPaths.has(path)) {
      disposition.waivedCandidates.push(candidate);
    } else {
      disposition.unresolvedCandidates.push(candidate);
    }
  }
  return disposition;
}

function isEvidenceCoveredCandidate(matrix: AcceptanceMatrix, candidatePath: string): boolean {
  return matrix.rows.some((row) => row.testPaths.some((path) => normalizePath(path) === candidatePath)
    && row.evidence.some((evidence) => !evidence.testSelector || candidatePath.includes(evidence.testSelector)));
}

async function runCodeGraphAffected(root: string, sourcePaths: string[]): Promise<string[]> {
  const binary = process.env.STRATA_CODEGRAPH_BIN || 'codegraph';
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(binary, ['affected', ...sourcePaths], {
      cwd: root,
      maxBuffer: 1024 * 1024,
      env: codeGraphExecutionEnv(),
    }));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`CodeGraph candidate discovery failed; strict sealing is refused: ${detail}`);
  }

  const output = stripAnsi(stdout);
  const reportsNoAffectedTests = /no .*test files.*affected|no .*affected.*test files/i.test(output);
  if (!output.includes('Affected test files') && !reportsNoAffectedTests) {
    throw new Error('CodeGraph candidate discovery returned an unrecognised result; strict sealing is refused.');
  }
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .map((line) => line.replace(/^[•*-]\s*/, ''))
    .filter((line) => isRepositoryRelativeTestPath(line));
}

function stripAnsi(value: string): string {
  return value.replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, '');
}

function isRepositoryRelativeTestPath(value: string): boolean {
  return !value.startsWith('/')
    && !value.includes('..')
    && /(?:^|\/)(?:[^/]+\.)?(?:test|spec)\.[cm]?[jt]sx?$|(?:^|\/)test_[^/]+\.py$|(?:^|\/)[^/]+_test\.py$/.test(value);
}

export async function readWaivers(root: string, taskId: string): Promise<Waiver[]> {
  try {
    const { readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const raw = await readFile(join(root, '.kata/tasks', taskId, 'waivers.json'), 'utf8');
    return (JSON.parse(raw) as { waivers: Waiver[] }).waivers;
  } catch {
    return [];
  }
}

export async function writeWaivers(root: string, taskId: string, waivers: Waiver[]): Promise<void> {
  const { mkdir, writeFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  await mkdir(join(root, '.kata/tasks', taskId), { recursive: true });
  await writeFile(
    join(root, '.kata/tasks', taskId, 'waivers.json'),
    `${JSON.stringify({ waivers, updatedAt: new Date().toISOString() }, null, 2)}\n`,
    'utf8',
  );
}

export function validateWaivers(waivers: Waiver[]): string[] {
  return waivers.flatMap((waiver) => {
    const missing = [
      !waiver.path?.trim() ? 'path' : undefined,
      !waiver.reason?.trim() ? 'reason' : undefined,
      !waiver.approvedBy?.trim() ? 'approvedBy' : undefined,
      !waiver.createdAt?.trim() ? 'createdAt' : undefined,
    ].filter((field): field is string => Boolean(field));
    return missing.length > 0 ? [`Waiver for ${waiver.path || '<unknown>'} is missing ${missing.join(', ')}`] : [];
  });
}
