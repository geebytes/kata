import { readWikiRecords } from '../wiki/store.js';
import type { WikiRecord, WikiStatus } from '../wiki/record.js';

export type { WikiRecord, WikiStatus };

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
