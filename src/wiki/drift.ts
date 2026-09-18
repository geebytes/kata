import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { computeFileHash } from './record.js';
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
      await updateWikiRecord(root, record.id, { status: 'stale' });
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
      await updateWikiRecord(root, record.id, { status: 'stale' });
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

  const refreshed: string[] = [];
  const sourceHashes: Record<string, string> = {};
  for (const sourceRef of record.sourceRefs) {
    try {
      const content = await readFile(join(root, sourceRef), 'utf8');
      const hash = computeFileHash(content);
      sourceHashes[sourceRef] = hash;
      if (record.sourceHashes[sourceRef] !== hash) refreshed.push(sourceRef);
    } catch {
      // A source that no longer exists is reported rather than silently dropped: the record keeps the ref so the gap
      // stays visible, and the next drift check will say so again.
      refreshed.push(sourceRef);
    }
  }

  const updated = await updateWikiRecord(root, record.id, {
    sourceHashes: Object.keys(sourceHashes).length > 0 ? sourceHashes : record.sourceHashes,
    status: 'candidate',
  });
  return { id: updated.id, status: updated.status, refreshed: [...new Set(refreshed)].sort() };
}

/** Revalidates every stale record in the store, reporting what each refresh found. */
export async function revalidateStaleRecords(root: string): Promise<{ report: DriftReport; revalidated: RevalidationResult[] }> {
  const report = await verifySources(root);
  const revalidated: RevalidationResult[] = [];
  for (const entry of report.stale) {
    revalidated.push(await revalidateWikiRecord(root, entry.id));
  }
  return { report, revalidated };
}
