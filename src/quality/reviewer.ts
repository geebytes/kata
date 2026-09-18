import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { validate } from '../core/schema.js';
import { reviewPath as layoutReviewPath, taskDir } from '../core/layout.js';

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

  const reviewPath = layoutReviewPath(root, input.taskId);
  await mkdir(taskDir(root, input.taskId), { recursive: true });
  const { currentRevisionIdentity, revisionBindingFields } = await import('../workflow/verdict-binding.js');
  const { mutateTaskArtefact } = await import('../core/state.js');
  // Appending a finding is a read-modify-write of `review.json` — the file that carries the review binding — so it goes
  // through the task lock (L3-09): a concurrent command must not lose either side's findings.
  const binding = revisionBindingFields(await currentRevisionIdentity(root, input.taskId));
  await mutateTaskArtefact(root, input.taskId, reviewPath, async () => {
    let findings: ReviewFinding[] = [];
    let revisionId: string | undefined;
    let status: string | undefined;
    try {
      const parsed = JSON.parse(await readFile(reviewPath, 'utf8')) as { findings?: unknown[]; revisionId?: string; status?: string };
      // findings are validated against review-finding.schema.json: a drifted finding is rejected where it is read.
      findings = (parsed.findings ?? []).map((record) => validate<ReviewFinding>('review-finding', record));
      revisionId = parsed.revisionId;
      status = parsed.status;
    } catch (error) {
      if (!isNodeError(error) || error.code !== 'ENOENT') throw error;
    }
    return `${JSON.stringify({ ...(revisionId ? { revisionId } : {}), ...binding, findings: [...findings, finding], ...(status ? { status } : { status: 'pending' }) }, null, 2)}\n`;
  });

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
