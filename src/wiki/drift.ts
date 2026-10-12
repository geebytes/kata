import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { computeFileHash } from './record.js';
import { statementForPage } from './llmwiki.js';
import { normalizeId, readWikiRecords, readWikiRecordsWithIssues, updateWikiRecord } from './store.js';
import type { WikiStatus as WikiRecordStatus } from './record.js';

export interface DriftEntry {
  id: string;
  /** Why the record is no longer consistent with its sources. The *cause*: a file moved, or is gone. */
  reason: 'source_changed' | 'source_missing';
  changedSources: string[];
  /**
   * Whether the walk took an approval away with it, which is a second fact about the same record.
   *
   * **Its own field, not a new value of `reason`.** The cause of the drift is a file moving — the same cause a candidate
   * record has — and folding "an approval was withdrawn" into that vocabulary would have made every reader of `reason`
   * learn a value that answers a different question (it did: one consumer's union and one case had to move for it). Here the
   * cause stays the cause, and the consequence is additive: a reader that only cares why the sources stopped matching is
   * unaffected, and one that cares about authority reads this field.
   */
  approvalWithdrawn?: boolean;
}

export interface DriftReport {
  checked: number;
  intact: string[];
  stale: DriftEntry[];
  missing: string[];
}

export async function verifySources(root: string): Promise<DriftReport> {
  const records = await readWikiRecords(root);
  const intact: string[] = [];
  const stale: DriftEntry[] = [];
  const missingSources = new Set<string>();

  for (const record of records) {
    if (record.status === 'rejected') {
      intact.push(record.id);
      continue;
    }

    const changedSources: string[] = [];
    const sourceHashEntries = Object.entries(record.sourceHashes);

    if (record.sourceRefs.length > 0 && sourceHashEntries.length === 0) {
      stale.push({
        id: record.id,
        reason: 'source_missing',
        changedSources: [...record.sourceRefs],
        ...(withdrawingAuthority(record) ? { approvalWithdrawn: true } : {}),
      });
      for (const sourceRef of record.sourceRefs) missingSources.add(sourceRef);
      await markRecordStale(root, record.id);
      continue;
    }

    for (const [sourcePath, expectedHash] of sourceHashEntries) {
      try {
        const absolutePath = join(root, sourcePath);
        const content = await readFile(absolutePath, 'utf8');
        const currentHash = computeFileHash(content);
        if (currentHash !== expectedHash) {
          changedSources.push(sourcePath);
        }
      } catch {
        changedSources.push(sourcePath);
        missingSources.add(sourcePath);
      }
    }

    if (changedSources.length > 0) {
      const reason = changedSources.some((s) => missingSources.has(s)) ? 'source_missing' : 'source_changed';
      stale.push({ id: record.id, reason, changedSources, ...(withdrawingAuthority(record) ? { approvalWithdrawn: true } : {}) });
      await markRecordStale(root, record.id);
    } else {
      intact.push(record.id);
    }
  }

  return {
    checked: records.length,
    intact,
    stale,
    missing: [...missingSources].sort(),
  };
}

/**
 * Mark one record stale, the way the drift walk does it.
 *
 * **The walk used to write this itself, twice**, which is the same write in three places: this function, the missing-source
 * branch and the changed-source branch. A reader asking "what does marking a record stale do" had three answers, and the
 * wiring check reported this one as having no consumer while the two copies were the consumers.
 */
export async function markRecordStale(root: string, id: string): Promise<void> {
  await updateWikiRecord(root, id, { status: 'stale' });
}

/**
 * Whether the drift walk is taking an approval away from this record, or merely restating that a candidate is out of date.
 *
 * Read before the write, because the write is what removes the evidence: after `markRecordStale` the record is `stale` and
 * nobody can tell whether an approval was withdrawn.
 */
function withdrawingAuthority(record: { status: string; approvalEvent?: unknown }): boolean {
  return record.status === 'verified' || record.approvalEvent !== undefined;
}

