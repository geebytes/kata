import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readValidatedOptional } from '../core/schema.js';
import type { AcceptanceMatrix } from '../core/task.js';
import type { EvidenceEnvelope } from './evidence.js';
import { evidenceMatchesRow, getMatrixRowForAc } from './acceptance-matrix.js';
import { isTerminalSeverity } from './finding-lifecycle.js';
import { repairObligationsPath, taskDir } from '../core/layout.js';

export interface RepairObligation {
  id: string;
  taskId: string;
  source: 'review' | 'judge';
  findingId?: string;
  acceptanceId?: string;
  /** The severity the obligation was raised for: the terminal classes, which are the ones that gate a node. */
  severity: 'blocking' | 'major';
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
      // The rule, not a literal: `isTerminalSeverity` is what the navigation ladder, the adversarial gate and the batch
      // closure all use, so a severity that gates a node creates the obligation that lets it be accounted for. Hardcoding
      // `'blocking'` here was how a `major` finding came to gate approval and then be permanently unclosable — the batch
      // reads `answered` from resolved obligations, and no obligation was ever created.
      if (!isTerminalSeverity(finding.severity)) continue;
      if (existing.some((o) => o.findingId === finding.id && !o.resolvedAt)) continue;
      added.push({
        id: `obligation-${crypto.randomUUID()}`,
        taskId,
        source: 'review',
        findingId: finding.id,
        ...(finding.acceptanceId ? { acceptanceId: finding.acceptanceId } : {}),
        // The finding's own severity, narrowed to the terminal classes — an obligation that claimed `blocking` for a
        // `major` finding would misreport what is owed.
        severity: finding.severity === 'blocking' ? 'blocking' : 'major',
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

/**
 * Whether one obligation is answered by a revision's evidence — the **one** rule the seal and the resolver share.
 *
 * `collectSealPreflight` refuses a seal while an obligation lacks a `resolvedAt`, and it runs *before* the checks; the
 * resolver runs *after* them. Deciding answerability in two places let the seal refuse an obligation the run was about to
 * answer, which is a deadlock: the refusal stopped the very run that would have produced the evidence. Both callers
 * consult this, so they cannot drift — a seal that passes while leaving the obligation unresolved is then impossible by
 * construction rather than by review.
 *
 * The matrix is an enrichment of the mapping, not a precondition: with one, an obligation scoped to a criterion waits for
 * evidence matching that criterion's row; without one, the criterion being satisfied and the revision carrying passing
 * evidence is the whole answer.
 */
export function obligationIsAnswered(input: {
    obligation: RepairObligation;
    resolvedAcceptanceIds: string[];
    evidence: EvidenceEnvelope[];
    matrix?: AcceptanceMatrix;
}): { answered: boolean; evidenceIds: string[] } {
    const { obligation, resolvedAcceptanceIds, evidence, matrix } = input;
    const row = obligation.acceptanceId ? getMatrixRowForAc(matrix, obligation.acceptanceId) : undefined;
    const matchedEvidence = matrix && row
        ? evidence.filter((item) => item.exitCode === 0 && evidenceMatchesRow(row, item.command, item.kind, item.checkId))
        : evidence.filter((item) => item.exitCode === 0);
    const evidenceIds = matchedEvidence.map((item) => item.id);
    const answered = obligation.acceptanceId
        ? resolvedAcceptanceIds.includes(obligation.acceptanceId) && (!matrix || evidenceIds.length > 0)
        : evidenceIds.length > 0;
    return { answered, evidenceIds };
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
      const verdict = obligationIsAnswered({ obligation, resolvedAcceptanceIds, evidence, ...(matrix ? { matrix } : {}) });
      if (!verdict.answered) continue;
      obligation.resolvedAt = now;
      obligation.resolvedByRevisionId = revisionId;
      obligation.resolvedEvidenceIds = verdict.evidenceIds;
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
