import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initLayout } from '../../src/core/layout.js';
import { createTask } from '../../src/core/task.js';
import { createTaskRevision } from '../../src/workflow/revision.js';

/**
 * AC-3 of `kata-gate-surface`, and the direct reproduction of `wcc3-f10`.
 *
 * Measured on a real round: **a pass that answers exactly the delta its brief declares is refused by the gate that issued
 * the brief.** The brief held three paths, the gate's remit held five, and the refusal named the delta — so the system
 * generated an input it would not accept.
 *
 * This is the end-to-end falsifier rather than the unit-level one, on purpose: the unit test for AC-1 asserts the producers
 * agree on a fixture, and it is green, while the disagreement is real on real material. A test that only ever sees the
 * agreeing case cannot decide this.
 */
const cleanup: string[] = [];

async function fixture(id: string): Promise<{ root: string; base: string; current: string }> {
    const root = await mkdtemp(join(tmpdir(), `kata-delta-admissible-${id}-`));
    cleanup.push(root);
    await initLayout(root);
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src/one.ts'), 'export const one = 1;\n', 'utf8');
    await createTask({
        root,
        id,
        title: id,
        ownedPaths: ['src/one.ts', 'src/two.ts'],
        acceptance: [{ id: 'AC-1', statement: 'a declared delta is admissible' }],
    } as never);
    const base = await createTaskRevision({ root, taskId: id, ownedPaths: ['src/one.ts'], checkIds: [] });
    await writeFile(join(root, 'src/two.ts'), 'export const two = 2;\n', 'utf8');
    const current = await createTaskRevision({ root, taskId: id, ownedPaths: ['src/one.ts', 'src/two.ts'], checkIds: [] });
    return { root, base: base.id, current: current.id };
}

describe('a pass that answers the delta its brief declares is admissible', () => {
    afterEach(async () => {
        await Promise.all(cleanup.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
    });

    it('is admitted by the gate that issued the brief', async () => {
        const { root, base } = await fixture('declared-delta');
        const { issueAdversarialBrief, adversarialGateFor } = await import('../../src/quality/adversarial.js');
        const { recordAdversarialPass } = await import('../helpers/adversarial.js');

        // The delta the brief declares, reached the same way the default scope reaches it after a repair batch closes.
        const brief = await issueAdversarialBrief(root, 'declared-delta', 'review', { since: base });
        const declared = brief.ir?.scope
            ? brief.ir.scope.kind === 'delta'
                ? [...brief.ir.scope.changedPaths]
                : [...brief.ir.scope.paths]
            : [];
        expect(brief.ir?.scope?.kind).toBe('delta');
        expect(declared.length).toBeGreaterThan(0);

        // The pass answers **exactly** that scope: the criterion it is answerable for, and the paths the brief named.
        await recordAdversarialPass(root, 'declared-delta', 'review', {
            hypotheses: [
                {
                    id: 'h-declared-scope',
                    claim: 'the declared delta is the whole surface this round has to account for',
                    targets: ['AC-1', ...declared],
                    method: 'source-read',
                    outcome: 'refuted',
                    observation: { kind: 'source', ref: declared[0]!, observed: 'the declared delta was read' },
                },
            ],
        });

        const gate = await adversarialGateFor(root, 'declared-delta', 'review');
        // The falsifier: holding exactly the declared scope must not be a reason to refuse.
        expect({ satisfied: gate.satisfied, reason: gate.reason, detail: gate.detail }).toEqual({
            satisfied: true,
            reason: undefined,
            detail: undefined,
        });
    }, 60000);
});
