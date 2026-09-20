import { selectAuthoritativeContext } from '../wiki/context.js';
import type { WikiRecord, WikiStatus } from '../wiki/record.js';

export type { WikiRecord, WikiStatus };

export interface ContextRequest {
  root?: string;
  taskId: string;
  sourceRefs: string[];
}

export interface ExcludedWikiRecord {
  id: string;
  /** Absent when the record could not be read at all — there is no trustworthy status to report. */
  status?: WikiStatus;
  reason: 'not-authoritative' | 'stale' | 'invalid' | 'ingested-summary';
}

export interface ContextManifest {
  taskId: string;
  sourceRefs: string[];
  authoritativeWiki: WikiRecord[];
  excludedWiki: ExcludedWikiRecord[];
  warnings: string[];
  /** The scoped projection of `excludedWiki`, for surfaces that report it to an agent. */
  excludedWikiSummary: ExcludedWikiSummary;
}

/**
 * A context manifest's excluded-Wiki report, split by whether the record is relevant to this task (L3-03).
 *
 * The relevant records keep their full reason, because "this record I asked about is stale" is a fact the agent needs at
 * the point of use. Records that have nothing to do with this task's refs become a count and a pointer at `kata-cli wiki
 * audit`: every task used to carry the whole repository's history of stale and invalid records, and the noise was paid
 * for on every handoff.
 */
export interface ExcludedWikiSummary {
  /** The records this task's refs actually touch, with the reason they were excluded. */
  relevant: Array<{ id: string; reason: string }>;
  /** Everything else, as counts — the detail lives in the Wiki's own reporting surface. */
  unrelated: { count: number; byReason: Record<string, number> };
}

/**
 * The scoped projection of an excluded-Wiki list.
 *
 * Relevance is **carried on each entry** rather than recomputed here from `sourceRefs`, because it cannot be: a wiki
 * record id is `wiki-<taskId>`, so no substring of it identifies a path, and the record's own `sourceRefs`/`scope` — the
 * only field that answers the question — are gone once the entry is a two-field outer projection. `wiki/context.ts`
 * decides it while the record is in hand (`ExcludedWikiEntry.relevant`); this function only partitions.
 */
export function summarizeExcludedWiki(
  excluded: Array<{ id: string; reason: string; relevant?: boolean }>,
): ExcludedWikiSummary {
  const relevant: ExcludedWikiSummary['relevant'] = [];
  const byReason: Record<string, number> = {};
  let count = 0;
  for (const record of excluded) {
    if (record.relevant) {
      relevant.push({ id: record.id, reason: record.reason });
      continue;
    }
    count += 1;
    byReason[record.reason] = (byReason[record.reason] ?? 0) + 1;
  }
  return { relevant, unrelated: { count, byReason } };
}

/**
 * The context manifest is a projection: which knowledge is authoritative is decided once, in `wiki/context.ts`, and
 * this adds the task metadata around it.
 */
export async function buildContextManifest(input: ContextRequest): Promise<ContextManifest> {
  const root = input.root ?? process.cwd();
  const selection = await selectAuthoritativeContext(root, input.sourceRefs);

  return {
    taskId: input.taskId,
    sourceRefs: [...input.sourceRefs],
    authoritativeWiki: selection.authoritative,
    // The raw list stays: a caller that wants the whole picture still has it. The summary is the packet projection.
    excludedWiki: selection.excluded,
    excludedWikiSummary: summarizeExcludedWiki(selection.excluded),
    warnings: selection.warnings,
  };
}
