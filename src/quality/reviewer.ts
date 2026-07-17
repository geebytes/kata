import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export type ReviewSeverity = 'blocking' | 'major' | 'minor' | 'note';

export interface ReviewFindingInput {
  root?: string;
  taskId: string;
  acceptanceId?: string;
  severity: ReviewSeverity;
  message: string;
  path?: string;
}

export interface ReviewFinding {
  id: string;
  taskId: string;
  acceptanceId?: string;
  severity: ReviewSeverity;
  message: string;
  path?: string;
}

export async function recordFinding(input: ReviewFindingInput): Promise<ReviewFinding> {
  const root = input.root ?? process.cwd();
  const finding: ReviewFinding = {
    id: `finding-${randomUUID()}`,
    taskId: input.taskId,
    ...(input.acceptanceId ? { acceptanceId: input.acceptanceId } : {}),
    severity: input.severity,
    message: input.message,
    ...(input.path ? { path: input.path } : {}),
  };

  const reviewPath = join(root, '.kata/tasks', input.taskId, 'review.json');
  let findings: ReviewFinding[] = [];
  let revisionId: string | undefined;
  try {
    const parsed = JSON.parse(await readFile(reviewPath, 'utf8')) as { findings?: ReviewFinding[]; revisionId?: string };
    findings = parsed.findings ?? [];
    revisionId = parsed.revisionId;
  } catch (error) {
    if (!isNodeError(error) || error.code !== 'ENOENT') throw error;
  }

  await mkdir(join(root, '.kata/tasks', input.taskId), { recursive: true });
  await writeFile(reviewPath, `${JSON.stringify({ ...(revisionId ? { revisionId } : {}), findings: [...findings, finding] }, null, 2)}\n`, 'utf8');

  if (finding.severity === 'blocking') {
    const { persistBlockingFindings } = await import('./repair-obligations.js');
    await persistBlockingFindings(root, input.taskId, [{
      id: finding.id,
      acceptanceId: input.acceptanceId,
      severity: finding.severity,
      message: finding.message,
    }]);
  }

  return finding;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
