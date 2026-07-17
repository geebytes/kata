import { createHash } from 'node:crypto';
import { validate } from '../core/schema.js';

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

export function computeFileHash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

export function validateWikiRecord(value: unknown): WikiRecord {
  return validate<WikiRecord>('wiki-record', value);
}
