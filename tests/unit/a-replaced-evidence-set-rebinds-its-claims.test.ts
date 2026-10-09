import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runLedgerCommand } from '../../src/cli/ledger.js';
import { readLedger, verdictsPath } from '../../src/store/ledger.js';

/**
 * **AC-12 — a command that changes the claims' evidence bindings changes them, and one that cannot does not pretend
 * otherwise.**
 *
 * Measured on a real change: `ledger evidence replace` swapped the whole evidence set and left every claim citing the ids
 * it had before, so a claim ended up pointing at an item that no longer existed — and nothing reported it. The same
 * command's sibling was worse in the quieter direction: `ledger evidence add` with an id that already existed wrote
 * nothing and said `ok: true, written: false`, so an author re-aiming a falsifier got a success and kept the old mutation
 * site and the old verdict.
 *
 * Both are "apply or say so". `replace` refuses by name when the new set would orphan a citation, because the ledger
 * cannot invent the author's intended rebinding; `add` names the items it did not write, and names the command that
 * rewrites the set, so the no-op is never mistaken for a change.
 */
const changeId = 'evidence-rebinding';
const roots: string[] = [];

async function tempRoot(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'kata-evidence-rebind-'));
    roots.push(root);
    await mkdir(join(root, '.kata', 'tasks', changeId), { recursive: true });
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src', 'a.ts'), 'export const holds = true;\n');
    await writeFile(join(root, '.kata', 'tasks', changeId, 'task.json'), `${JSON.stringify({ id: changeId, ownedPaths: ['src/a.ts'] }, null, 2)}\n`);
    return root;
}

async function ledger(root: string, argv: string[]): Promise<Record<string, unknown>> {
    const chunks: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
        chunks.push(String(chunk));
        return true;
    });
    const previous = process.exitCode;
    process.exitCode = 0;
    try {
        await runLedgerCommand(argv, { root, changeId });
    } finally {
        spy.mockRestore();
        process.exitCode = previous;
    }
    const text = chunks.join('');
    const start = text.indexOf('{');
    return start < 0 ? {} : JSON.parse(text.slice(start)) as Record<string, unknown>;
}

/** A submission file, which is how claims and evidence reach the ledger. */
async function submit(root: string, name: string, body: unknown): Promise<string> {
    // Absolute, because the verb resolves `--file` against the process's working directory and this case's workspace is a
    // temporary root rather than the repository.
    const path = join(root, name);
    await writeFile(path, `${JSON.stringify(body)}\n`);
    return path;
}

const falsifier = (id: string, command: string) => ({
    id,
    type: 'executable_falsifier',
    command,
    mutation: { file: 'src/a.ts', find: 'holds = true', replace: 'holds = false' },
});

const claim = (id: string, evidenceIds: string[]) => ({
    id,
    statement: `${id} holds`,
    riskClass: 'consistency',
    severity: 'major',
    dependsOn: ['path:src/a.ts'],
    evidenceIds,
    challengeIds: [],
    status: 'open',
    at: '2026-10-09T00:00:00.000Z',
    reopens: 0,
});

afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function seed(root: string): Promise<void> {
    const file = await submit(root, 'seed.json', { claims: [claim('C-1', ['E1'])], evidence: [falsifier('E1', 'grep -q "holds = true" src/a.ts')] });
    expect((await ledger(root, ['evidence', 'add', '--file', file])).ok).toBe(true);
}

