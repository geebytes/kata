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

describe('the brief offers the facts instead of the text', () => {
    it('renders a live fact as a reference and names a stale one as changed', async () => {
        const root = await workspace();
        const { createTaskRevision } = await import('../../src/workflow/revision.js');
        const { buildAdversarialBrief } = await import('../../src/quality/adversarial.js');
        await createTaskRevision({ root, taskId: 'f-task', ownedPaths: ['src/a.ts'], checkIds: [] });

        await recordDeliveredFact(root, 'f-task', { path: 'src/a.ts', note: 'the constant is one', at: '2026-09-23T01:00:00.000Z' });
        const live = await buildAdversarialBrief(root, 'f-task', 'review');
        expect(live.text).toContain('## What a previous round read');
        expect(live.text).toContain('the constant is one');

        // Change the content: the fact must stop being offered and the path must be named as changed instead.
        await writeFile(join(root, 'src/a.ts'), 'export const a = 2;\n', 'utf8');
        const after = await buildAdversarialBrief(root, 'f-task', 'review');
        expect(after.text).not.toContain('the constant is one');
        expect(after.text).toContain('changed since');
        expect(after.text).toContain('src/a.ts');
    }, 60000);
});

describe('the record path is the producer', () => {
    it('writes the facts a pass delivered, with hashes taken from the content', async () => {
        const root = await workspace();
        const { createTaskRevision } = await import('../../src/workflow/revision.js');
        const { writeAdversarialRecord } = await import('../../src/quality/adversarial.js');
        await createTaskRevision({ root, taskId: 'f-task', ownedPaths: ['src/a.ts'], checkIds: [] });

        await writeAdversarialRecord(root, 'f-task', {
            node: 'review',
            status: 'recorded',
            revisionId: 'revision-one',
            manifestHash: 'hash-one',
            executedInFreshContext: true,
            contextNote: 'a fixture',
            createdAt: '2026-09-23T01:00:00.000Z',
            hypotheses: [],
            attempts: [],
            findings: [],
            deliveredFacts: [
                { path: 'src/a.ts', note: 'the constant is one' },
                // A path that is not there: the pass is reporting something it did not read, so nothing is written for it.
                { path: 'src/never-existed.ts', note: 'a claim about a file that is not there' },
            ],
        } as never);

        const { live } = await readDeliveredFacts(root, 'f-task');
        expect(live.map((fact) => fact.path)).toEqual(['src/a.ts']);
        expect(live[0]?.note).toBe('the constant is one');
        const { createHash } = await import('node:crypto');
        expect(live[0]?.sha256).toBe(createHash('sha256').update('export const a = 1;\n').digest('hex'));
    }, 60000);
});
