import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initLayout } from '../../src/core/layout.js';
import { createTask } from '../../src/core/task.js';
import { createTaskRevision } from '../../src/workflow/revision.js';

/**
 * AC-2 of `kata-gate-surface`, rewritten to the property that actually holds.
 *
 * The original criterion said a repair that edits a file **already hashed at both seals** appears in the change surface.
 * Measurement disproved the premise (`8aec483`): the two files the finding named carry the **same digest** in the base and
 * current revisions, because the repair landed **before** the base was sealed — so the base already holds the edited
 * content and the delta is correctly empty for them. A surface reporting them as changed would be the defect.
 *
 * What is true, and is what this locks, is the equivalence underneath: **a path is reported changed exactly when its
 * content differs between the two revisions.** That is a property, not a story, and it covers the finding's case without
 * asserting the falsehood the original criterion asked for.
 */
const cleanup: string[] = [];

async function fixture(id: string, editBeforeCurrent: boolean): Promise<{ root: string; base: string }> {
    const root = await mkdtemp(join(tmpdir(), `kata-surface-visibility-${id}-`));
    cleanup.push(root);
    await initLayout(root);
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src/settled.ts'), 'export const settled = 1;\n', 'utf8');
    await createTask({
        root,
        id,
        title: id,
        ownedPaths: ['src/settled.ts', 'src/later.ts'],
        acceptance: [{ id: 'AC-1', statement: 'the surface follows content' }],
    } as never);
    if (editBeforeCurrent) {
        // The repair case the finding named: the edit lands **before** the base seal, so the base already holds it and the
        // delta must be empty for this path. Writing it after the base would make it a genuine change — measured: the first
        // version of this fixture did exactly that and the test failed for its own reason rather than the code's.
        await writeFile(join(root, 'src/settled.ts'), 'export const settled = 1;\n// touched before the base seal\n', 'utf8');
    }
    const base = await createTaskRevision({ root, taskId: id, ownedPaths: ['src/settled.ts'], checkIds: [] });
    if (!editBeforeCurrent) {
        // The other side of the equivalence: an edit **after** the base seal is a real change and must be reported. Without
        // this branch the fixture left the file untouched and the case passed for the wrong reason.
        await writeFile(join(root, 'src/settled.ts'), 'export const settled = 1;\n// touched after the base seal\n', 'utf8');
    }
    await writeFile(join(root, 'src/later.ts'), 'export const later = 2;\n', 'utf8');
    await createTaskRevision({ root, taskId: id, ownedPaths: ['src/settled.ts', 'src/later.ts'], checkIds: [] });
    return { root, base: base.id };
}

async function surfaceOf(root: string, id: string, base: string): Promise<string[]> {
    const { buildAdversarialBrief } = await import('../../src/quality/adversarial.js');
    const brief = await buildAdversarialBrief(root, id, 'review', { since: base });
    const scope = brief.ir?.scope;
    return scope?.kind === 'delta' ? [...scope.changedPaths] : [];
}

describe('the surface reports a path changed exactly when its content differs', () => {
    afterEach(async () => {
        await Promise.all(cleanup.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
    });

    it('reports the path that differs, and not the one already settled in the base', async () => {
        const { root, base } = await fixture('surface-visibility', true);
        const changed = await surfaceOf(root, 'surface-visibility', base);
        expect(changed).toContain('src/later.ts');
        // The repair case: its content is the base's content, so reporting it would be the defect.
        expect(changed).not.toContain('src/settled.ts');
    });

    it('reports the same path when it really does differ between the two revisions', async () => {
        const { root, base } = await fixture('surface-visibility-changed', false);
        const changed = await surfaceOf(root, 'surface-visibility-changed', base);
        expect(changed).toContain('src/later.ts');
        expect(changed).toContain('src/settled.ts');
    });
});
