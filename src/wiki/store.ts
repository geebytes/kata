import { mkdir, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { validateWikiRecord, type WikiRecord } from './record.js';
import { withRepositoryArtefactLock } from '../core/locks.js';
import { wikiDir as layoutWikiDir, wikiRecordPath as layoutWikiRecordPath } from '../core/layout.js';

export function normalizeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9._-]/g, '_');
}

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
  await withRepositoryArtefactLock(root, `wiki-${id}`, join(wikiDir, `${id}.json`), async () =>
    `${JSON.stringify(validatedWithId, null, 2)}\n`);
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

