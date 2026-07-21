import { findWikiRecord, updateWikiRecord } from './store.js';
export async function promote(root, id, approval) {
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
export async function rejectCandidate(root, id, rejection) {
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
export async function retireWikiRecord(root, id, rejection) {
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
//# sourceMappingURL=promotion.js.map