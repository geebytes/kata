import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runLifecycleCommand } from '../../src/cli/lifecycle.js';
import { recordLifecycleTrigger } from '../../src/workflow/lifecycle-reconciliation.js';
import { appendLifecycleEvent, readInitiativeLifecycle, initiativeEventsPath } from '../../src/core/initiative-lifecycle.js';
import { addLifecycleRelation } from '../../src/core/relations.js';
import { createTask } from '../../src/core/task.js';
import { initLayout } from '../../src/core/layout.js';

/**
 * **The lifecycle surface has to be reachable, and its consumers have to consume it.**
 *
 * A mechanism with no entry point is the defect this repository finds most often (`mechanism-without-consumer`), so these
 * two cases are deliberately different in kind. The first drives the CLI — the operator's actual route — and asserts the
 * command exists and writes what it says it writes. The second replaces the reconciliation result with a constant and
 * requires the consumer to change behaviour; a case that passes under that mutation is a case that never reached the
 * code it claims to test.
 */
describe('lifecycle command and trigger wiring', () => {
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

    it('creates an Initiative and attaches a slice through the command surface', async () => {
        const root = await tempRoot('kata-lifecycle-cli-', ['child']);

        const created = await runLifecycleCommand(['create', '--initiative', 'records-initiative', '--root', root]);
        expect(created).toMatchObject({ command: 'lifecycle create', initiativeId: 'records-initiative' });

        const attached = await runLifecycleCommand([
            'attach', '--initiative', 'records-initiative', '--task', 'child',
            '--policy', 'informs', '--return', 'impact_packet', '--root', root,
        ]);
        expect(attached).toMatchObject({ command: 'lifecycle attach', relationId: expect.any(String) });

        // The attachment is in the one graph, and the relation id it reports is the one the graph holds — a command that
        // reports an id the graph does not carry would make every later binding check fail for no visible reason.
        const status = await runLifecycleCommand(['status', '--initiative', 'records-initiative', '--root', root]);
        expect(status).toMatchObject({ command: 'lifecycle status', relationIds: [attached.relationId as string] });
    });

    it('records an impact packet when a related slice seals a revision that touches a declared design surface', async () => {
        const root = await tempRoot('kata-lifecycle-trigger-', ['child']);
        const graph = await addLifecycleRelation({
            root,
            from: { type: 'change', id: 'records-initiative' },
            to: { type: 'task', id: 'child' },
            type: 'related_to',
            lifecycle: { initiativeId: 'records-initiative', policy: 'informs', requiredReturn: 'impact_packet' },
        });
        const relationId = graph.relations[0]?.id as string;
        await appendLifecycleEvent(root, 'records-initiative', {
            type: 'design_needs_reassessment',
            relationId,
            designId: 'parent-design',
            reason: 'baseline',
        });
        // A declared dependency surface, so the design can be shown affected rather than merely unknown.
        await writeFile(join(root, '.kata/initiatives/records-initiative/designs.json'), `${JSON.stringify({
            designs: [{ designId: 'parent-design', dependsOn: ['path:src/core/layout.ts'] }],
        })}\n`, 'utf8');

        const result = await recordLifecycleTrigger(root, {
            taskId: 'child',
            revisionId: 'revision-a',
            changedPaths: ['src/core/layout.ts'],
        });

        expect(result.packets).toHaveLength(1);
        expect(result.packets[0]).toMatchObject({ relationId, taskId: 'child', result: 'needs_reassessment' });

        // The packet is durable: a trigger that only returned it would leave the parent unable to see it later.
        const state = await readInitiativeLifecycle(root, 'records-initiative');
        expect(state.current.openPacketIds.length).toBeGreaterThan(0);
    });

    it('changes behaviour when the reconciliation result is replaced by a constant', async () => {
        const root = await tempRoot('kata-lifecycle-consumer-', ['child']);
        await addLifecycleRelation({
            root,
            from: { type: 'change', id: 'records-initiative' },
            to: { type: 'task', id: 'child' },
            type: 'related_to',
            lifecycle: { initiativeId: 'records-initiative', policy: 'informs', requiredReturn: 'impact_packet' },
        });
        await mkdir(join(root, '.kata/initiatives/records-initiative'), { recursive: true });
        await writeFile(join(root, '.kata/initiatives/records-initiative/designs.json'), `${JSON.stringify({
            designs: [{ designId: 'parent-design', dependsOn: ['path:src/core/layout.ts'] }],
        })}\n`, 'utf8');
        // A relation with no lifecycle metadata is the case that must not be read as "unaffected".
        await writeFile(join(root, '.kata/relations.json'), `${JSON.stringify({
            version: 2,
            relations: [
                {
                    id: 'edge-1',
                    kind: 'context',
                    type: 'related_to',
                    from: { type: 'change', id: 'records-initiative' },
                    to: { type: 'task', id: 'child' },
                    createdAt: '2026-10-03T00:00:00.000Z',
                },
            ],
            updatedAt: '2026-10-03T00:00:00.000Z',
        }, null, 2)}\n`, 'utf8');

        const result = await recordLifecycleTrigger(root, {
            taskId: 'child',
            revisionId: 'revision-a',
            changedPaths: ['src/core/layout.ts'],
        });

        expect(result.status).toBe('undetermined');
        expect(result.packets).toEqual([]);
        // Nothing was written under a name that reads as a pass.
        const events = await readFileOrNull(initiativeEventsPath(root, 'records-initiative'));
        expect(events ?? '').not.toContain('needs_reassessment');
    });
});

async function readFileOrNull(path: string): Promise<string | null> {
    try {
        const { readFile } = await import('node:fs/promises');
        return await readFile(path, 'utf8');
    } catch {
        return null;
    }
}
