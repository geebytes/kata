import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initLayout } from '../../src/core/layout.js';
import { createTask } from '../../src/core/task.js';
import { runLifecycleCommand } from '../../src/cli/lifecycle.js';
import { recordLifecycleTrigger } from '../../src/workflow/lifecycle-reconciliation.js';
import { readInitiativeLifecycle } from '../../src/core/initiative-lifecycle.js';

/**
 * **AC-8's own evidence: a slice admitted into an Initiative is never silently treated as current.**
 *
 * This case owns the criterion rather than borrowing another file's assertion, because the two halves of AC-8 are about
 * the *admission path*: a slice attached to an Initiative has no declared dependency surface yet, so nothing can show it
 * unaffected — the answer is `needs_reassessment` for the design and `undetermined` overall. Reading that as `fresh` is
 * the stale-audit failure the whole change exists to prevent.
 *
 * It is an integration case in the repository's sense of the word: the relation is created through the CLI command family,
 * the trigger runs against the real task store, and the result is read back through the same CLI — so it exercises the
 * chain an operator takes, not the evaluator alone.
 */
describe('a slice admitted to an Initiative is not silently current', () => {
    const roots: string[] = [];

    afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

    async function tempRoot(prefix: string, taskIds: string[]): Promise<string> {
        const root = await mkdtemp(join(tmpdir(), prefix));
        roots.push(root);
        await initLayout(root);
        for (const taskId of taskIds) {
            await createTask({ root, id: taskId, title: taskId, acceptance: [{ id: 'AC-1', statement: 'x' }] });
        }
        return root;
    }

    it('reports needs_reassessment while the design declares no dependency surface', async () => {
        const root = await tempRoot('kata-lifecycle-legacy-', ['legacy-slice']);
        await runLifecycleCommand(['create', '--initiative', 'legacy-initiative', '--root', root]);
        await runLifecycleCommand([
            'attach', '--initiative', 'legacy-initiative', '--task', 'legacy-slice',
            '--policy', 'informs', '--return', 'impact_packet', '--root', root,
        ]);
        // A design with no declared surface: exactly the state a slice is in the first time it enters an Initiative.
        await runLifecycleCommand(['design', '--initiative', 'legacy-initiative', '--design', 'legacy-design', '--root', root]);

        const result = await recordLifecycleTrigger(root, {
            taskId: 'legacy-slice',
            revisionId: 'revision-legacy',
            changedPaths: ['src/core/layout.ts'],
        });

        // Not `fresh`: nothing could be compared, so nothing may be asserted as unaffected.
        expect(result.status).toBe('undetermined');
        expect(result.packets).toEqual([]);

        // And the state the operator reads says the same thing, rather than looking settled.
        const status = await runLifecycleCommand(['status', '--initiative', 'legacy-initiative', '--root', root]);
        expect(status.readState).toBe('usable');
        expect(status.openPacketIds).toEqual([]);
    });

    it('does not rebase an Initiative that is outside the changed relation component', async () => {
        const root = await tempRoot('kata-lifecycle-outside-', ['other-child']);
        await runLifecycleCommand(['create', '--initiative', 'untouched-initiative', '--root', root]);
        await runLifecycleCommand(['create', '--initiative', 'other-initiative', '--root', root]);
        await runLifecycleCommand([
            'attach', '--initiative', 'other-initiative', '--task', 'other-child',
            '--policy', 'informs', '--return', 'impact_packet', '--root', root,
        ]);
        await runLifecycleCommand([
            'design', '--initiative', 'untouched-initiative', '--design', 'untouched-design',
            '--depends-on', 'src/core/layout.ts', '--root', root,
        ]);

        // `other-child` moved exactly the path the untouched Initiative's design depends on, and it is still not this
        // Initiative's problem: the walk starts at the Initiative's own endpoint.
        const result = await recordLifecycleTrigger(root, {
            taskId: 'other-child',
            revisionId: 'revision-other',
            changedPaths: ['src/core/layout.ts'],
        });

        expect(result.initiatives).not.toContain('untouched-initiative');

        const untouched = await readInitiativeLifecycle(root, 'untouched-initiative');
        expect(untouched.current.status).toBe('active');
        expect(untouched.current.openPacketIds).toEqual([]);
    });
    it('treats a linked legacy slice without designs.json as undetermined rather than fresh', async () => {
        const root = await tempRoot('kata-lifecycle-legacy-no-declaration-', ['legacy-slice']);
        await runLifecycleCommand(['create', '--initiative', 'legacy-initiative', '--root', root]);
        await runLifecycleCommand([
            'attach', '--initiative', 'legacy-initiative', '--task', 'legacy-slice',
            '--policy', 'informs', '--return', 'impact_packet', '--root', root,
        ]);

        const result = await recordLifecycleTrigger(root, {
            taskId: 'legacy-slice',
            revisionId: 'revision-legacy',
            changedPaths: ['src/core/layout.ts'],
        });

        expect(result.status).toBe('undetermined');
        expect(result.packets).toEqual([]);
    });

});
