import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initLayout } from '../../src/core/layout.js';
import { createTask } from '../../src/core/task.js';
import { createTaskRevision } from '../../src/workflow/revision.js';

/**
 * AC-5 of `kata-gate-surface`, first half: a brief's reading set does not exceed its own delta.
 *
 * Measured (`wcc3-f5`): the brief listed seven paths while its delta held three, including files this round was not about,
 * because the set was built from the revision-wide surface **plus** every collaborator of every criterion. A reviewer told
 * to start with seven paths when three changed re-derives the four that did not — the cost the delta exists to avoid,
 * defeated inside the brief.
 */
const cleanup: string[] = [];

async function fixture(id: string): Promise<{ root: string; base: string }> {
    const root = await mkdtemp(join(tmpdir(), `kata-brief-scope-${id}-`));
    cleanup.push(root);
    await initLayout(root);
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src/one.ts'), 'export const one = 1;\n', 'utf8');
    await createTask({
        root,
        id,
        title: id,
        ownedPaths: ['src/one.ts', 'src/two.ts'],
        acceptance: [{ id: 'AC-1', statement: 'the reading set is the delta' }],
    } as never);
    const base = await createTaskRevision({ root, taskId: id, ownedPaths: ['src/one.ts'], checkIds: [] });
    await writeFile(join(root, 'src/two.ts'), 'export const two = 2;\n', 'utf8');
    await createTaskRevision({ root, taskId: id, ownedPaths: ['src/one.ts', 'src/two.ts'], checkIds: [] });
    return { root, base: base.id };
}

describe('a delta brief reads its delta', () => {
    afterEach(async () => {
        await Promise.all(cleanup.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
    });

    it('names no path outside the delta it declares', async () => {
        const { root, base } = await fixture('reading-set');
        const { buildAdversarialBrief } = await import('../../src/quality/adversarial.js');
        const brief = await buildAdversarialBrief(root, 'reading-set', 'review', { since: base });

        const scope = brief.ir?.scope;
        expect(scope?.kind).toBe('delta');
        const declared = scope?.kind === 'delta' ? scope.changedPaths : [];

        // The reading set as the reviewer receives it, from the block the brief renders.
        const block = brief.text.split('<untrusted-material kind="reading-set">')[1]?.split('</untrusted-material>')[0] ?? '';
        const listed = block
            .split('\n')
            .filter((line) => line.trim().startsWith('- '))
            .map((line) => line.trim().slice(2).split(' ')[0]!)
            .filter((path) => path.includes('/'));

        expect(listed.length).toBeGreaterThan(0);
        expect(listed.filter((path) => !declared.includes(path))).toEqual([]);
    });
});
