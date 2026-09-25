import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Record a disposition so a repair author can be recorded at all, against a revision that exists.
 *
 * **The rule is consumed, not restated**: `recordRepairAuthor` refuses a repair whose finding has no reddening and no recorded
 * absence, and it asks that question with the **same binding the criterion asks with** — the content the next seal will mint,
 * which is the tree (`rba11-f1`). A task with no sealed revision therefore has no binding, and a missing binding is a refusal rather
 * than a default pass (`rba5-f1`). So this seals one first, which is the rule being consumed rather than worked around.
 */
export async function giveDisposition(root: string, taskId: string, findingId: string): Promise<void> {
    const { createTaskRevisionIfChanged, readCurrentTaskRevision, computePathDigests } = await import('../../src/workflow/revision.js');
    const { readTask } = await import('../../src/core/task.js');
    const { recordFalsifierReddening } = await import('../../src/quality/falsifier-reddenings.js');
    const task = await readTask(root, taskId);
    const revision = await createTaskRevisionIfChanged({ root, taskId, ownedPaths: task.ownedPaths ?? ['tests/fixture.txt'] })
        .catch(() => null);
    const current = revision?.revision ?? (await readCurrentTaskRevision(root, taskId).catch(() => null));
    // **The tree, not the sealed set** (`rba11-f1`): a producer records what the next seal will mint, so a helper that records the
    // revision's frozen digests makes the fixture's premise *stronger* than production's and lets the selectors pass for a reason
    // the code does not have. Measured: a revision a seal minted carries 19 of 19 digests equal to the tree, while a proof seeded
    // from the previous revision carried 8 of 19 after a repair touched an owned path.
    const treeDigests = task.ownedPaths?.length ? await computePathDigests(root, task.ownedPaths).catch(() => null) : null;
    await recordFalsifierReddening(root, taskId, {
        findingId,
        check: 'true',
        mutation: 'false',
        revisionId: current?.id ?? 'revision-fixture',
        observed: { before: 0, mutated: 1, after: 0 },
        reddenedAt: '2026-01-01T00:00:00.000Z',
        ...(treeDigests ? { pathDigests: treeDigests } : current?.pathDigests ? { pathDigests: current.pathDigests } : {}),
    });
}
