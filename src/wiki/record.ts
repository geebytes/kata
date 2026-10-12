import { createHash } from 'node:crypto';
import { validate } from '../core/schema.js';
import { hashContent } from '../core/hash.js';
import { llmwikiDirName } from '../core/repository-identity.js';

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
/**
 * **Whether a record carries a decision — the one derivation both guards ask.**
 *
 * Two guards need this fact: the store's replacement guard and the re-derivation guard. They were written separately, and
 * they disagreed on exactly the state the tool itself produces: the drift walk withdraws a `verified` record's approval by
 * demoting it, leaving `status: 'stale'` with an `approvalEvent`, which the store's predicate read as "no decision" while the
 * re-derivation predicate read as "decided" (measured by an independent round). "Does this record carry a decision" is one
 * question about one record, so it is answered here and asked by both.
 */
export function carriesDecision(record: Pick<WikiRecord, 'status' | 'approvalEvent' | 'rejectionEvent'>): boolean {
  return (
    record.status === 'verified' ||
    record.status === 'rejected' ||
    record.approvalEvent !== undefined ||
    record.rejectionEvent !== undefined
  );
}

/**
 * **Whether a record's two halves describe the same set of sources — one derivation, asked by the walk and by the refusal.**
 *
 * A record says what it came from twice: `sourceRefs` (the paths) and `sourceHashes` (the digests). They are written together
 * and must agree; when they do not, the record cannot be re-derived, because which file a digest belongs to is not knowable.
 *
 * The two directions are one question with three answers, and this is the third round in which they were treated separately:
 * the walk named only the `declared-not-hashed` direction (round 5) and the refusal named both, so a record whose hash map
 * lists a path its refs do not declare was reported `source_changed` and the lifecycle recommended `revalidate` — the command
 * that refuses that record by name (measured by an independent round). One predicate, so neither side can answer only half of
 * it again.
 */
export type SourceHalvesAgreement = 'agree' | 'declared-not-hashed' | 'hashed-not-declared';

export function sourceHalvesAgreement(record: Pick<WikiRecord, 'sourceRefs' | 'sourceHashes'>): SourceHalvesAgreement {
  const declaredNotHashed = record.sourceRefs.filter((path) => record.sourceHashes[path] === undefined);
  const hashedNotDeclared = Object.keys(record.sourceHashes).filter((path) => !record.sourceRefs.includes(path));
  if (declaredNotHashed.length > 0) return 'declared-not-hashed';
  if (hashedNotDeclared.length > 0) return 'hashed-not-declared';
  return 'agree';
}

/** The paths a disagreement is about, in the direction it found. */
export function sourceHalvesDisagreement(record: Pick<WikiRecord, 'sourceRefs' | 'sourceHashes'>): string[] {
  const agreement = sourceHalvesAgreement(record);
  if (agreement === 'declared-not-hashed') return record.sourceRefs.filter((path) => record.sourceHashes[path] === undefined);
  if (agreement === 'hashed-not-declared') return Object.keys(record.sourceHashes).filter((path) => !record.sourceRefs.includes(path));
  return [];
}

/** The file a record id lives in, derived once — the drift check asks the same question the store answers. */
export function wikiRecordFileName(id: string): string {
  return `${id.replace(/[^a-zA-Z0-9._-]/g, '_')}.json`;
}

/**
 * Whether a source reference points at a page under the Wiki directory.
 *
 * The name comes from the policy constant, and the writers that build these refs use the same constant, so "is this a page"
 * is not a shape guess in several places that can drift apart.
 */
export function isWikiPageRef(ref: string): boolean {
  return ref.startsWith(`${llmwikiDirName}/`);
}

export function inferProvenance(record: Pick<WikiRecord, 'provenance' | 'validationTaskId' | 'sourceRefs'>): WikiProvenance {
  if (record.provenance) return record.provenance;
  if (record.validationTaskId.startsWith('llmwiki-')) return 'ingested';
  return record.sourceRefs.some((ref) => isWikiPageRef(ref)) ? 'ingested' : 'distilled';
}
