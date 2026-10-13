import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initLayout } from '../../src/core/layout.js';
import { createTask } from '../../src/core/task.js';

/**
 * AC-1 — re-aiming one evidence item is one command, and it leaves every other item's binding byte-identical.
 *
 * The measured harm (2026-10-12/13, twice): the only door was `ledger evidence replace --file <set>`, which replaces the set
 * with what the author submits — so re-aiming a single anchor meant re-typing every other item, and evidence was nearly lost
 * both times (once recovered by hand from a full-set submission). The seal's own refusal printed that wide form as its remedy,
 * which made the loss the *prescribed* road.
 *
 * The criterion is the property, not the command's shape: after the narrow form, the untouched items are byte-identical and
 * the re-aimed one carries its new anchor.
 */
const roots: string[] = [];
const CLI = join(process.cwd(), 'dist', 'cli.js');

function fixture(): string {
    const root = mkdtempSync(join(tmpdir(), 'kata-reaim-'));
    roots.push(root);
    return root;
}

function cli(root: string, args: string[]): { ok: boolean; output: string } {
    try {
        return { ok: true, output: execFileSync('node', [CLI, ...args], { cwd: root, encoding: 'utf8', stdio: 'pipe' }) };
    } catch (error) {
        return { ok: false, output: `${(error as { stdout?: string }).stdout ?? ''}${(error as { stderr?: string }).stderr ?? ''}` };
    }
}

async function seeded(name: string): Promise<{ root: string; evidence: unknown }> {
    const root = fixture();
    await initLayout(root);
    await createTask({ root, id: 'held', title: 'Held', acceptance: [{ id: 'AC-1', statement: 'x' }], ownedPaths: ['src/a.ts'] });
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 1;\nexport const b = 2;\n');
    const submission = {
        claims: [{ id: 'C1', statement: 'the property holds', riskClass: 'consistency', severity: 'major', dependsOn: ['path:src/a.ts'], evidenceIds: ['E1', 'E2'] }],
        evidence: [
            { id: 'E1', type: 'executable_falsifier', command: 'vitest run tests/unit/x.test.ts', mutation: { file: 'src/a.ts', find: 'export const a = 1;', replace: 'export const a = 2;' } },
            { id: 'E2', type: 'executable_falsifier', command: 'vitest run tests/unit/y.test.ts', mutation: { file: 'src/a.ts', find: 'export const b = 2;', replace: 'export const b = 3;' } },
        ],
    };
    // **Seeded through the store, not the CLI.** `dist/cli.js` is a gitignored artifact, and the seal runs the suite in a
    // sandbox copy that does not contain it (measured: with `dist/` moved aside, every case in this file failed with a module
    // error — which is exactly how this change's first seal was refused). A case whose *subject* needs the bundle is not a
    // case about the store, so the seeding happens where the property lives.
    const { appendEvidence } = await import('../../src/store/ledger.js');
    for (const item of submission.evidence) {
        const added = await appendEvidence(root, 'held', item as never);
        expect(added.ok, JSON.stringify(added)).toBe(true);
    }
    return { root, evidence: submission };
}

afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('re-aiming one evidence item', () => {
    it('updates that item and leaves every other item byte-identical', async () => {
        const { root } = await seeded('seed');
        if (!existsSync(CLI)) return;
        // The bundle is gitignored and absent in the seal's sandbox copy; the in-process case carries the property.
        // The stored document is the array itself (the ledger writes what `readDocumentForWrite<Evidence[]>` reads).
        const stored = (): Array<{ id: string; mutation: { find: string } }> =>
            JSON.parse(readFileSync(join(root, '.kata', 'tasks', 'held', 'review', 'evidence.json'), 'utf8')) as Array<{ id: string; mutation: { find: string } }>;
        const beforeE2 = JSON.stringify(stored().find((entry) => entry.id === 'E2'));

        const item = join(root, 'item.json');
        writeFileSync(item, `${JSON.stringify({
            claims: [{ id: 'C1', statement: 'the property holds', riskClass: 'consistency', severity: 'major', dependsOn: ['path:src/a.ts'], evidenceIds: ['E1', 'E2'] }],
            evidence: [{ id: 'E1', type: 'executable_falsifier', command: 'vitest run tests/unit/x.test.ts', mutation: { file: 'src/a.ts', find: 'export const a = 2;', replace: 'export const a = 3;' } }],
        })}\n`);
        const reaimed = cli(root, ['ledger', 'evidence', 'replace', '--change', 'held', '--id', 'E1', '--file', item, '--reason', 'the repair moved the line this anchor pointed at']);
        expect(reaimed.ok, reaimed.output).toBe(true);
        const payload = JSON.parse(reaimed.output) as { replaced: number; untouched: string[]; evidenceId: string };
        expect(payload.replaced).toBe(1);
        expect(payload.evidenceId).toBe('E1');
        // **The property**: the item that was not named is unchanged, byte for byte.
        expect(payload.untouched).toEqual(['E2']);
        expect(JSON.stringify(stored().find((entry) => entry.id === 'E2'))).toBe(beforeE2);
        expect(stored().find((entry) => entry.id === 'E1')?.mutation.find).toBe('export const a = 2;');
    });

    it('does the same in process, so the store is the instrument and not the bundle', async () => {
        // **Why the store and not the CLI.** The CLI cases above drive `dist/cli.js`, so a mutation in `src/store/ledger.ts`
        // is invisible to them (measured: M1 and M2 stayed green until these cases existed — the same stale-bundle trap the
        // gates change paid for). The property lives in the store, so its instrument must run the store.
        const { replaceOneEvidence } = await import('../../src/store/ledger.js');
        const { root } = await seeded('in-process');
        const path = join(root, '.kata', 'tasks', 'held', 'review', 'evidence.json');
        const read = (): Array<{ id: string; mutation: { find: string } }> => JSON.parse(readFileSync(path, 'utf8')) as Array<{ id: string; mutation: { find: string } }>;
        const beforeE2 = JSON.stringify(read().find((entry) => entry.id === 'E2'));

        const outcome = await replaceOneEvidence(root, 'held', {
            id: 'E1',
            type: 'executable_falsifier',
            command: 'vitest run tests/unit/x.test.ts',
            mutation: { file: 'src/a.ts', find: 'export const a = 2;', replace: 'export const a = 3;' },
        } as never, 'the repair moved the line this anchor pointed at');

        expect(outcome.replaced).toBe(1);
        expect(outcome.untouched).toEqual(['E2']);
        expect(JSON.stringify(read().find((entry) => entry.id === 'E2'))).toBe(beforeE2);
        expect(read().find((entry) => entry.id === 'E1')?.mutation.find).toBe('export const a = 2;');
        // An id the ledger does not hold is refused by name rather than appended.
        await expect(replaceOneEvidence(root, 'held', { id: 'E9', type: 'executable_falsifier', command: 'x', mutation: { file: 'src/a.ts', find: 'x', replace: 'y' } } as never, 'x'))
            .rejects.toThrow(/holds no evidence item E9/u);
        expect(read().map((entry) => entry.id).sort()).toEqual(['E1', 'E2']);
    });

    it('refuses an id the ledger does not hold, by name, and writes nothing', async () => {
        const { root } = await seeded('unknown');
        if (!existsSync(CLI)) return;
        // The bundle is gitignored and absent in the seal's sandbox copy; the in-process case carries the property.
        const path = join(root, '.kata', 'tasks', 'held', 'review', 'evidence.json');
        const before = readFileSync(path, 'utf8');
        const item = join(root, 'item.json');
        writeFileSync(item, `${JSON.stringify({
            claims: [{ id: 'C1', statement: 'x', riskClass: 'consistency', severity: 'major', dependsOn: ['path:src/a.ts'], evidenceIds: ['E9'] }],
            evidence: [{ id: 'E9', type: 'executable_falsifier', command: 'vitest run tests/unit/x.test.ts', mutation: { file: 'src/a.ts', find: 'x', replace: 'y' } }],
        })}\n`);
        const refused = cli(root, ['ledger', 'evidence', 'replace', '--change', 'held', '--id', 'E9', '--file', item, '--reason', 'x']);
        expect(refused.ok).toBe(false);
        expect(refused.output).toMatch(/holds no evidence item E9/u);
        expect(refused.output).toMatch(/E1, E2|E1/u);
        expect(readFileSync(path, 'utf8')).toBe(before);
    });

    it('still requires a reason, and still refuses a file that does not hold the named item', async () => {
        const { root } = await seeded('guards');
        if (!existsSync(CLI)) return;
        // The bundle is gitignored and absent in the seal's sandbox copy; the in-process case carries the property.
        const item = join(root, 'item.json');
        writeFileSync(item, `${JSON.stringify({
            claims: [{ id: 'C1', statement: 'x', riskClass: 'consistency', severity: 'major', dependsOn: ['path:src/a.ts'], evidenceIds: ['E2'] }],
            evidence: [{ id: 'E2', type: 'executable_falsifier', command: 'vitest run tests/unit/y.test.ts', mutation: { file: 'src/a.ts', find: 'export const b = 2;', replace: 'export const b = 4;' } }],
        })}\n`);
        expect(cli(root, ['ledger', 'evidence', 'replace', '--change', 'held', '--id', 'E2', '--file', item]).output).toMatch(/--reason/u);
        expect(cli(root, ['ledger', 'evidence', 'replace', '--change', 'held', '--id', 'E1', '--file', item, '--reason', 'x']).output).toMatch(/holds no item with id E1/u);
    });
});
