import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runLedgerCommand } from '../../src/cli/ledger.js';
import { readLedger } from '../../src/store/ledger.js';

/**
 * **The seven verbs, end to end, on a real workspace.**
 *
 * What this covers that the unit tests cannot: the verbs are the only interface a reviewer or an author actually uses, so
 * the flow is exercised the way it will be used — freeze, declare, evidence, verify, challenge, decide, focus — and the
 * refusals are checked by exit code, because a refusal that exits 0 is a refusal a script cannot see.
 */
let root: string;
const changeId = 'cli-fixture';
let previousExitCode: number | string | null | undefined;

beforeEach(async () => {
    previousExitCode = process.exitCode;
    process.exitCode = 0;
    root = await mkdtemp(join(tmpdir(), 'kata-ledger-cli-'));
    await mkdir(join(root, '.kata', 'tasks', changeId), { recursive: true });
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src', 'a.ts'), 'export const holds = true;\n');
    await writeFile(
        join(root, '.kata', 'tasks', changeId, 'task.json'),
        `${JSON.stringify({ id: changeId, ownedPaths: ['src/a.ts'] }, null, 2)}\n`,
    );
});

afterEach(async () => {
    process.exitCode = previousExitCode;
    await rm(root, { recursive: true, force: true });
    vi.restoreAllMocks();
});

