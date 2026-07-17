import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { validateWikiRecord, type WikiRecord } from './record.js';

function normalizeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9._-]/g, '_');
}

export async function readWikiRecords(root: string): Promise<WikiRecord[]> {
  const wikiDir = join(root, '.kata/wiki');
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
        return JSON.parse(raw) as WikiRecord;
      }),
  );
  return records;
}

export async function writeWikiRecord(root: string, record: WikiRecord): Promise<void> {
  const id = normalizeId(record.id);
  const wikiDir = join(root, '.kata/wiki');
  await mkdir(wikiDir, { recursive: true });
  const validated = validateWikiRecord(record);
  const validatedWithId = { ...validated, id };
  await writeFile(join(wikiDir, `${id}.json`), `${JSON.stringify(validatedWithId, null, 2)}\n`, 'utf8');
}

export async function updateWikiRecord(root: string, id: string, update: Partial<WikiRecord>): Promise<WikiRecord> {
  const normalizedId = normalizeId(id);
  const wikiDir = join(root, '.kata/wiki');
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
  const filePath = join(root, '.kata/wiki', `${normalizedId}.json`);
  const { rm } = await import('node:fs/promises');
  await rm(filePath);
}

export async function findWikiRecord(root: string, id: string): Promise<WikiRecord | undefined> {
  const records = await readWikiRecords(root);
  return records.find((r) => r.id === id);
}
