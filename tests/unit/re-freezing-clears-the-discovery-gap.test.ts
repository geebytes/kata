import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runLedgerCommand } from '../../src/cli/ledger.js';
import { readLedger } from '../../src/store/ledger.js';
import { writeTaskRecord } from '../helpers/task-fixture.js';

/**
 * **The remedy has to clear the state it names.** A refusal that points at a step which does not work is the defect this
 * change repairs, so the last thing to prove is the positive: `ledger freeze` — the command both refusals name — really does
 * put the ledger back into a state where a reading counts, and the discovery projection then credits the challenge.
 */
const changeId = 'remedy-clears';
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

beforeEach(async () => {
    previousExitCode = process.exitCode;
    root = await mkdtemp(join(tmpdir(), 'kata-remedy-clears-'));
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

describe('re-freezing clears the discovery gap', () => {
    it('credits the challenge after the named remedy runs, where the same sequence never could before', async () => {
        // **The plan is part of the question, so the fixture records one.** Without it both sides of the comparison see
        // `undefined` and the plan half of the identity is not exercised at all — measured: a mutation that dropped the
        // plan from the freeze left this case green until the fixture started planning.
        await ledger(['plan']);
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
            evidence: [{
                id: 'E1',
                type: 'executable_falsifier',
                command: 'grep -q "holds = true" src/a.ts',
                mutation: { file: 'src/a.ts', find: 'holds = true', replace: 'holds = false' },
            }],
        }, null, 2)}\n`);
        await ledger(['evidence', 'add', '--file', file]);
        const moved = (await readLedger(root, changeId)).subjectAsDeclared?.revision ?? '';
        expect(moved).not.toBe(frozen);
        await ledger(['challenge', 'add', '--id', 'X1', '--claim', 'C2', '--falsifier', 'E1']);

        // **Before the remedy: nothing can be taken.** Both doors refuse, and the challenge stays uncredited.
        expect((await ledger(['evidence', 'verify'])).ok).toBe(false);
        expect((await ledger(['challenge', 'check', '--id', 'X1'])).ok).toBe(false);

        // **The remedy both refusals named.**
        const reFrozen = await ledger(['freeze']);
        expect(reFrozen.ok).toBe(true);

        // **After it: the same commands work, and the decision credits the challenge.**
        expect((await ledger(['evidence', 'verify'])).ok).toBe(true);
        const checked = await ledger(['challenge', 'check', '--id', 'X1']);
        expect(checked.ok).toBe(true);
        expect((checked.outcomes as Array<{ state: string }>)[0]?.state).toBe('withdrawn');

        const stored = await readLedger(root, changeId);
        const declared = stored.subjectAsDeclared?.revision ?? '';
        expect(stored.subject?.revision).toBe(declared);
        expect(stored.challenges.find((challenge) => challenge.id === 'X1')?.resolution?.subjectRevision).toBe(declared);
        // **The remedy must not "clear" the state by forgetting the question.** A re-freeze that dropped the question
        // would make the frozen subject the declared one by *weakening identity*, and everything above would still hold —
        // measured: mutating `questionForComparison` to always return `{}` left this case green until this assertion was
        // added. The frozen subject has to keep hashing the question, and hash the one declared now.
        expect(typeof stored.subject?.claimsDigest).toBe('string');
        expect(stored.subject?.claimsDigest).toBe(stored.subjectAsDeclared?.claimsDigest);

        const decision = await ledger(['decide']);
        expect((decision.reasons as Array<{ code: string }>).map((reason) => reason.code)).not.toContain('discovery_unverified');
    });
});
