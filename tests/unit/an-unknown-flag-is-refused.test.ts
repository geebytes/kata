import { readFile } from 'node:fs/promises';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runLedgerCommand, ledgerFamilyFlags, unknownLedgerFlag, entryPointFlags } from '../../src/cli/ledger.js';
import { readLedger } from '../../src/store/ledger.js';

/**
 * **AC-8 — a mistyped flag must not read as an instruction that was followed.**
 *
 * The ledger parser reads the flags it knows and ignores every other token, so `kata-cli ledger freeze --path src,a.ts`
 * (singular) froze the *task's* declared paths instead: the flag fell out of the parser, the fallback ran, and the output
 * said a path set had been frozen. Nothing in the answer distinguished "frozen what you named" from "frozen something
 * else", and every identity derived from the subject was then about different content than the operator believed.
 *
 * The refusal is deliberately placed before the verb reads anything, so a command with a mistyped flag writes nothing —
 * and it is deliberately family-scoped rather than per-verb: a per-verb interface table would be a second parser that
 * drifts from the first. The last case here is the guard on that choice.
 */
const roots: string[] = [];
const changeId = 'unknown-flag-change';

beforeEach(async () => {
    roots.length = 0;
});

afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tempRoot(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'kata-unknown-flag-'));
    roots.push(root);
    await mkdir(join(root, '.kata', 'tasks', changeId), { recursive: true });
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src', 'a.ts'), 'export const holds = true;\n');
    await writeFile(join(root, '.kata', 'tasks', changeId, 'task.json'), `${JSON.stringify({
        id: changeId, title: 'Unknown flag', phase: 'intake',
        acceptance: [{ id: 'AC-1', statement: 'It holds.' }],
        ownedPaths: ['src/a.ts'],
        createdAt: '2026-10-09T00:00:00.000Z', updatedAt: '2026-10-09T00:00:00.000Z',
    }, null, 2)}\n`);
    return root;
}

async function ledger(root: string, argv: string[]): Promise<{ payload: Record<string, unknown>; exitCode: number | string | null | undefined }> {
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
    const text = chunks.join('');
    const start = text.indexOf('{');
    return { payload: start < 0 ? {} : (JSON.parse(text.slice(start)) as Record<string, unknown>), exitCode };
}

describe('an unknown flag is refused by the ledger family', () => {
    it('refuses the singular spelling that used to be discarded, and freezes nothing', async () => {
        const root = await tempRoot();

        const { payload, exitCode } = await ledger(root, ['freeze', '--path', 'src/a.ts']);

        expect(payload.ok).toBe(false);
        expect(String(payload.error)).toContain('--path');
        expect(String(payload.error)).toContain('Nothing was written');
        expect(exitCode).toBe(1);
        // The decisive assertion: the command did not run with the fallback the parser would have used.
        const after = await readLedger(root, changeId);
        expect(after.subject).toBeNull();

        // And the correct spelling still does what it says.
        const frozen = await ledger(root, ['freeze', '--paths', 'src/a.ts']);
        expect(frozen.payload.ok).toBe(true);
        expect((await readLedger(root, changeId)).subject).not.toBeNull();
    });

    it('refuses an unknown flag on a read-only verb too, because a typo is an instruction that did not happen', async () => {
        const root = await tempRoot();

        const { payload } = await ledger(root, ['status', '--costs']);

        expect(payload.ok).toBe(false);
        expect(String(payload.error)).toContain('--costs');
    });

    it('leaves the entry point flags and the `=` spelling alone', async () => {
        const root = await tempRoot();

        expect(unknownLedgerFlag(['status', '--change', changeId])).toBeNull();
        expect(unknownLedgerFlag(['status', '--change=' + changeId])).toBeNull();
        expect(unknownLedgerFlag(['freeze', '--paths=src/a.ts'])).toBeNull();
        expect(unknownLedgerFlag(['--root', '/tmp/x', 'status'])).toBeNull();
        // A flag this family reads nowhere, however it is spelled.
        expect(unknownLedgerFlag(['freeze', '--path', 'src/a.ts'])).toBe('--path');
        expect(unknownLedgerFlag(['freeze', '--paths=src/a.ts', '--nope'])).toBe('--nope');
        // Non-flag tokens are positional subverbs, not flags.
        expect(unknownLedgerFlag(['evidence', 'add', '--file', 'x.json'])).toBeNull();
    });

    it('keeps the list complete, so a flag added to the parser cannot be left out of the refusal', async () => {
        // **The guard on the design choice.** The refusal is family-scoped because a per-verb table would drift; what makes
        // that safe is this case: every `--flag` literal the file reads must be in the family list, so a new one that is not
        // registered is a red guard rather than a flag that can be mistyped in silence.
        const source = await readFile(join('src', 'cli', 'ledger.ts'), 'utf8');
        const read = [...new Set([...source.matchAll(/'--([a-z0-9-]+)'/g)].map((match) => match[1] as string))];
        const registered = new Set([...ledgerFamilyFlags, ...entryPointFlags]);
        expect(read.filter((flag) => !registered.has(flag))).toEqual([]);
    });
});
