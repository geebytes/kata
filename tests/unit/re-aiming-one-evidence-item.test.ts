import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initLayout } from '../../src/core/layout.js';
import { createTask } from '../../src/core/task.js';
import { appendEvidence, replaceOneEvidence } from '../../src/store/ledger.js';
import { runLedgerCommand } from '../../src/cli/ledger.js';

/**
 * AC-1 — re-aiming one evidence item is one command, and it leaves every other item's binding byte-identical.
 *
 * The narrow command is deliberately driven in-process. `dist/cli.js` is gitignored and absent in the seal's sandbox;
 * exercising it would turn a regression in `src/cli/ledger.ts` into a silent skip. The store carries the data invariant,
 * while this file additionally proves the source CLI parses and envelopes the narrow form.
 */
const roots: string[] = [];

function fixture(): string {
    const root = mkdtempSync(join(tmpdir(), 'kata-reaim-'));
    roots.push(root);
    return root;
}

async function ledgerJson(root: string, args: string[]): Promise<{ exitCode: number; payload: Record<string, unknown> }> {
    const chunks: string[] = [];
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
        chunks.push(String(chunk));
        return true;
    });
    const previousExitCode = process.exitCode;
    process.exitCode = 0;
    try {
        await runLedgerCommand(args, { root, changeId: 'held' });
        const line = chunks.join('').trim().split('\n').filter((entry) => entry.trim().startsWith('{')).at(-1);
        return { exitCode: process.exitCode ?? 0, payload: line === undefined ? {} : JSON.parse(line) as Record<string, unknown> };
    } finally {
        stdout.mockRestore();
        process.exitCode = previousExitCode;
    }
}

function evidence(id: string, find: string, replace: string): Record<string, unknown> {
    return { id, type: 'executable_falsifier', command: `vitest run tests/unit/${id}.test.ts`, mutation: { file: 'src/a.ts', find, replace } };
}

async function seeded(): Promise<{ root: string }> {
    const root = fixture();
    await initLayout(root);
    await createTask({ root, id: 'held', title: 'Held', acceptance: [{ id: 'AC-1', statement: 'x' }], ownedPaths: ['src/a.ts'] });
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 1;\nexport const b = 2;\n');
    for (const item of [evidence('E1', 'export const a = 1;', 'export const a = 2;'), evidence('E2', 'export const b = 2;', 'export const b = 3;')]) {
        const added = await appendEvidence(root, 'held', item as never);
        expect(added.ok, JSON.stringify(added)).toBe(true);
    }
    return { root };
}

function stored(root: string): Array<{ id: string; mutation: { find: string } }> {
    return JSON.parse(readFileSync(join(root, '.kata', 'tasks', 'held', 'review', 'evidence.json'), 'utf8')) as Array<{ id: string; mutation: { find: string } }>;
}

afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('re-aiming one evidence item', () => {
    it('accepts the bare item named by the seal, updates it, and leaves every other item byte-identical', async () => {
        const { root } = await seeded();
        const beforeE2 = JSON.stringify(stored(root).find((entry) => entry.id === 'E2'));
        const item = join(root, 'item.json');
        writeFileSync(item, `${JSON.stringify(evidence('E1', 'export const a = 2;', 'export const a = 3;'))}\n`);

        const reaimed = await ledgerJson(root, ['evidence', 'replace', '--change', 'held', '--id', 'E1', '--file', item, '--reason', 'the repair moved the line this anchor pointed at']);

        expect(reaimed.exitCode).toBe(0);
        expect(reaimed.payload).toMatchObject({ ok: true, command: 'ledger evidence replace', replaced: 1, evidenceId: 'E1', untouched: ['E2'] });
        expect(JSON.stringify(stored(root).find((entry) => entry.id === 'E2'))).toBe(beforeE2);
        expect(stored(root).find((entry) => entry.id === 'E1')?.mutation.find).toBe('export const a = 2;');
    });

    it('uses the same store operation in process, so the data invariant is not a bundle artifact', async () => {
        const { root } = await seeded();
        const beforeE2 = JSON.stringify(stored(root).find((entry) => entry.id === 'E2'));
        const outcome = await replaceOneEvidence(root, 'held', evidence('E1', 'export const a = 2;', 'export const a = 3;') as never, 'the repair moved the line this anchor pointed at');

        expect(outcome).toMatchObject({ replaced: 1, untouched: ['E2'] });
        expect(JSON.stringify(stored(root).find((entry) => entry.id === 'E2'))).toBe(beforeE2);
        expect(stored(root).find((entry) => entry.id === 'E1')?.mutation.find).toBe('export const a = 2;');
    });

    it('envelopes a missing stored id instead of throwing plain stderr text', async () => {
        const { root } = await seeded();
        const before = readFileSync(join(root, '.kata', 'tasks', 'held', 'review', 'evidence.json'), 'utf8');
        const item = join(root, 'unknown.json');
        writeFileSync(item, `${JSON.stringify(evidence('E9', 'x', 'y'))}\n`);

        const refused = await ledgerJson(root, ['evidence', 'replace', '--change', 'held', '--id', 'E9', '--file', item, '--reason', 'x']);

        expect(refused.exitCode).toBe(1);
        expect(refused.payload).toMatchObject({ ok: false, command: 'ledger evidence replace' });
        expect(String(refused.payload.error)).toMatch(/holds no evidence item E9/u);
        expect(readFileSync(join(root, '.kata', 'tasks', 'held', 'review', 'evidence.json'), 'utf8')).toBe(before);
    });

    it('refuses a duplicate id in either narrow or wide submission instead of choosing one silently', async () => {
        const { root } = await seeded();
        const duplicate = join(root, 'duplicate.json');
        writeFileSync(duplicate, `${JSON.stringify({ claims: [], evidence: [evidence('E1', 'export const a = 11;', 'export const a = 12;'), evidence('E1', 'export const a = 22;', 'export const a = 23;')] })}\n`);

        const narrow = await ledgerJson(root, ['evidence', 'replace', '--change', 'held', '--id', 'E1', '--file', duplicate, '--reason', 'x']);
        const wide = await ledgerJson(root, ['evidence', 'replace', '--change', 'held', '--file', duplicate, '--reason', 'x']);

        for (const refused of [narrow, wide]) {
            expect(refused.exitCode).toBe(1);
            expect(refused.payload).toMatchObject({ ok: false, command: 'ledger evidence replace' });
            expect(JSON.stringify(refused.payload)).toMatch(/E1.*twice|twice.*E1/u);
        }
    });
});
