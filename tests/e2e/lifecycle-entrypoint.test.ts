import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { initLayout } from '../../src/core/layout.js';
import { createTask } from '../../src/core/task.js';
import { runLifecycleCommand } from '../../src/cli/lifecycle.js';
import { recordLifecycleTrigger } from '../../src/workflow/lifecycle-reconciliation.js';

/**
 * **The lifecycle surface, driven through the CLI the operator actually runs.**
 *
 * Unit evidence proves the modules agree with each other; it cannot prove the entrypoint exists. This repository has paid
 * for that distinction repeatedly (`mechanism-without-consumer`: a mechanism with a library and no reachable route), and
 * the acceptance contract asks for integration evidence precisely here — so the case below builds the real bundle and
 * invokes it as a process, rather than importing the dispatcher.
 *
 * The second half drives the workflow trigger end to end against a real task store, so the chain the design promises
 * (relation attaches a slice → a related seal produces an impact packet the parent can see) is exercised as a chain.
 */
describe('lifecycle entrypoint, end to end', () => {
    const roots: string[] = [];

    afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

    const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
    const cliEntry = join(repoRoot, 'dist', 'cli.js');

    async function tempRoot(prefix: string, taskIds: string[]): Promise<string> {
        const root = await mkdtemp(join(tmpdir(), prefix));
        roots.push(root);
        await initLayout(root);
        for (const taskId of taskIds) {
            await createTask({ root, id: taskId, title: taskId, acceptance: [{ id: 'AC-1', statement: 'x' }] });
        }
        return root;
    }

    it('answers the lifecycle family through the built CLI, not only through the module', async () => {
        const root = await tempRoot('kata-lifecycle-e2e-', ['child']);

        // The bundle must exist for this evidence to mean anything; building here rather than assuming keeps the case from
        // passing on a stale artifact from an earlier change.
        execFileSync(process.execPath, [join(repoRoot, 'scripts', 'build.mjs')], { cwd: repoRoot, stdio: 'pipe' });

        const created = JSON.parse(
            execFileSync(process.execPath, [cliEntry, 'lifecycle', 'create', '--initiative', 'e2e-initiative', '--root', root], { encoding: 'utf8' })
        ) as { command: string; initiativeId: string };
        expect(created).toMatchObject({ command: 'lifecycle create', initiativeId: 'e2e-initiative' });

        const attached = JSON.parse(
            execFileSync(
                process.execPath,
                [cliEntry, 'lifecycle', 'attach', '--initiative', 'e2e-initiative', '--task', 'child', '--policy', 'informs', '--return', 'impact_packet', '--root', root],
                { encoding: 'utf8' }
            )
        ) as { command: string; relationId: string | null };
        expect(attached.relationId).toEqual(expect.any(String));

        const status = JSON.parse(
            execFileSync(process.execPath, [cliEntry, 'lifecycle', 'status', '--initiative', 'e2e-initiative', '--root', root], { encoding: 'utf8' })
        ) as { command: string; readState: string; relationIds: string[] };
        expect(status.command).toBe('lifecycle status');
        expect(status.readState).toBe('usable');
        // The id the CLI reported is the id the graph holds: a command reporting an id nobody stored would make every
        // later binding check fail with no visible cause.
        expect(status.relationIds).toContain(attached.relationId);
    });

    it('carries a related seal to an impact packet the parent can read back', async () => {
        const root = await tempRoot('kata-lifecycle-chain-', ['child']);
        await runLifecycleCommand(['create', '--initiative', 'chain-initiative', '--root', root]);
        const attached = await runLifecycleCommand([
            'attach', '--initiative', 'chain-initiative', '--task', 'child',
            '--policy', 'informs', '--return', 'impact_packet', '--root', root,
        ]);
        const relationId = attached.relationId as string;
        await runLifecycleCommand([
            'design', '--initiative', 'chain-initiative', '--design', 'parent-design',
            '--depends-on', 'src/core/layout.ts', '--root', root,
        ]);

        const result = await recordLifecycleTrigger(root, {
            taskId: 'child',
            revisionId: 'revision-e2e',
            changedPaths: ['src/core/layout.ts'],
        });

        expect(result.status).toBe('needs_reassessment');
        expect(result.packets).toHaveLength(1);
        expect(result.packets[0]).toMatchObject({ relationId, taskId: 'child' });

        // Read back through the CLI: the packet must be visible to the parent, not merely returned to the caller.
        const status = await runLifecycleCommand(['status', '--initiative', 'chain-initiative', '--root', root]);
        expect(status.openPacketIds).toHaveLength(1);
        expect(status.status).toBe('active');
    });
});