export interface RevalidationResult {
  id: string;
  status: WikiRecordStatus;
  /** The sources whose recorded hash was refreshed (empty = the record was already consistent). */
  refreshed: string[];
  /**
   * Whether the record's `statement` was recomputed, and why not when it was not.
   *
   * **Half the work is a fact a caller has to be able to read.** A statement is recomputed only for a record whose writer
   * composed it out of the page (`llmwiki-register`); for every other record the hash moves and the prose deliberately does
   * not, so "re-derived" must not read as "the whole record follows its sources now".
   */
  statement: { recomputed: boolean; why: string };
}

/**
 * The transition out of `stale`.
 *
 * `verifySources` marks a record stale when its sources change, and nothing could move it back: `register` skips an id
 * that already exists, `promote` requires `candidate`, and `rebuild` clears the whole store. A record for a page that
 * was edited even once was therefore stale **forever** — so the closure gate could keep reading a record whose sources
 * no longer matched, indefinitely.
 *
 * Revalidation returns the record to `candidate`, not to `verified`: refreshing a hash is a mechanical fact about the
 * files, while "verified" is a governance claim that goes through promotion (and its passing validation task) like any
 * other. That keeps the state machine's meaning intact instead of adding a bypass for the case that mattered today.
 */
export async function revalidateWikiRecord(root: string, id: string): Promise<RevalidationResult> {
  const { records, invalid: invalidRecords } = await readWikiRecordsWithIssues(root);
  const record = records.find((entry) => entry.id === normalizeId(id));
  if (!record) {
    const invalid = invalidRecords.find((entry) => entry.path.endsWith(`${normalizeId(id)}.json`));
    throw new Error(
      invalid
        ? `Wiki record ${id} cannot be revalidated because it does not match its schema: ${invalid.message}`
        : `Wiki record ${id} was not found under .kata/wiki/`,
    );
  }

  // **Only the states whose move this function may perform.** Re-derivation is the transition *out of* `stale`; a `verified`
  // record's authority came from promotion (a passing validation task) and a `rejected` record was refused by a person, so
  // neither may be turned into a `candidate` — the status the closure gate accepts — by refreshing a hash. The first version
  // guarded only `verified`, so a `rejected` record was resurrected into an acceptable one (measured by an independent
  // round), and the bulk route reached `verified` records *through* the drift walk, which demotes them before this code runs
  // (see `revalidateStaleRecords`).
  // A record that carries an `approvalEvent` was approved at some point; if it is not `verified` now, that approval was
  // withdrawn (the drift walk demotes a verified record whose sources moved). Refreshing its hashes would hand back a
  // `candidate`, which the closure gate accepts — the approval would come back weaker than it went in. The fact lives in
  // the record itself, so this holds on every route and on every later run, not only in the run that noticed the drift.
  if (record.status === 'verified' || record.status === 'rejected' || record.approvalEvent !== undefined) {
    const why =
      record.status === 'verified' || record.status === 'rejected'
        ? `is ${record.status}`
        : 'carries an approval that was withdrawn when its sources moved';
    throw new Error(
      `Wiki record ${id} ${why}, and re-derivation never turns an approved or rejected record into a candidate: it is the transition out of \`stale\`, so this needs a decision (promote, reject, retire or re-ingest) rather than a refreshed hash`,
    );
  }

  // **The record's sources are `sourceRefs`, and its hashes have to be about those and no others.** The drift walk iterates
  // `sourceHashes` while this function iterates `sourceRefs`, so a file named only by the hash map was refused by neither —
  // and the recomputation, which writes the map it built, would have dropped it silently. A record whose two halves disagree
  // is corrupt, so it is refused by name and left exactly as it was rather than repaired into agreement.
  const declared = [...record.sourceRefs].sort();
  const hashed = Object.keys(record.sourceHashes).sort();
  if (declared.join('\u0000') !== hashed.join('\u0000')) {
    const extra = hashed.filter((path) => !declared.includes(path));
    const missing = declared.filter((path) => !hashed.includes(path));
    throw new Error(
      `Wiki record ${id} cannot be re-derived because its recorded hashes do not describe its declared sources: ${
        extra.length > 0 ? `hashed but not declared: ${extra.join(', ')}` : `declared but not hashed: ${missing.join(', ')}`
      }`,
    );
  }

  const sourceHashes: Record<string, string> = {};
  const refreshed: string[] = [];
  const summaries: string[] = [];
  for (const sourceRef of record.sourceRefs) {
    let content: string;
    try {
      content = await readFile(join(root, sourceRef), 'utf8');
    } catch {
      // **A record whose source is gone cannot be re-derived, and saying it was is the fail-open direction.** The first
      // version kept the old hashes, pushed the ref into `refreshed` (a field that means "this hash was recomputed"), and
      // returned the record to `candidate` — which the closure gate accepts. So a record describing a page that no longer
      // exists became acceptable while its hashes still named a file that is gone. The ref stays on the record either way,
      // so the drift walk keeps reporting the gap; the status must not move.
      throw new Error(
        `Wiki record ${id} cannot be re-derived because its source ${sourceRef} cannot be read; the record keeps the reference so the drift check keeps reporting the gap`,
      );
    }
    const hash = computeFileHash(content);
    sourceHashes[sourceRef] = hash;
    if (record.sourceHashes[sourceRef] !== hash) refreshed.push(sourceRef);
    summaries.push(statementForPage(content));
  }

  // **The statement is recomputed only where the writer composed it out of the page — and that is `register`, by name.**
  // The first version asked the provenance dimension (`ingested`) and then took `summaries[0]`, which guessed two things:
  // which ref the statement came from, and that the writer used this composition. `wiki ingest` writes
  // `sourceRefs: [raw, page]` with `statement: oneLineSummary(external body)`, so for its records the first element is the
  // raw import, not the page, and the derivation is not this one (measured by an independent round). The question is not
  // "is this record ingested" but "did the writer that produced it compose the statement this way", and the record carries
  // that writer's identity.
  const statementIsThePageSummary = record.validationTaskId === 'llmwiki-register' && record.sourceRefs.length === 1;
  const statement = statementIsThePageSummary && summaries.length > 0 ? summaries[0]! : record.statement;

  const updated = await updateWikiRecord(root, record.id, {
    ...(Object.keys(sourceHashes).length > 0 ? { sourceHashes } : {}),
    ...(statement === record.statement ? {} : { statement }),
    status: 'candidate',
  });
  return {
    id: updated.id,
    status: updated.status,
    refreshed: [...new Set(refreshed)].sort(),
    statement: statementIsThePageSummary
      ? { recomputed: true, why: `written by ${record.validationTaskId}, whose statement is this page's own summary` }
      : {
          recomputed: false,
          why: `written by ${record.validationTaskId} with ${record.sourceRefs.length} source(s), so its statement is not this page's summary and the recorded prose is left as it is`,
        },
  };
}

