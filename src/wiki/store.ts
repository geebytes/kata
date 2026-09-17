import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { validateWikiRecord, type WikiRecord } from './record.js';
import { wikiDir as layoutWikiDir, wikiRecordPath as layoutWikiRecordPath } from '../core/layout.js';

function normalizeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9._-]/g, '_');
}

/**
 * The one reader of the Wiki store. Records are validated against `wiki-record.schema.json` where they are read: a
 * record that drifted is reported here, not later as an `undefined` on whichever consumer happened to read it first.
 */
export async function readWikiRecords(root: string): Promise<WikiRecord[]> {
  const wikiDir = layoutWikiDir(root);
  let files: string[];
  try {
    files = await readdir(wikiDir);
  } catch {
    return [];
  }
  const records = await Promise.all(
    files
      .filter((f) => f.endsWith('.json'))
      .sort()
      .map(async (file) => {
        const raw = await readFile(join(wikiDir, file), 'utf8');
        try {
          return validateWikiRecord(JSON.parse(raw));
        } catch (error) {
          throw new Error(`Wiki record ${join(wikiDir, file)} is invalid: ${error instanceof Error ? error.message : String(error)}`);
        }
      }),
  );
  return records;
}

export async function writeWikiRecord(root: string, record: WikiRecord): Promise<void> {
  const id = normalizeId(record.id);
  const wikiDir = layoutWikiDir(root);
  await mkdir(wikiDir, { recursive: true });
  const validated = validateWikiRecord(record);
  const validatedWithId = { ...validated, id };
  await writeFile(join(wikiDir, `${id}.json`), `${JSON.stringify(validatedWithId, null, 2)}\n`, 'utf8');
}

export async function updateWikiRecord(root: string, id: string, update: Partial<WikiRecord>): Promise<WikiRecord> {
  const normalizedId = normalizeId(id);
  const wikiDir = layoutWikiDir(root);
  const filePath = join(wikiDir, `${normalizedId}.json`);
  const raw = await readFile(filePath, 'utf8');
  const existing = JSON.parse(raw) as WikiRecord;
  const updated: WikiRecord = {
    ...existing,
    ...update,
    id: existing.id,
    updatedAt: new Date().toISOString(),
  };
  await writeFile(filePath, `${JSON.stringify(updated, null, 2)}\n`, 'utf8');
  return updated;
}

export async function deleteWikiRecord(root: string, id: string): Promise<void> {
  const normalizedId = normalizeId(id);
  const filePath = layoutWikiRecordPath(root, normalizedId);
  const { rm } = await import('node:fs/promises');
  await rm(filePath);
}

export async function findWikiRecord(root: string, id: string): Promise<WikiRecord | undefined> {
  const records = await readWikiRecords(root);
  return records.find((r) => r.id === id);
}

/**
 * Reads the Wiki directory without letting an unrelated record decide an unrelated task.
 *
 * `readWikiRecords` throws on the first invalid file, and the closure gate reads every record to check its candidates —
 * so one drifted legacy record (a field the schema does not allow) blocked **every** workflow mutation in the project,
 * not just the task that owned the file. This variant reports the invalid ones instead: the caller decides whether they
 * matter, and a closure fails only when a record *it names* is unreadable.
 */
export async function readWikiRecordsTolerant(root: string): Promise<{
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
