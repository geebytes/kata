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
    excludedWiki: selection.excluded,
    warnings: selection.warnings,
  };
}
