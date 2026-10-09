import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runLedgerCommand } from '../../src/cli/ledger.js';
import { readLedger } from '../../src/store/ledger.js';

/**
 * **AC-7 — a verb that refuses writes nothing, and says one thing.**
 *
 * Two shapes, one rule. `ledger usage set` collected its numbers through a helper that *reported* a bad value by calling
 * `fail` and then returned `undefined` — so the command printed the refusal, carried on, and wrote `usage.json` anyway:
 * `--tokens -5 --wall-ms 10` emitted two contradictory documents (`ok:false`, then `ok:true`) and exited 1.
 *
 * `ledger evidence add` writes a submission claim-first and evidence-second, so a refused evidence item left the
 * submission's claims on disk — a refusal that had already changed the ledger, which is the state the next `evidence
 * verify` refused for a reason that named neither the item nor the submission. Both are now: every value read before
 * anything is refused, and every item checked before anything is written.
 */
const roots: string[] = [];
const changeId = 'refusal-writes-nothing';

async function tempRoot(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'kata-refusal-'));
    roots.push(root);
    await mkdir(join(root, '.kata', 'tasks', changeId), { recursive: true });
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src', 'a.ts'), 'export const holds = true;\n');
    await writeFile(join(root, '.kata', 'tasks', changeId, 'task.json'), `${JSON.stringify({
        id: changeId, title: 'Refusal', phase: 'intake',
        acceptance: [{ id: 'AC-1', statement: 'It holds.' }],
        ownedPaths: ['src/a.ts'],
        createdAt: '2026-10-09T00:00:00.000Z', updatedAt: '2026-10-09T00:00:00.000Z',
    }, null, 2)}\n`);
    return root;
}

/** Every document the command printed, in order — so "exactly one document" is an assertion and not a hope. */
async function ledger(root: string, argv: string[]): Promise<{ documents: Record<string, unknown>[]; exitCode: number | string | null | undefined }> {
    const chunks: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
        chunks.push(String(chunk));
        return true;
    });
    const previous = process.exitCode;
    process.exitCode = 0;
    let exitCode: number | string | null | undefined = 0;
    try {
        await runLedgerCommand(argv, { root, changeId });
        exitCode = process.exitCode;
    } finally {
        spy.mockRestore();
        process.exitCode = previous;
    }
    const documents = chunks.join('').split('\n')
        .map((line) => line.trim())
        .filter((line) => line.startsWith('{'))
        .map((line) => JSON.parse(line) as Record<string, unknown>);
    return { documents, exitCode };
}

async function usageBytes(root: string): Promise<string | null> {
    return readFile(join(root, '.kata', 'tasks', changeId, 'review', 'usage.json'), 'utf8').catch(() => null);
}

const submission = (body: unknown): string => `${JSON.stringify(body)}\n`;

afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('a ledger verb that refuses writes nothing', () => {
    it('refuses an invalid usage value once, and records no budget', async () => {
        const root = await tempRoot();

        const { documents, exitCode } = await ledger(root, ['usage', 'set', '--tokens', '-5', '--wall-ms', '10']);

        // One document, and it is the refusal: measured before the fix, this emitted the refusal *and* `ok:true`.
        expect(documents).toHaveLength(1);
        expect(documents[0]?.ok).toBe(false);
        expect(String(documents[0]?.error)).toContain('--tokens');
        expect(exitCode).toBe(1);
        expect(await usageBytes(root)).toBeNull();
    });

    it('still records a budget when every value parses, so the refusal is not "never write"', async () => {
        const root = await tempRoot();

        const { documents, exitCode } = await ledger(root, ['usage', 'set', '--tokens', '10', '--wall-ms', '20']);

        expect(documents).toHaveLength(1);
        expect(documents[0]?.ok).toBe(true);
        expect(exitCode).toBe(0);
        expect(JSON.parse((await usageBytes(root)) ?? '{}')).toMatchObject({ usage: { tokens: 10, wallMs: 20 } });
    });

    it('refuses a submission whose evidence conflicts without writing the claims it carried', async () => {
        const root = await tempRoot();
        await writeFile(join(root, 'first.json'), submission({
            claims: [],
            evidence: [{ id: 'E1', type: 'static_witness', ref: 'src/a.ts', assertion: 'contains:holds' }],
        }));
        expect((await ledger(root, ['evidence', 'add', '--file', join(root, 'first.json')])).documents[0]?.ok).toBe(true);
        const before = await readLedger(root, changeId);

        // The same id with different content, carried beside a claim the submission also declares.
        await writeFile(join(root, 'conflict.json'), submission({
            claims: [{
                id: 'C-9', statement: 'a claim that must not land', riskClass: 'consistency', severity: 'major',
                dependsOn: ['path:src/a.ts'], evidenceIds: ['E1'], challengeIds: [], status: 'open',
                at: '2026-10-09T00:00:00.000Z', reopens: 0,
            }],
            evidence: [{ id: 'E1', type: 'static_witness', ref: 'src/a.ts', assertion: 'contains:something-else' }],
        }));

        const { documents, exitCode } = await ledger(root, ['evidence', 'add', '--file', join(root, 'conflict.json')]);

        expect(documents).toHaveLength(1);
        expect(documents[0]?.ok).toBe(false);
        expect(String(documents[0]?.error)).toContain('E1');
        expect(exitCode).toBe(1);
        // The decisive assertion: the claim the refused submission carried is not on disk. Measured before the fix, it was.
        const after = await readLedger(root, changeId);
        expect(after.claims.map((claim) => claim.id)).toEqual(before.claims.map((claim) => claim.id));
        expect(after.claims.some((claim) => claim.id === 'C-9')).toBe(false);
        expect(after.evidence).toHaveLength(before.evidence.length);
    });

    it('refuses an id carried twice in one submission, before either copy lands', async () => {
        const root = await tempRoot();
        await writeFile(join(root, 'twice.json'), submission({
            claims: [],
            evidence: [
                { id: 'E2', type: 'static_witness', ref: 'src/a.ts', assertion: 'contains:holds' },
                { id: 'E2', type: 'static_witness', ref: 'src/a.ts', assertion: 'contains:something-else' },
            ],
        }));

        const { documents } = await ledger(root, ['evidence', 'add', '--file', join(root, 'twice.json')]);

        expect(documents).toHaveLength(1);
        expect(documents[0]?.ok).toBe(false);
        expect(String(documents[0]?.error)).toContain('twice');
        expect((await readLedger(root, changeId)).evidence).toHaveLength(0);
    });

    it('accepts a clean submission, so the pre-flight is not a blanket refusal', async () => {
        const root = await tempRoot();
        await writeFile(join(root, 'clean.json'), submission({
            claims: [{
                id: 'C-1', statement: 'clean claim', riskClass: 'consistency', severity: 'major',
                dependsOn: ['path:src/a.ts'], evidenceIds: ['E3'], challengeIds: [], status: 'open',
                at: '2026-10-09T00:00:00.000Z', reopens: 0,
            }],
            evidence: [{ id: 'E3', type: 'static_witness', ref: 'src/a.ts', assertion: 'contains:holds' }],
        }));

        const { documents, exitCode } = await ledger(root, ['evidence', 'add', '--file', join(root, 'clean.json')]);

        expect(documents).toHaveLength(1);
        expect(documents[0]?.ok).toBe(true);
        expect(exitCode).toBe(0);
        const after = await readLedger(root, changeId);
        expect(after.claims.map((claim) => claim.id)).toEqual(['C-1']);
        expect(after.evidence.map((item) => item.id)).toEqual(['E3']);
    });
});