/**
 * Revalidates every stale record in the store, reporting what each refresh found.
 *
 * **A refusal is collected, not thrown.** Re-deriving now refuses a record whose source is gone (and one that is verified),
 * and this walk used to let that refusal escape: one unrecoverable record aborted the command *after* the earlier records
 * had already been refreshed, so the caller lost both the rest of the work and the list of what had happened. The refusal is
 * a fact about one record; the walk reports it beside the successes.
 */
export async function revalidateStaleRecords(root: string): Promise<{
  report: DriftReport;
  revalidated: RevalidationResult[];
  refused: Array<{ id: string; reason: string }>;
}> {
  const report = await verifySources(root);
  const revalidated: RevalidationResult[] = [];
  const refused: Array<{ id: string; reason: string }> = [];
  for (const entry of report.stale) {
    // **A withdrawn approval is not re-derived here.** The drift walk demotes a `verified` record whose sources moved before
    // this loop sees it, so the record reads as an ordinary `stale` one — and re-deriving it would hand back a `candidate`,
    // which the closure gate accepts. That is the approval silently downgraded through the bulk door, with the guard on the
    // single-record route unable to see it. The walk already named the withdrawal, so this refuses by that name.
    if (entry.approvalWithdrawn) {
      refused.push({
        id: entry.id,
        reason: `Wiki record ${entry.id} lost its verified status in this run: its sources moved, so its approval was withdrawn and re-deriving it would return a candidate. Review it, then promote it again if it still holds`,
      });
      continue;
    }
    try {
      revalidated.push(await revalidateWikiRecord(root, entry.id));
    } catch (error) {
      refused.push({ id: entry.id, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  return { report, revalidated, refused };
}
