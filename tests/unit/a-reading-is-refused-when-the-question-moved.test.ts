import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runLedgerCommand } from '../../src/cli/ledger.js';
import { readLedger } from '../../src/store/ledger.js';
import { writeTaskRecord } from '../helpers/task-fixture.js';

/**
 * **A reading taken against a question the decision does not ask is work that looks done and is not.**
 *
 * Measured on this repository: `claim add C1 → freeze → evidence add` (a submission that declares `C2`) leaves the subject
 * frozen against `C1` while the ledger declares `C1+C2`. `evidence verify` then stamped its verdicts with the frozen
 * revision, the discovery projection compared the declared one, and the reading was recorded, ignored, and impossible to
 * re-take into credit. This file pins the refusal at that door.
 */
const changeId = 'reading-refused';
let root = '';
let previousExitCode: number | string | null | undefined;
const chunks: string[] = [];

async function ledger(argv: string[]): Promise<Record<string, unknown>> {
    chunks.length = 0;
    process.exitCode = 0;
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
        chunks.push(String(chunk));
        return true;
    });
    try {
        await runLedgerCommand(argv, { root, changeId });
    } finally {
        spy.mockRestore();
    }
    const text = chunks.join('');
    const start = text.indexOf('{');
    return start < 0 ? {} : (JSON.parse(text.slice(start)) as Record<string, unknown>);
}

const falsifier = (id: string) => ({
    id,
    type: 'executable_falsifier',
    command: 'grep -q "holds = true" src/a.ts',
    mutation: { file: 'src/a.ts', find: 'holds = true', replace: 'holds = false' },
});

/** The state the defect needs: a freeze that hashed `C1`, then a submission that declares `C2` as well. */
async function movedQuestion(): Promise<{ frozen: string; declared: string }> {
    await ledger(['claim', 'add', '--id', 'C1', '--statement', 'the export holds', '--risk-class', 'consistency', '--severity', 'major', '--depends-on', 'path:src/a.ts']);
    await ledger(['freeze']);
    const frozen = (await readLedger(root, changeId)).subject?.revision ?? '';
    const file = join(root, 'submission.json');
    await writeFile(file, `${JSON.stringify({
        claims: [{
            id: 'C2',
            statement: 'the second question holds',
            riskClass: 'boundary',
            severity: 'major',
            dependsOn: ['path:src/a.ts'],
            evidenceIds: ['E1'],
            challengeIds: [],
            status: 'open',
            at: '',
            reopens: 0,
        }],
        evidence: [falsifier('E1')],
    }, null, 2)}\n`);
    await ledger(['evidence', 'add', '--file', file]);
    const after = await readLedger(root, changeId);
    return { frozen, declared: after.subjectAsDeclared?.revision ?? '' };
}

beforeEach(async () => {
    previousExitCode = process.exitCode;
    root = await mkdtemp(join(tmpdir(), 'kata-reading-refused-'));
    await mkdir(join(root, 'src'), { recursive: true });
    await mkdir(join(root, '.kata', 'tasks', changeId), { recursive: true });
    await writeFile(join(root, 'src', 'a.ts'), 'export const holds = true;\n');
    await writeTaskRecord(root, { id: changeId, phase: 'implement', ownedPaths: ['src/a.ts'] });
    await ledger(['policy', '--init']);
});

afterEach(async () => {
    process.exitCode = previousExitCode;
    await rm(root, { recursive: true, force: true });
    vi.restoreAllMocks();
});

describe('a reading is refused when the question moved', () => {
    it('refuses to verify, naming both revisions and the one remedy that clears the state', async () => {
        const { frozen, declared } = await movedQuestion();
        expect(frozen).not.toBe('');
        expect(declared).not.toBe(frozen);

        const result = await ledger(['evidence', 'verify']);

        expect(result.ok).toBe(false);
        expect(process.exitCode).toBe(1);
        const error = String(result.error);
        // Both revisions by name: an operator cannot act on "the question moved" without knowing which two.
        expect(error).toContain(frozen);
        expect(error).toContain(declared);
        // The remedy, named: this is the command that clears the state, and nothing else does.
        expect(error).toContain(`kata-cli ledger freeze --change ${changeId}`);
        // The machine-readable half, so a script does not have to parse prose.
        expect(result.questionMoved).toMatchObject({ frozen, declared });
    });

    it('names a remedy the command it names actually reads', async () => {
        // **A remedy that cannot be followed is the defect this change repairs, one layer up.** The first version of the
        // refusal said `--path <p>…`, while `ledger freeze` reads only `--paths` (comma-separated) — so an operator who
        // copied the remedy got a silent freeze of the task's declared paths and a flag that was ignored. An independent
        // round measured it, and the same wrong flag was in the operations table's example.
        await movedQuestion();

        const error = String((await ledger(['evidence', 'verify'])).error);

        expect(error).toContain(`kata-cli ledger freeze --change ${changeId}`);
        // Every flag it names must be one the verb reads: `--paths` is real, and `--path` — in any form, with any value —
        // is silently ignored by `ledger freeze`. The negative lookahead is the whole assertion: it fails for `--path `,
        // for `--path <p>`, and for any other spelling, while `--paths` passes.
        expect(error).not.toMatch(/--path(?![s])/);
    });

    it('documents a remedy the operator can follow, in prose as well as in the examples', async () => {
        // **The same defect one layer out.** The first repair fixed the refusal string, the flags table and the example
        // block — and left the paragraph between them saying `--path`, repeated. An independent round measured that
        // following that paragraph silently re-freezes the task's declared paths instead of the set the operator chose, so
        // the guard has to cover the prose the operator actually reads, not just the command strings.
        const operations = await readFile(join(process.cwd(), 'docs', 'operations.md'), 'utf8');
        const start = operations.indexOf('A subject, claims, evidence, a decision.');
        const end = operations.indexOf('**What the gate refuses**');
        expect(start).toBeGreaterThan(0);
        expect(end).toBeGreaterThan(start);
        const ledgerSection = operations.slice(start, end);

        // The section really is the one under test, so this cannot pass by slicing nothing.
        expect(ledgerSection).toContain('ledger freeze');
        expect(ledgerSection).toContain('--paths src/a.ts,docs/spec.md');
        expect(ledgerSection).not.toMatch(/--path(?![s])/);
    });

    it('records no verdict, so the refused reading cannot be mistaken for a taken one', async () => {
        await movedQuestion();

        await ledger(['evidence', 'verify']);

        const stored = await readLedger(root, changeId);
        expect(stored.verdicts).toEqual([]);
        expect(stored.readings).toEqual([]);
    });

    it('verifies normally once the subject is frozen against the question the ledger declares', async () => {
        // **The control, and the reason the refusal is not a wall.** Without it, a guard that refuses everything would
        // pass this file: the state has to be reachable *and* clearable through the same door.
        const { declared } = await movedQuestion();
        await ledger(['freeze']);

        const result = await ledger(['evidence', 'verify']);

        expect(result.ok).toBe(true);
        expect(process.exitCode).toBe(0);
        const verdicts = (result.verdicts ?? []) as Array<{ id: string; verdict: string }>;
        expect(verdicts).toHaveLength(1);
        expect(verdicts[0]?.verdict).toBe('supported');
        expect((await readLedger(root, changeId)).subject?.revision).toBe(declared);
    });
});