async function ledger(argv: string[]): Promise<Record<string, unknown>> {
    const chunks: string[] = [];
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

/** A single occurrence per flag: a duplicate would keep the first value, which is how a fixture lies to its own test. */
const claimArgv = (overrides: { severity?: string; id?: string } = {}): string[] => [
    'claim',
    'add',
    '--statement',
    'the export is present',
    '--risk-class',
    'consistency',
    '--severity',
    overrides.severity ?? 'major',
    '--evidence',
    'E1',
    '--depends-on',
    'path:src/a.ts',
    '--id',
    overrides.id ?? 'C1',
];

async function submission(): Promise<string> {
    const path = join(root, 'submission.json');
    await writeFile(path, `${JSON.stringify({
        claims: [],
        evidence: [
            { id: 'E1', type: 'static_witness', ref: 'src/a.ts', assertion: 'contains:holds' },
        ],
    }, null, 2)}\n`);
    return path;
}

describe('the ledger verbs', () => {
    it('reports an untouched ledger as a state, not as an empty review', async () => {
        const result = await ledger(['status']);
        expect(result.recordedFiles).toEqual([]);
        expect(String(result.note)).toContain('nothing has been recorded');
    });

    it('reads its own --change flag, so a subcommand is not mistaken for an id', async () => {
        // The regression this pins: `ledger status --change x` read `status` as the change id, because the entry point's
        // positional guesser cannot tell a subcommand from an id.
        const result = await ledger(['status', '--change', 'other-change']);
        expect(result.changeId).toBe('other-change');
        expect(String(result.dir)).toContain('other-change');
    });

    it('freezes the subject from the declared paths and refuses an unreadable one', async () => {
        const frozen = await ledger(['freeze']);
        expect(String(frozen.revision)).toMatch(/^rev:[0-9a-f]{16}$/);
        expect(frozen.paths).toBe(1);

        const refused = await ledger(['freeze', '--paths', 'src/a.ts,src/gone.ts']);
        expect(refused.ok).toBe(false);
        expect(String(refused.error)).toContain('src/gone.ts');
        expect(process.exitCode).toBe(1);
    });

    it('carries a change from freeze to a pass, and reports what refused it along the way', async () => {
        await ledger(['policy', '--init']);
        await ledger(['freeze']);
        await ledger(claimArgv());

        // Before any evidence is verified the claim is unsupported, and the deficit says what is missing.
        const pending = await ledger(['decide']);
        expect(pending.verdict).toBe('insufficient');
        expect(process.exitCode).toBe(1);

        await ledger(['evidence', 'add', '--file', await submission(), '--producer', 'reviewer-a']);
        const verified = await ledger(['evidence', 'verify']);
        expect(verified.verdicts).toHaveLength(1);
        expect((verified.verdicts as Array<{ verdict: string }>)[0]?.verdict).toBe('supported');

        const decision = await ledger(['decide']);
        expect(decision.verdict).toBe('pass');
        // The refusal above set the exit code; a pass leaves it as it is, because a passing command must not clear an
        // earlier failure in the same process.
        expect(process.exitCode).toBe(1);
    });

    it('blocks on an open counterexample and unblocks when the counterexample no longer reproduces', async () => {
        await ledger(['policy', '--init']);
        await ledger(['freeze']);
        await ledger(claimArgv());
        await ledger(['evidence', 'add', '--file', await submission()]);
        await ledger(['evidence', 'verify']);
        expect((await ledger(['decide'])).verdict).toBe('pass');

        // A counterexample against a path the claim does not rest on, so resolving it does not also move the claim's
        // dependency digests and turn the verdict stale — that is a different rule, tested in its own case.
        await mkdir(join(root, 'notes'), { recursive: true });
        await writeFile(join(root, 'notes', 'fix.txt'), 'not yet\n');
        await ledger(['challenge', 'add', '--claim', 'C1', '--command', 'grep -q marker notes/fix.txt', '--id', 'X1']);
        const blocked = await ledger(['decide']);
        expect(blocked.verdict).toBe('insufficient');
        expect((blocked.reasons as Array<{ code: string }>).map((reason) => reason.code)).toContain('challenge_open');

        // The counterexample still reproduces, so checking it leaves it open and the decision stays blocked.
        const stillOpen = await ledger(['challenge', 'check']);
        expect((stillOpen.outcomes as Array<{ state: string }>).map((entry) => entry.state)).toEqual(['open']);
        expect((await ledger(['decide'])).verdict).toBe('insufficient');

        // The author marks the fix, the counterexample no longer reproduces, and checking it withdraws the challenge.
        await writeFile(join(root, 'notes', 'fix.txt'), 'marker\n');
        const withdrawn = await ledger(['challenge', 'check']);
        expect((withdrawn.outcomes as Array<{ state: string }>).map((entry) => entry.state)).toEqual(['withdrawn']);
        const afterCheck = await ledger(['decide']);
        expect((afterCheck.reasons as Array<{ code: string }>).map((reason) => reason.code)).not.toContain('challenge_open');
        expect(afterCheck.verdict).toBe('pass');
    });

    it('refuses a blocking claim whose evidence is too weak, naming the strength it needs', async () => {
        await ledger(['policy', '--init']);
        await ledger(['freeze']);
        await ledger(claimArgv({ severity: 'blocking' }));
        await ledger(['evidence', 'add', '--file', await submission()]);
        await ledger(['evidence', 'verify']);
        const decision = await ledger(['decide']);
        expect(decision.verdict).toBe('insufficient');
        const reason = (decision.reasons as Array<{ code: string; detail: string }>).find((entry) => entry.code === 'evidence_below_strength');
        expect(reason?.detail).toContain('strength 4');
    });

    it('refuses a waiver with no reason, because the gate would refuse it anyway', async () => {
        await ledger(['freeze']);
        await ledger(claimArgv());
        const refused = await ledger(['claim', 'waive', 'C1']);
        expect(refused.ok).toBe(false);
        expect(String(refused.error)).toContain('--reason');
        expect(process.exitCode).toBe(1);

        await ledger(['claim', 'waive', 'C1', '--reason', 'out of scope for this change']);
        const ledgerState = await readLedger(root, changeId);
        expect(ledgerState.claims[0]?.status).toBe('waived');
    });

    it('turns a risk-floor change into a privilege claim rather than a quiet widening', async () => {
        await ledger(['policy', '--init']);
        await ledger(['freeze']);
        const stored = JSON.parse(await readFile(join(root, '.kata', 'tasks', changeId, 'review', 'policy.json'), 'utf8')) as {
            riskFloors: Record<string, string>;
        };
        const wanted = join(root, 'policy-widened.json');
        await writeFile(wanted, `${JSON.stringify({ ...stored, riskFloors: { ...stored.riskFloors, 'src/**': 'low' } }, null, 2)}\n`);

        const applied = await ledger(['policy', '--set-file', wanted]);
        expect(applied.floorClaims).toEqual(['policy-floor:src/**']);
        const claims = (await readLedger(root, changeId)).claims;
        const floorClaim = claims.find((claim) => claim.id === 'policy-floor:src/**');
        expect(floorClaim?.riskClass).toBe('privilege');
        expect(floorClaim?.statement).toContain('added');
        // The claim is open and unsupported, so the widening is not a free pass: it has to be reviewed like anything else.
        expect((await ledger(['decide'])).verdict).toBe('insufficient');
    });

    it('reports which claims a change forces back open, and how many verdicts survive', async () => {
        await ledger(['policy', '--init']);
        await ledger(['freeze']);
        await ledger(claimArgv());
        await ledger(['evidence', 'add', '--file', await submission()]);
        await ledger(['evidence', 'verify']);

        const untouched = await ledger(['focus']);
        expect(untouched.changed).toEqual([]);
        expect(untouched.revalidateClaims).toEqual([]);
        expect(untouched.verdictsCarriedOver).toBe(1);

        await writeFile(join(root, 'src', 'a.ts'), 'export const holds = false;\n');
        const moved = await ledger(['focus']);
        expect(moved.changed).toEqual(['src/a.ts']);
        expect(moved.revalidateClaims).toEqual(['C1']);
        expect(moved.verdictsCarriedOver).toBe(0);
    });

    it('plans from the risk of the touched paths and derives a deadline from a recorded baseline', async () => {
        await ledger(['policy', '--init']);
        await ledger(['freeze']);
        await ledger(claimArgv());
        const planned = await ledger(['plan', '--c0', '600000']);
        const plan = planned.plan as { tier: string; discovery: { deadlineToolCalls: number | null }; readingSets: Array<{ paths: string[] }> };
        expect(plan.tier).toBe('standard');
        expect(plan.discovery.deadlineToolCalls).toBe(200);
        expect(plan.readingSets[0]?.paths).toEqual(['src/a.ts']);
    });
});
