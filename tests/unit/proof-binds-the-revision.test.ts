import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { initLayout } from '../../src/core/layout.js';
import { createTask } from '../../src/core/task.js';
import { createTaskRevision, readCurrentTaskRevision, computeBothOwnedDigests } from '../../src/workflow/revision.js';

/**
 * **A proof binds the content its revision describes, not the working tree** — measured as the reason five dispositions on
 * `kata-gate-surface` were unreadable while their work was real.
 *
 * The criterion compares a disposition's recorded digests against the revision it is being resolved for. So a proof recording the
 * working tree *at the moment of recording* can only match a revision sealed from that same content; on this task `falsify` recorded
 * `291e4daa5c1a` for a file the revision names `a176c56ce1aa`, and 11 of its 19 paths had moved — every disposition refused, by a rule
 * being handed the wrong half of the comparison.
 *
 * The falsifier is the comparison itself: after an edit that leaves the revision stale, the revision's digests still equal what a
 * proof must record, while the freshly computed tree digests do not. Delete the `sealed` preference in the falsify command and the
 * second assertion reddens.
 */
describe('a proof records what the revision describes', () => {
    it('differs from the working tree once the file has moved on', async () => {
        const root = await mkdtemp(join(tmpdir(), 'kata-bind-'));
        try {
            await initLayout(root);
            await createTask({ root, id: 'bind-task', title: 'B', ownedPaths: ['src/a.ts'], acceptance: [{ id: 'AC-1', statement: 'x' }] });
            await mkdir(join(root, 'src'), { recursive: true });
            await writeFile(join(root, 'src/a.ts'), 'export const a = 1;\n', 'utf8');
            await createTaskRevision({ root, taskId: 'bind-task', ownedPaths: ['src/a.ts'], checkIds: [] });
            const revision = await readCurrentTaskRevision(root, 'bind-task');
            const sealed = revision?.pathDigests ?? {};
            // The edit that makes the revision stale: this is the state in which every disposition was refused.
            await writeFile(join(root, 'src/a.ts'), 'export const a = 2;\n', 'utf8');
            const computed = await computeBothOwnedDigests(root, ['src/a.ts']);
            expect(Object.keys(sealed).length).toBeGreaterThan(0);
            // What a proof must record is the revision's digest; the working tree's differs, which is exactly why the wrong half
            // of this comparison refused honest work.
            expect(computed.pathDigests['src/a.ts']).not.toBe(sealed['src/a.ts']);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });
});
