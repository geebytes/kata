import { createHash } from 'node:crypto';
import { validate } from '../core/schema.js';
import { hashContent } from '../core/hash.js';

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
  createdAt: string;
  updatedAt: string;
  approvalEvent?: {
    approvedBy: string;
    role: string;
    approvedAt: string;
    notes?: string;
  };
  rejectionEvent?: {
    rejectedBy: string;
    role: string;
    rejectedAt: string;
    reason: string;
  };
}

/** @deprecated Use `hashContent` from core/hash.js; kept so existing importers keep working. */
export const computeFileHash = hashContent;

export function validateWikiRecord(value: unknown): WikiRecord {
  return validate<WikiRecord>('wiki-record', value);
}
