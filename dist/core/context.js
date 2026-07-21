import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
export async function buildContextManifest(input) {
    const root = input.root ?? process.cwd();
    const records = await readWikiRecords(root);
    const requestedSourceRefs = new Set(input.sourceRefs);
    const authoritativeWiki = records
        .filter((record) => record.status === 'verified' && isRelevantWikiRecord(record, requestedSourceRefs))
        .sort((left, right) => left.id.localeCompare(right.id));
    const excludedWiki = records
        .filter((record) => record.status !== 'verified')
        .sort((left, right) => left.id.localeCompare(right.id))
        .map((record) => ({
        id: record.id,
        status: record.status,
        reason: record.status === 'stale' ? 'stale' : 'not-authoritative',
    }));
    const warnings = records
        .filter((record) => record.status === 'stale')
        .flatMap((record) => record.sourceRefs
        .filter((sourceRef) => input.sourceRefs.includes(sourceRef))
        .map((sourceRef) => `Source ${sourceRef} has stale Wiki record ${record.id}; read source before relying on Wiki.`))
        .sort();
    return {
        taskId: input.taskId,
        sourceRefs: [...input.sourceRefs],
        authoritativeWiki,
        excludedWiki,
        warnings,
    };
}
function isRelevantWikiRecord(record, requestedSourceRefs) {
    return (record.sourceRefs.some((sourceRef) => requestedSourceRefs.has(sourceRef)) ||
        record.scope.some((scopeRef) => requestedSourceRefs.has(scopeRef)));
}
async function readWikiRecords(root) {
    const wikiDirectory = join(root, '.kata/wiki');
    let files;
    try {
        files = await readdir(wikiDirectory);
    }
    catch (error) {
        if (isNodeError(error) && error.code === 'ENOENT')
            return [];
        throw error;
    }
    const records = await Promise.all(files
        .filter((file) => file.endsWith('.json'))
        .sort()
        .map(async (file) => JSON.parse(await readFile(join(wikiDirectory, file), 'utf8'))));
    return records;
}
function isNodeError(error) {
    return error instanceof Error && 'code' in error;
}
//# sourceMappingURL=context.js.map