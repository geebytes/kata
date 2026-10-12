import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { computeFileHash, inferProvenance } from './record.js';
import { statementForPage } from './llmwiki.js';
import { normalizeId, readWikiRecords, readWikiRecordsWithIssues, updateWikiRecord } from './store.js';
import type { WikiStatus as WikiRecordStatus } from './record.js';

export interface DriftEntry {
  id: string;
  reason: 'source_changed' | 'source_missing';
  changedSources: string[];
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
      stale.push({ id: record.id, reason: 'source_missing', changedSources: [...record.sourceRefs] });
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
      stale.push({ id: record.id, reason, changedSources });
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

export interface RevalidationResult {
  id: string;
  status: WikiRecordStatus;
  /** The sources whose recorded hash was refreshed (empty = the record was already consistent). */
  refreshed: string[];
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

  // **An approved record is not re-derived.** The first version set `status: 'candidate'` unconditionally, so calling this
  // on a `verified` record silently demoted the strongest state the store has — a strength change with no decision behind
  // it, made worse by the fact that `verified` is what `promote` (and its passing validation task) exists to confer.
  // Measured by an independent round: the demotion was reachable from the CLI with one word.
  if (record.status === 'verified') {
    throw new Error(
      `Wiki record ${id} is verified, and re-derivation never demotes an approved record: retire or reject it instead of refreshing its sources`,
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

  // **The statement is recomputed only where the statement *is* the page's.** For an ingested record the statement is the
  // page's own summary, so leaving it behind makes the record describe a version that no longer exists. For a distilled
  // record the statement is the change's finding and is not derivable from a file at all — recomputing it there would
  // overwrite knowledge with the first line of whatever it cites. One question ("was this statement derived from the
  // page?"), asked of the provenance dimension rather than guessed from the shape of the refs.
  const statement = inferProvenance(record) === 'ingested' && summaries.length > 0 ? summaries[0]! : record.statement;

  const updated = await updateWikiRecord(root, record.id, {
    ...(Object.keys(sourceHashes).length > 0 ? { sourceHashes } : {}),
    ...(statement === record.statement ? {} : { statement }),
    status: 'candidate',
  });
  return { id: updated.id, status: updated.status, refreshed: [...new Set(refreshed)].sort() };
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
    try {
      revalidated.push(await revalidateWikiRecord(root, entry.id));
    } catch (error) {
      refused.push({ id: entry.id, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  return { report, revalidated, refused };
}
