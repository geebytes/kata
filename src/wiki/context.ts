import { readWikiRecords } from './store.js';
import type { WikiRecord, WikiStatus } from './record.js';

export interface ExcludedWikiEntry {
  id: string;
  status: WikiStatus;
  reason: 'not-authoritative' | 'stale';
}

export interface AuthoritativeContext {
  authoritative: WikiRecord[];
  excluded: ExcludedWikiEntry[];
  warnings: string[];
}

export async function selectAuthoritativeContext(
  root: string,
  requestedSourceRefs: string[],
): Promise<AuthoritativeContext> {
  const records = await readWikiRecords(root);
  const requestedRefs = new Set(requestedSourceRefs);

  const authoritative = records
    .filter((r) => r.status === 'verified' && isRelevant(r, requestedRefs))
    .sort((a, b) => a.id.localeCompare(b.id));

  const excluded = records
    .filter((r) => r.status !== 'verified')
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((r) => ({
      id: r.id,
      status: r.status,
      reason: (r.status === 'stale' ? 'stale' : 'not-authoritative') as ExcludedWikiEntry['reason'],
    }));

  const warnings = records
    .filter((r) => r.status === 'stale')
    .flatMap((r) =>
      r.sourceRefs
        .filter((ref) => requestedRefs.has(ref))
        .map((ref) => `Source ${ref} has stale Wiki record ${r.id}; read source before relying on Wiki.`),
    )
    .sort();

  return { authoritative, excluded, warnings };
}

function isRelevant(record: WikiRecord, requestedRefs: Set<string>): boolean {
  return (
    record.sourceRefs.some((ref) => requestedRefs.has(ref)) ||
    record.scope.some((scope) => requestedRefs.has(scope))
  );
}
