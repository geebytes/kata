/**
 * Record a disposition so a repair author can be recorded at all.
 *
 * **The rule is consumed, not restated**: `recordRepairAuthor` refuses a repair whose finding has no reddening and no recorded
 * absence, because provenance that cannot say the repair was shown to work is provenance for something that may not have
 * happened. That makes a disposition a precondition of every repair-author case rather than an optional companion, which is what
 * `rba4-f2` measured — nothing joined a repair to a disposition before this.
 */
export async function giveDisposition(root: string, taskId: string, findingId: string): Promise<void> {
    const { recordFalsifierReddening } = await import('../../src/quality/falsifier-reddenings.js');
    await recordFalsifierReddening(root, taskId, {
        findingId,
        check: 'true',
        mutation: 'false',
        revisionId: 'revision-fixture',
        observed: { before: 0, mutated: 1, after: 0 },
        reddenedAt: '2026-01-01T00:00:00.000Z',
    });
}
