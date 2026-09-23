import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initLayout } from '../../src/core/layout.js';
import { createTask } from '../../src/core/task.js';
import { createTaskRevision } from '../../src/workflow/revision.js';
import { buildAdversarialBrief } from '../../src/quality/adversarial.js';

/**
 * AC-1 of `kata-gate-surface`. The change surface a round reviews has **one** derivation.
 *
 * Written this way on purpose: the test **enumerates the producers** and asserts they agree, rather than asserting one pair.
 * That is the mistake that let f8 survive — the test written for it asserted the record against the gate and nothing else,
 * and `wcc2-f1` found the next pair immediately (the brief's delta against the gate), then `wcc3-f1` the pair after that
 * (the brief's own declared delta against its own prose).
 *
 * So every producer reachable from here is listed, and the assertion is that none of them disagrees with the others.
 */
const cleanup: string[] = [];

async function fixture(id: string): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), `kata-surface-${id}-`));
    cleanup.push(root);
    await initLayout(root);
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src/one.ts'), 'export const one = 1;\n', 'utf8');
    await createTask({
        root,
        id,
        title: id,
        ownedPaths: ['src/one.ts'],
        acceptance: [{ id: 'AC-1', statement: 'the surface has one derivation' }],
    } as never);
    await createTaskRevision({ root, taskId: id, ownedPaths: ['src/one.ts'], checkIds: [] });
    return root;
}

describe('the change surface has one derivation', () => {
    afterEach(async () => {
        await Promise.all(cleanup.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
    });

    it('the brief declares one scope, and its own prose does not contradict it', async () => {
        const root = await fixture('one-derivation');
        const brief = await buildAdversarialBrief(root, 'one-derivation', 'review');

        // Producer 1: the structured scope the round is bound to.
        const declared = brief.ir?.scope
            ? brief.ir.scope.kind === 'delta'
                ? [...brief.ir.scope.changedPaths]
                : [...brief.ir.scope.paths]
            : [];
        // Producer 2: the prose the reviewer reads. It is generated from the same facts, so it cannot disagree.
        const proseLine = brief.text.split('\n').find((line) => line.startsWith('Paths under review:')) ?? '';
        const prose = proseLine
            .replace('Paths under review:', '')
            .split(',')
            .map((path) => path.trim())
            .filter((path) => path.length > 0 && path !== '(none declared)');

        const onlyInProse = prose.filter((path) => !declared.includes(path));
        const onlyInScope = declared.filter((path) => !prose.includes(path));

        expect({ onlyInProse, onlyInScope }).toEqual({ onlyInProse: [], onlyInScope: [] });

        // Refuses to pass vacuously. A **full** round has no delta, so both producers agree trivially and this test would
        // go green while the defect it is written for lives — measured: on a minimal fixture it did exactly that. The
        // producers disagree on a **delta**, so the fixture must construct one (a base revision and a repair batch), and
        // until it does this test states the gap instead of reporting success.
        expect({
            note: 'this fixture must exercise the delta path, or the assertion above proves nothing',
            scopeKind: brief.ir?.scope?.kind ?? 'none',
        }).toEqual({ note: 'this fixture must exercise the delta path, or the assertion above proves nothing', scopeKind: 'delta' });
    });
});
