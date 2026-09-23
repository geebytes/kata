import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initLayout } from '../../src/core/layout.js';
import { createTask } from '../../src/core/task.js';
import { recordDeliveredFact, readDeliveredFacts } from '../../src/quality/delivered-facts.js';

const cleanup: string[] = [];
afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function workspace(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'kata-facts-'));
    cleanup.push(root);
    await initLayout(root);
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src/a.ts'), 'export const a = 1;\n', 'utf8');
    await createTask({ root, id: 'f-task', title: 'f-task', ownedPaths: ['src/a.ts'], acceptance: [{ id: 'AC-1', statement: 'x' }] } as never);
    return root;
}

describe('the delivered-fact ledger', () => {
    it('addresses a fact by content, so the same content is one fact', async () => {
        const root = await workspace();
        const first = await recordDeliveredFact(root, 'f-task', { path: 'src/a.ts', note: 'the constant is one', at: '2026-09-23T01:00:00.000Z' });
        const second = await recordDeliveredFact(root, 'f-task', { path: 'src/a.ts', note: 'restated', at: '2026-09-23T02:00:00.000Z' });

        expect(second.id).toBe(first.id);
        const { live } = await readDeliveredFacts(root, 'f-task');
        expect(live).toHaveLength(1);
        expect(live[0]?.note).toBe('restated');
    });

    it('takes the hash from the content rather than from the caller', async () => {
        const root = await workspace();
        const fact = await recordDeliveredFact(root, 'f-task', { path: 'src/a.ts', note: 'n', at: '2026-09-23T01:00:00.000Z' });
        const { createHash } = await import('node:crypto');
        const expected = createHash('sha256').update('export const a = 1;\n').digest('hex');
        expect(fact.sha256).toBe(expected);
    });

    it('goes stale when the content changes, and live again when it changes back', async () => {
        const root = await workspace();
        await recordDeliveredFact(root, 'f-task', { path: 'src/a.ts', note: 'n', at: '2026-09-23T01:00:00.000Z' });

        await writeFile(join(root, 'src/a.ts'), 'export const a = 2;\n', 'utf8');
        const changed = await readDeliveredFacts(root, 'f-task');
        expect(changed.live).toHaveLength(0);
        expect(changed.stale).toHaveLength(1);

        await writeFile(join(root, 'src/a.ts'), 'export const a = 1;\n', 'utf8');
        const restored = await readDeliveredFacts(root, 'f-task');
        expect(restored.live).toHaveLength(1);
    });

    it('refuses to record a fact about a path that is not there', async () => {
        const root = await workspace();
        await expect(recordDeliveredFact(root, 'f-task', { path: 'src/missing.ts', note: 'n', at: '2026-09-23T01:00:00.000Z' }))
            .rejects.toThrow(/does not exist/);
    });
});
