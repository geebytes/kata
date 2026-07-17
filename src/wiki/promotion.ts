import { findWikiRecord, updateWikiRecord } from './store.js';
import type { WikiRecord } from './record.js';

export interface ApprovalEvent {
  approvedBy: string;
  role: string;
  approvedAt: string;
  notes?: string;
}

export interface RejectionEvent {
  rejectedBy: string;
  role: string;
  rejectedAt: string;
  reason: string;
}

export async function promote(root: string, id: string, approval: ApprovalEvent): Promise<WikiRecord> {
  const record = await findWikiRecord(root, id);
  if (!record) {
    throw new Error(`Wiki record '${id}' not found`);
  }

  if (record.status !== 'candidate') {
    throw new Error(`Cannot promote record '${id}': current status is '${record.status}', expected 'candidate'`);
  }

  const updated = await updateWikiRecord(root, id, {
    status: 'verified',
    lastVerifiedAt: approval.approvedAt,
    approvalEvent: { ...approval },
  });

  return updated;
}

export async function rejectCandidate(root: string, id: string, rejection: RejectionEvent): Promise<WikiRecord> {
  const record = await findWikiRecord(root, id);
  if (!record) {
    throw new Error(`Wiki record '${id}' not found`);
  }

  if (record.status !== 'candidate') {
    throw new Error(`Cannot reject record '${id}': current status is '${record.status}', expected 'candidate'`);
  }

  const updated = await updateWikiRecord(root, id, { status: 'rejected', rejectionEvent: { ...rejection } });
  return updated;
}

export async function retireWikiRecord(root: string, id: string, rejection: RejectionEvent): Promise<WikiRecord> {
  const record = await findWikiRecord(root, id);
  if (!record) {
    throw new Error(`Wiki record '${id}' not found`);
  }

  if (record.status === 'rejected') {
    throw new Error(`Cannot retire record '${id}': current status is already 'rejected'`);
  }

  const reason = rejection.reason.startsWith('retired:')
    ? rejection.reason
    : `retired: ${rejection.reason}`;
  const updated = await updateWikiRecord(root, id, {
    status: 'rejected',
    rejectionEvent: { ...rejection, reason },
  });
  return updated;
}
