import { readWikiRecordsWithIssues } from './store.js';
import type { WikiRecord, WikiStatus } from './record.js';

export interface ExcludedWikiEntry {
  id: string;
  status?: WikiStatus;
  reason: 'not-authoritative' | 'stale' | 'invalid';
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
  const { records, invalid } = await readWikiRecordsWithIssues(root);
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

  // An unreadable record cannot be authoritative, and it must not be silent either: it is named here (and in the
  // handoff packet's excluded list), so the reader knows a page's record needs repair rather than believing the Wiki
  // simply has nothing to say about it.
  const invalidExcluded: ExcludedWikiEntry[] = invalid
    .map((entry) => ({ id: entry.path.replace(/^.*\//, '').replace(/\.json$/, ''), reason: 'invalid' as const }))
    .sort((a, b) => a.id.localeCompare(b.id));
  const invalidWarnings = invalid.map((entry) => `Wiki record ${entry.path} is invalid and was skipped: ${entry.message}`);

  const warnings = [...invalidWarnings, ...records
    .filter((r) => r.status === 'stale')
    .flatMap((r) =>
      r.sourceRefs
        .filter((ref) => requestedRefs.has(ref))
        .map((ref) => `Source ${ref} has stale Wiki record ${r.id}; read source before relying on Wiki.`),
    )
    .sort()];

  return { authoritative, excluded: [...excluded, ...invalidExcluded], warnings };
}

function isRelevant(record: WikiRecord, requestedRefs: Set<string>): boolean {
  return (
    record.sourceRefs.some((ref) => requestedRefs.has(ref)) ||
    record.scope.some((scope) => requestedRefs.has(scope))
  );
}
