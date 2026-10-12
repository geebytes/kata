import { mkdir, readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { carriesDecision, validateWikiRecord, wikiRecordFileName, type WikiRecord } from './record.js';
import { withRepositoryArtefactLock } from '../core/locks.js';
import { wikiDir as layoutWikiDir, wikiRecordPath as layoutWikiRecordPath } from '../core/layout.js';

export function normalizeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9._-]/g, '_');
}

// The file name is derived once (`wikiRecordFileName`); `normalizeId` remains the reader-facing name normaliser.

/**
 * The one reader of the Wiki store. Records are validated against `wiki-record.schema.json` where they are read: a
 * record that drifted is reported here, not later as an `undefined` on whichever consumer happened to read it first.
 */
/**
 * The Wiki as it can be read: valid records, with the invalid ones reported instead of thrown.
 *
 * Measured failure this replaces: one legacy record carrying a field the schema no longer allows (`revalidatedBy`)
 * blocked **every** workflow mutation in the project, because the handoff path read the whole Wiki and the reader threw
 * on the first file it could not validate. A record that cannot be read cannot be authoritative either, so the rule is
 * one: **reading the Wiki never fails** — an invalid record is skipped and named, and refusing is the business of the
 * Wiki's own reporting surfaces (`kata-cli wiki audit`, `lint`), which is where a drifted record has to be fixed.
 */
export async function readWikiRecordsWithIssues(root: string): Promise<{
  records: WikiRecord[];
  invalid: Array<{ path: string; message: string }>;
}> {
  const wikiDir = layoutWikiDir(root);
  let files: string[];
  try {
    files = await readdir(wikiDir);
  } catch {
    return { records: [], invalid: [] };
  }
  const records: WikiRecord[] = [];
  const invalid: Array<{ path: string; message: string }> = [];
  for (const file of files.filter((f) => f.endsWith('.json')).sort()) {
    const path = join(wikiDir, file);
    try {
      records.push(validateWikiRecord(JSON.parse(await readFile(path, 'utf8'))));
    } catch (error) {
      invalid.push({ path, message: error instanceof Error ? error.message : String(error) });
    }
  }
  return { records, invalid };
}

/** The valid records. Invalid ones are skipped — see `readWikiRecordsWithIssues` for why that cannot fail. */
export async function readWikiRecords(root: string): Promise<WikiRecord[]> {
  return (await readWikiRecordsWithIssues(root)).records;
}

export async function writeWikiRecord(root: string, record: WikiRecord): Promise<void> {
  const id = normalizeId(record.id);
  const wikiDir = layoutWikiDir(root);
  await mkdir(wikiDir, { recursive: true });
  const validated = validateWikiRecord(record);
  const validatedWithId = { ...validated, id };
  // L3-04: validation happens before the write (it already did) and the write is now atomic, so a crash mid-write leaves
  // the previous record readable instead of a truncated file that every reader then has to report as invalid.
  const recordPath = join(wikiDir, `${id}.json`);
  await withRepositoryArtefactLock(root, `wiki-${id}`, recordPath, async (current) => {
    // **This writer replaces, and a replacement must not destroy a decision.**
    //
    // `writeWikiRecord` overwrites the file it names — unlike `updateWikiRecord`, which merges — so any writer that hands it
    // a fresh record silently discards whatever the previous one carried. `ingestLlmWiki` guards the *page* and not the
    // record, so re-ingesting a source whose page is gone wrote a new `candidate` over an approved record: an approval became
    // the status the closure gate accepts, with the writer reporting the id as newly governed and `refused: []` (measured by
    // an independent round). The guard belongs at the one choke point every writer passes through rather than at the three
    // callers, and it is judged **inside the lock**, against the content on disk.
    //
    // Whether that content carries a decision is asked of `carriesDecision`, the same derivation the re-derivation guard
    // asks: the first version counted only `verified`/`rejected` statuses, so a record whose approval the drift walk had
    // withdrawn (status `stale` with an `approvalEvent`) read as undecided and could be replaced — the defect this guard
    // exists to prevent, reopened one call later (measured by an independent round).
    //
    // **An unreadable record is not an absent one.** The lock reads the file and hands over the empty string for *any* read
    // error, so `EACCES`/`EISDIR` used to look identical to "nothing here" while the replacement itself only needs write
    // permission on the directory. A file that exists and cannot be read is therefore refused by name: what it holds may be
    // exactly the decision that must not be destroyed.
    if (current.trim().length === 0) {
      let exists = false;
      try {
        await stat(recordPath);
        exists = true;
      } catch {
        exists = false;
      }
      if (exists) {
        throw new Error(
          `Wiki record ${id} cannot be replaced because the file at its path cannot be read; refusing to write over content this store could not inspect`,
        );
      }
      return `${JSON.stringify(validatedWithId, null, 2)}\n`;
    }

    let existing: WikiRecord;
    try {
      existing = validateWikiRecord(JSON.parse(current));
    } catch (error) {
      throw new Error(
        `Wiki record ${id} cannot be replaced because the record already on disk cannot be read as one: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (carriesDecision(existing)) {
      // **The refusal names only roads that work in this state, and there is exactly one.** `retire` and `reject` do not open
      // the door: `rejectCandidate` requires `candidate`, and `retireWikiRecord` moves a verified record *to* `rejected`,
      // which this guard also refuses — so a sentence offering "retire it first" would name a road that leaves the operator in
      // the same state (measured: retire, then write, still refuses). The one road is clearing the store, and its
      // precondition is named with it: `wiki rebuild` removes every page and governed record and needs an initialised wiki.
      throw new Error(
        `Wiki record ${id} carries a decision (status ${existing.status}${existing.approvalEvent ? ', approved' : ''}${existing.rejectionEvent ? ', retired' : ''}), and this store never replaces a decided record: reject, retire and promote all refuse to move it out of that state, so the only road is clearing the store as a whole — \`kata-cli wiki rebuild\` removes every page and governed record (and needs an initialised wiki) — and ingesting the sources again. If the record should stand, there is nothing to do here`,
      );
    }
    return `${JSON.stringify(validatedWithId, null, 2)}\n`;
  });
}

export async function updateWikiRecord(root: string, id: string, update: Partial<WikiRecord>): Promise<WikiRecord> {
  const normalizedId = normalizeId(id);
  const filePath = layoutWikiRecordPath(root, normalizedId);
  let updated: WikiRecord | undefined;
  // The read-modify-write is one critical section, the same shape `mutateTaskArtefact` uses: two concurrent updates to
  // one record used to interleave and the second silently dropped the first.
  await withRepositoryArtefactLock(root, `wiki-${normalizedId}`, filePath, async (current) => {
    const existing = JSON.parse(current) as WikiRecord;
    updated = validateWikiRecord({ ...existing, ...update, id: existing.id, updatedAt: new Date().toISOString() });
    return `${JSON.stringify(updated, null, 2)}\n`;
  });
  return updated!;
}

export async function findWikiRecord(root: string, id: string): Promise<WikiRecord | undefined> {
  const records = await readWikiRecords(root);
  return records.find((r) => r.id === id);
}

