import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readValidatedOptional } from '../core/schema.js';
import type { AcceptanceMatrix } from '../core/task.js';
import type { EvidenceEnvelope } from './evidence.js';
import { evidenceMatchesRow, getMatrixRowForAc } from './acceptance-matrix.js';
import { repairObligationsPath, taskDir } from '../core/layout.js';

export interface RepairObligation {
  id: string;
  taskId: string;
  source: 'review' | 'judge';
  findingId?: string;
  acceptanceId?: string;
  severity: 'blocking';
  message: string;
  createdAt: string;
  resolvedAt?: string;
  resolvedByRevisionId?: string;
  resolvedEvidenceIds?: string[];
}

export interface ObligationRecord {
  obligations: RepairObligation[];
  updatedAt: string;
}

export async function readObligations(root: string, taskId: string): Promise<RepairObligation[]> {
  try {
    const record = await readValidatedOptional<ObligationRecord>('repair-obligations', obligationsPath(root, taskId));
    return record?.obligations ?? [];
  } catch {
    return [];
  }
}

export async function hasUnresolvedObligations(root: string, taskId: string): Promise<boolean> {
  const obligations = await readObligations(root, taskId);
  return obligations.some((o) => !o.resolvedAt);
}

export async function persistBlockingFindings(
  root: string,
  taskId: string,
  findings: Array<{
    id: string;
    acceptanceId?: string;
    severity: string;
    message: string;
  }>,
): Promise<RepairObligation[]> {
  const now = new Date().toISOString();
  let created: RepairObligation[] = [];
  await updateObligations(root, taskId, (existing) => {
    const added: RepairObligation[] = [];
    for (const finding of findings) {
      if (finding.severity !== 'blocking') continue;
      if (existing.some((o) => o.findingId === finding.id && !o.resolvedAt)) continue;
      added.push({
        id: `obligation-${crypto.randomUUID()}`,
        taskId,
        source: 'review',
        findingId: finding.id,
        ...(finding.acceptanceId ? { acceptanceId: finding.acceptanceId } : {}),
        severity: 'blocking',
        message: finding.message,
        createdAt: now,
      });
    }
    created = added;
    return [...existing, ...added];
  });
  return created;
}

export async function persistBlockingJudgeResult(
  root: string,
  taskId: string,
  acceptanceResults: Array<{ id: string; result: string }>,
): Promise<RepairObligation[]> {
  const now = new Date().toISOString();
  let created: RepairObligation[] = [];
  await updateObligations(root, taskId, (existing) => {
    const added: RepairObligation[] = [];
    for (const ac of acceptanceResults) {
      if (ac.result !== 'FAIL') continue;
      if (existing.some((o) => o.acceptanceId === ac.id && o.source === 'judge' && !o.resolvedAt)) continue;
      added.push({
        id: `obligation-${crypto.randomUUID()}`,
        taskId,
        source: 'judge',
        acceptanceId: ac.id,
        severity: 'blocking',
        message: `Judge FAIL for ${ac.id}`,
        createdAt: now,
      });
    }
    created = added;
    return [...existing, ...added];
  });
  return created;
}

export async function resolveObligationsForRevision(
  root: string,
  taskId: string,
  revisionId: string,
  resolvedAcceptanceIds: string[],
  evidenceIds: string[],
  matrix?: AcceptanceMatrix,
  evidence: EvidenceEnvelope[] = [],
): Promise<RepairObligation[]> {
  const now = new Date().toISOString();
  return updateObligations(root, taskId, (existing) => {
    for (const obligation of existing) {
    if (obligation.resolvedAt) continue;
    const row = obligation.acceptanceId ? getMatrixRowForAc(matrix, obligation.acceptanceId) : undefined;
    const matchedEvidence = matrix && row
      ? evidence.filter((item) => item.exitCode === 0 && evidenceMatchesRow(row, item.command, item.kind, item.checkId))
      : evidence.filter((item) => evidenceIds.includes(item.id) && item.exitCode === 0);
    const hasMappedEvidence = !matrix || matchedEvidence.length > 0;
      if (obligation.acceptanceId && resolvedAcceptanceIds.includes(obligation.acceptanceId) && hasMappedEvidence) {
        obligation.resolvedAt = now;
        obligation.resolvedByRevisionId = revisionId;
        obligation.resolvedEvidenceIds = matchedEvidence.map((item) => item.id);
      }
    }
    return existing;
  });
}

export async function reopenObligation(
  root: string,
  taskId: string,
  obligationId: string,
): Promise<boolean> {
  let found = false;
  await updateObligations(root, taskId, (existing) => {
    const obligation = existing.find((o) => o.id === obligationId);
    if (!obligation) return existing;
    found = true;
    obligation.resolvedAt = undefined;
    obligation.resolvedByRevisionId = undefined;
    obligation.resolvedEvidenceIds = undefined;
    return existing;
  });
  return found;
}

function obligationsPath(root: string, taskId: string): string {
  return repairObligationsPath(root, taskId);
}

/**
 * The one way the obligations file is written: read, merge and write inside the task lock, atomically (L3-09).
 *
 * Every caller — a blocking review finding, a Judge FAIL, and the resolver that closes obligations — was a
 * read-modify-write outside any lock, so two of them racing on one task could drop an obligation, and an obligation is
 * what keeps a bounded repair from being closed early. The merge arrives as a function of the freshly-read set, because
 * the lock has to cover the read as much as the write.
 */
async function updateObligations(
  root: string,
  taskId: string,
  merge: (existing: RepairObligation[]) => RepairObligation[],
): Promise<RepairObligation[]> {
  await mkdir(taskDir(root, taskId), { recursive: true });
  let written: RepairObligation[] = [];
  const { mutateTaskArtefact } = await import('../core/state.js');
  await mutateTaskArtefact(root, taskId, obligationsPath(root, taskId), async () => {
    written = merge(await readObligations(root, taskId));
    const record: ObligationRecord = { obligations: written, updatedAt: new Date().toISOString() };
    return `${JSON.stringify(record, null, 2)}\n`;
  });
  return written;
}