describe('replacing the evidence set', () => {
    it('refuses by name when the new set orphans a claim citation, and writes nothing', async () => {
        const root = await tempRoot();
        await seed(root);
        const before = JSON.stringify(await readLedger(root, changeId));
        const file = await submit(root, 'swap.json', { claims: [], evidence: [falsifier('E-REAIMED', 'grep -q other src/a.ts')] });

        const result = await ledger(root, ['evidence', 'replace', '--file', file, '--reason', 're-aimed the falsifier']);

        expect(result.ok).toBe(false);
        // The refusal names the claim, the id that would disappear, and the command that rebinds it.
        expect(String(result.error)).toContain('C-1');
        expect(String(result.error)).toContain('E1');
        expect(String(result.error)).toContain('ledger claim restate');
        // Nothing was written: the evidence set, the claims and the verdicts are what they were.
        expect(JSON.stringify(await readLedger(root, changeId))).toBe(before);
    });

    it('applies when every citation still resolves, and names the claims whose reading it dropped', async () => {
        const root = await tempRoot();
        await seed(root);
        await ledger(root, ['evidence', 'verify']);
        // Same ids, different content: the set is rewritten and this claim's citation now points at a different item.
        const file = await submit(root, 'reaim.json', { claims: [], evidence: [falsifier('E1', 'grep -q "holds = true" src/a.ts # re-aimed')] });

        const result = await ledger(root, ['evidence', 'replace', '--file', file, '--reason', 'the falsifier was aimed at the wrong line']);

        expect(result.ok, JSON.stringify(result)).toBe(true);
        // **Two different facts, kept apart.** `droppedVerdicts` names the readings that existed and were dropped; nothing has
        // been verified in this fixture, so it is empty — and that is not the same as "the citation is unaffected", which is
        // what the next field says.
        expect(result.droppedVerdicts).toEqual([]);
        expect(result.citationsWhoseReadingWasDropped).toEqual([{ claimId: 'C-1', evidenceId: 'E1' }]);
        const after = await readLedger(root, changeId);
        expect(after.evidence.map((item) => item.id)).toEqual(['E1']);
        expect(after.claims.find((entry) => entry.id === 'C-1')?.evidenceIds).toEqual(['E1']);
    });

    it('lets a claim be rebound in the same act, so the refusal above has a working door', async () => {
        const root = await tempRoot();
        await seed(root);
        // The submission carries the claim as well as the evidence: the author states the new binding rather than asking the
        // ledger to guess it (this is how the repository itself re-aimed a falsifier).
        const file = await submit(root, 'rebind.json', {
            claims: [claim('C-1', ['E-REAIMED'])],
            evidence: [falsifier('E-REAIMED', 'grep -q other src/a.ts')],
        });

        const result = await ledger(root, ['evidence', 'replace', '--file', file, '--reason', 'the falsifier was re-aimed and rebound']);

        expect(result.ok, JSON.stringify(result)).toBe(true);
        const after = await readLedger(root, changeId);
        expect(after.evidence.map((item) => item.id)).toEqual(['E-REAIMED']);
        expect(after.claims.find((entry) => entry.id === 'C-1')?.evidenceIds).toEqual(['E-REAIMED']);
    });

    it('names the store the report is about, rather than reporting a count alone', async () => {
        const root = await tempRoot();
        await seed(root);
        const file = await submit(root, 'reaim.json', { claims: [], evidence: [falsifier('E1', 'grep -q "holds = true" src/a.ts # re-aimed')] });

        const result = await ledger(root, ['evidence', 'replace', '--file', file, '--reason', 're-aimed']);

        // A dropped reading is a fact about a file, and the report names it: an operator auditing a claim needs to know which
        // store changed, not only that a number went down.
        expect(result.verdictsFile).toBe(join('review', 'verdicts.json'));
        expect(result.citationsWhoseReadingWasDropped).toEqual([{ claimId: 'C-1', evidenceId: 'E1' }]);
        // No reading had been recorded for this item, so the verdict store is untouched rather than emptied — the report
        // distinguishes "a reading was dropped" (the citation field) from "the store changed" (`droppedVerdicts`), and here
        // only the first is true.
        expect(await readFile(verdictsPath(root, changeId), 'utf8').catch(() => null)).toBeNull();
    });
});

describe('adding evidence that is already recorded', () => {
    it('names the id it did not write, so a re-aim is never silent', async () => {
        const root = await tempRoot();
        await seed(root);
        const again = await submit(root, 'again.json', { claims: [], evidence: [falsifier('E1', 'grep -q "holds = true" src/a.ts')] });

        const result = await ledger(root, ['evidence', 'add', '--file', again]);

        // Identical content is a no-op, and the no-op says so — the previous answer was `ok: true` with `written: false`
        // inside each item and nothing at the top level, so a script that read `ok` learned nothing.
        expect(result.ok).toBe(true);
        expect(result.unchanged).toEqual(['E1']);
        expect(String(result.unchangedNote)).toContain('ledger evidence replace');
    });

    it('refuses different content under an existing id, naming the reason and the command that rewrites it', async () => {
        const root = await tempRoot();
        await seed(root);
        const changed = await submit(root, 'changed.json', { claims: [], evidence: [falsifier('E1', 'grep -q "holds = true" src/a.ts # re-aimed')] });

        const result = await ledger(root, ['evidence', 'add', '--file', changed]);

        expect(result.ok).toBe(false);
        expect(String(result.error)).toContain('write-once');
        expect(String(result.error)).toContain('ledger evidence replace');
    });
});
