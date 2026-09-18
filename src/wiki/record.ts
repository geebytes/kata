import { createHash } from 'node:crypto';
import { validate } from '../core/schema.js';
import { hashContent } from '../core/hash.js';

export type WikiStatus = 'candidate' | 'verified' | 'stale' | 'rejected';

/**
 * Where a record's authority comes from (L4-07).
 *
 * Two stores hold "what is known": the governed records here and the documentation pages under `.llmwiki`. They were
 * joined by a convention — an ingested record put `.llmwiki/...` in `sourceRefs` and `llmwiki-ingest` in
 * `validationTaskId` — and authority was then decided by matching `sourceRefs`, so a summary of a page counted as
 * knowledge about whatever that page happened to cite.
 *
 * The dimension makes the difference explicit and checkable:
 *   - `source` — the record cites files in the repository, and its hashes are theirs;
 *   - `ingested` — the record summarises a documentation page; it may be read, but it is not authority about the code;
 *   - `distilled` — a task distilled it from sources it cites (the ordinary case);
 *   - `verified` — a human or a passing task confirmed it after distillation.
 */
export type WikiProvenance = 'source' | 'ingested' | 'verified' | 'distilled';

export interface WikiRecord {
  id: string;
  statement: string;
  scope: string[];
  kind: string;
  sourceRefs: string[];
  sourceHashes: Record<string, string>;
  validationTaskId: string;
  /**
   * Absent on records written before the dimension existed; the reader infers it (`inferProvenance`) rather than
   * pretending the record declared something it did not.
   */
  provenance?: WikiProvenance;
  evidenceIds: string[];
  status: WikiStatus;
  lastVerifiedAt: string;
  createdAt: string;
  updatedAt: string;
  approvalEvent?: {
    approvedBy: string;
    role: string;
    approvedAt: string;
    notes?: string;
  };
  rejectionEvent?: {
    rejectedBy: string;
    role: string;
    rejectedAt: string;
    reason: string;
  };
}

/** @deprecated Use `hashContent` from core/hash.js; kept so existing importers keep working. */
export const computeFileHash = hashContent;

export function validateWikiRecord(value: unknown): WikiRecord {
  return validate<WikiRecord>('wiki-record', value);
}

/**
 * The provenance of a record that does not declare one: the convention it used, read as what it means.
 *
 * An ingested record was marked by `validationTaskId: 'llmwiki-ingest'` and cites `.llmwiki/` paths; anything else is a
 * task's distillation. This is deliberately a **reader**, not a migration: no record is rewritten, and a record that
 * declares its provenance is believed.
 */
export function inferProvenance(record: Pick<WikiRecord, 'provenance' | 'validationTaskId' | 'sourceRefs'>): WikiProvenance {
  if (record.provenance) return record.provenance;
  if (record.validationTaskId.startsWith('llmwiki-')) return 'ingested';
  return record.sourceRefs.some((ref) => ref.startsWith('.llmwiki/')) ? 'ingested' : 'distilled';
}
