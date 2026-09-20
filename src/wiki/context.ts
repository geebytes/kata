import { readWikiRecordsWithIssues } from './store.js';
import { inferProvenance, type WikiRecord, type WikiStatus } from './record.js';

export interface ExcludedWikiEntry {
  id: string;
  status?: WikiStatus;
  reason: 'not-authoritative' | 'stale' | 'invalid' | 'ingested-summary';
  /**
   * Whether this record touches a source the asking task declared.
   *
   * Decided **here**, where the record is still in hand: a wiki record id is `wiki-<taskId>` (`wiki/provenance.ts`), so
   * it carries no path and a downstream substring test against an id can never be right. An invalid record is
   * `relevant: false` because it could not be read — there are no `sourceRefs` to judge it by, and guessing would put
   * repository noise back into every task.
   */
  relevant: boolean;
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

  // A record whose provenance is `ingested` summarises a documentation page (L4-07): it may be read, but it is not
  // authority about the source it happens to cite, and serving it as such was how a self-referential summary entered the
  // authority set. Only records whose provenance resolves to sources can be authoritative.
  const authoritative = records
    .filter((r) => r.status === 'verified' && inferProvenance(r) !== 'ingested' && isRelevant(r, requestedRefs))
    .sort((a, b) => a.id.localeCompare(b.id));

  const excluded = records
    .filter((r) => r.status !== 'verified' || inferProvenance(r) === 'ingested')
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((r) => ({
      id: r.id,
      status: r.status,
      reason: (r.status === 'stale'
        ? 'stale'
        : inferProvenance(r) === 'ingested'
          ? 'ingested-summary'
          : 'not-authoritative') as ExcludedWikiEntry['reason'],
      relevant: isRelevant(r, requestedRefs),
    }));

  // An unreadable record cannot be authoritative, and it must not be silent either: it is named here (and in the
  // handoff packet's excluded list), so the reader knows a page's record needs repair rather than believing the Wiki
  // simply has nothing to say about it.
  const invalidExcluded: ExcludedWikiEntry[] = invalid
    .map((entry) => ({ id: entry.path.replace(/^.*\//, '').replace(/\.json$/, ''), reason: 'invalid' as const, relevant: false }))
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
