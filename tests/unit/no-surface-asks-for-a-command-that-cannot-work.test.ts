import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runLedgerCommand } from '../../src/cli/ledger.js';
import { readLedger } from '../../src/store/ledger.js';
import { writeTaskRecord } from '../helpers/task-fixture.js';

/**
 * **No surface may ask for a command that cannot change the state it is asked in.**
 *
 * The report that opened this change is about exactly that: `ledger decide` reported `discovery_unverified` and its deficit
 * said "re-run the recorded challenge against the current revision", while re-running it could only stamp the same frozen
 * revision again. This file pins the other door of the same state — `challenge check` — and pins the chain: following the
 * deficit's own instruction now answers with the state and the remedy that clears it.
 */
const changeId = 'no-surface';
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

/** The drifted state, with a bound challenge recorded in it — the state the report's fixed point lives in. */
async function movedQuestionWithChallenge(): Promise<{ frozen: string; declared: string }> {
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
    await ledger(['challenge', 'add', '--id', 'X1', '--claim', 'C2', '--falsifier', 'E1']);
    const after = await readLedger(root, changeId);
    return { frozen, declared: after.subjectAsDeclared?.revision ?? '' };
}

beforeEach(async () => {
    previousExitCode = process.exitCode;
    root = await mkdtemp(join(tmpdir(), 'kata-no-surface-'));
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

describe('no surface asks for a command that cannot work', () => {
    it('refuses to check a bound challenge in the moved state, naming the same remedy as verify', async () => {
        const { frozen, declared } = await movedQuestionWithChallenge();

        const result = await ledger(['challenge', 'check', '--id', 'X1']);

        expect(result.ok).toBe(false);
        expect(process.exitCode).toBe(1);
        const error = String(result.error);
        expect(error).toContain(frozen);
        expect(error).toContain(declared);
        expect(error).toContain(`kata-cli ledger freeze --change ${changeId}`);
    });

    it('writes no resolution, so a refused check cannot be read as a checked challenge', async () => {
        await movedQuestionWithChallenge();

        await ledger(['challenge', 'check', '--id', 'X1']);

        const stored = await readLedger(root, changeId);
        expect(stored.challenges.find((challenge) => challenge.id === 'X1')?.resolution).toBeUndefined();
        expect(stored.verdicts).toEqual([]);
    });

    it('answers the deficit\'s own instruction with the state and the remedy, instead of re-stamping the frozen revision', async () => {
        // **The chain the report measured.** `decide` still names the discovery deficit; the command it names is the one
        // this file refuses, and that refusal now carries the step that actually clears the state. Before the refusal, the
        // same sequence re-stamped the frozen revision and the deficit survived every attempt.
        const { frozen, declared } = await movedQuestionWithChallenge();

        const decision = await ledger(['decide']);
        expect(decision.verdict).toBe('insufficient');
        expect((decision.reasons as Array<{ code: string }>).map((reason) => reason.code)).toContain('discovery_unverified');
        const need = String(((decision.deficits ?? []) as Array<{ claimId: string; need: string }>)
            .find((deficit) => deficit.claimId === 'discovery:verified_challenge')?.need ?? '');
        expect(need).toContain('challenge check');

        const followed = await ledger(['challenge', 'check', '--id', 'X1']);
        expect(followed.ok).toBe(false);
        expect(String(followed.error)).toContain(`kata-cli ledger freeze --change ${changeId}`);

        // And the state is genuinely stale, not a misreading: the frozen and declared questions are two revisions.
        expect(frozen).not.toBe(declared);
    });
});
