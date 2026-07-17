import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

export type WikiStatus = 'candidate' | 'verified' | 'stale' | 'rejected';

export interface WikiRecord {
  id: string;
  statement: string;
  scope: string[];
  kind: string;
  sourceRefs: string[];
  sourceHashes: Record<string, string>;
  validationTaskId: string;
  evidenceIds: string[];
  status: WikiStatus;
  lastVerifiedAt: string;
}

export interface ContextRequest {
  root?: string;
  taskId: string;
  sourceRefs: string[];
}

export interface ExcludedWikiRecord {
  id: string;
  status: WikiStatus;
  reason: 'not-authoritative' | 'stale';
}

export interface ContextManifest {
  taskId: string;
  sourceRefs: string[];
  authoritativeWiki: WikiRecord[];
  excludedWiki: ExcludedWikiRecord[];
  warnings: string[];
}

export async function buildContextManifest(input: ContextRequest): Promise<ContextManifest> {
  const root = input.root ?? process.cwd();
  const records = await readWikiRecords(root);
  const requestedSourceRefs = new Set(input.sourceRefs);
  const authoritativeWiki = records
    .filter((record) => record.status === 'verified' && isRelevantWikiRecord(record, requestedSourceRefs))
    .sort((left, right) => left.id.localeCompare(right.id));
  const excludedWiki = records
    .filter((record) => record.status !== 'verified')
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((record) => ({
      id: record.id,
      status: record.status,
      reason: record.status === 'stale' ? 'stale' : 'not-authoritative',
    }) satisfies ExcludedWikiRecord);
  const warnings = records
    .filter((record) => record.status === 'stale')
    .flatMap((record) =>
      record.sourceRefs
        .filter((sourceRef) => input.sourceRefs.includes(sourceRef))
        .map((sourceRef) => `Source ${sourceRef} has stale Wiki record ${record.id}; read source before relying on Wiki.`),
    )
    .sort();

  return {
    taskId: input.taskId,
    sourceRefs: [...input.sourceRefs],
    authoritativeWiki,
    excludedWiki,
    warnings,
  };
}

function isRelevantWikiRecord(record: WikiRecord, requestedSourceRefs: Set<string>): boolean {
  return (
    record.sourceRefs.some((sourceRef) => requestedSourceRefs.has(sourceRef)) ||
    record.scope.some((scopeRef) => requestedSourceRefs.has(scopeRef))
  );
}

async function readWikiRecords(root: string): Promise<WikiRecord[]> {
  const wikiDirectory = join(root, '.kata/wiki');
  let files: string[];
  try {
    files = await readdir(wikiDirectory);
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return [];
    throw error;
  }
  const records = await Promise.all(
    files
      .filter((file) => file.endsWith('.json'))
      .sort()
      .map(async (file) => JSON.parse(await readFile(join(wikiDirectory, file), 'utf8')) as WikiRecord),
  );
  return records;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
