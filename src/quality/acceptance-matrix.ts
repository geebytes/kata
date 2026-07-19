import { execFile } from 'node:child_process';
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

export function evidenceMatchesRow(
  row: AcceptanceMatrixRow,
  evidenceCommand: string,
  evidenceKind: string,
): boolean {
  for (const decl of row.evidence) {
    const kindMatch = decl.kind === evidenceKind;
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

  const sourcesByCandidate = new Map<string, string[]>();
  for (const sourcePath of sourcePaths) {
    const affectedTests = await runAffected(root, [sourcePath]);
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
