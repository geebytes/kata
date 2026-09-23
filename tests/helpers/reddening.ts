import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { readObligations } from '../../src/quality/repair-obligations.js';
import { recordFalsifierReddening } from '../../src/quality/falsifier-reddenings.js';

/**
 * Gives every open obligation's finding a recorded reddening, for a fixture that is about closure rather than about the
 * reddening itself.
 *
 * It exists because the criterion is unconditional — a finding-shaped obligation closes only when its falsifier has been
 * shown reddening — so a fixture that closes one without a reddening is a fixture that would pass under the defect the
 * criterion exists to catch. This is the honest fix: supply the fact, rather than loosen the rule.
 *
 * Every task under the fixture root is covered, so a fixture does not have to know its own task id.
 */
export async function reddenAllTasks(root: string): Promise<string[]> {
    const tasksDir = join(root, '.kata/tasks');
    let taskIds: string[] = [];
    try {
        taskIds = await readdir(tasksDir);
    } catch {
        return [];
    }
    const reddened: string[] = [];
    for (const taskId of taskIds) {
        const obligations = await readObligations(root, taskId).catch(() => []);
        for (const obligation of obligations) {
            if (!obligation.findingId) continue;
            await recordFalsifierReddening(root, taskId, {
                findingId: obligation.findingId,
                check: 'tests/unit/fixture.test.ts',
                mutation: 'the fixture states that the defect was re-introduced to show the check reddens',
                revisionId: 'revision-fixture',
                reddenedAt: '2026-09-23T02:00:00.000Z',
            });
            reddened.push(obligation.findingId);
        }
    }
    return reddened;
}
