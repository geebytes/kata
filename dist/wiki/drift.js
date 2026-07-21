import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { computeFileHash } from './record.js';
import { readWikiRecords, updateWikiRecord } from './store.js';
export async function verifySources(root) {
    const records = await readWikiRecords(root);
    const intact = [];
    const stale = [];
    const missingSources = new Set();
    for (const record of records) {
        if (record.status === 'rejected') {
            intact.push(record.id);
            continue;
        }
        const changedSources = [];
        const sourceHashEntries = Object.entries(record.sourceHashes);
        if (record.sourceRefs.length > 0 && sourceHashEntries.length === 0) {
            stale.push({ id: record.id, reason: 'source_missing', changedSources: [...record.sourceRefs] });
            for (const sourceRef of record.sourceRefs)
                missingSources.add(sourceRef);
            await updateWikiRecord(root, record.id, { status: 'stale' });
            continue;
        }
        for (const [sourcePath, expectedHash] of sourceHashEntries) {
            try {
                const absolutePath = join(root, sourcePath);
                const content = await readFile(absolutePath, 'utf8');
                const currentHash = computeFileHash(content);
                if (currentHash !== expectedHash) {
                    changedSources.push(sourcePath);
                }
            }
            catch {
                changedSources.push(sourcePath);
                missingSources.add(sourcePath);
            }
        }
        if (changedSources.length > 0) {
            const reason = changedSources.some((s) => missingSources.has(s)) ? 'source_missing' : 'source_changed';
            stale.push({ id: record.id, reason, changedSources });
            await updateWikiRecord(root, record.id, { status: 'stale' });
        }
        else {
            intact.push(record.id);
        }
    }
    return {
        checked: records.length,
        intact,
        stale,
        missing: [...missingSources].sort(),
    };
}
export async function markRecordStale(root, id) {
    await updateWikiRecord(root, id, { status: 'stale' });
}
//# sourceMappingURL=drift.js.map