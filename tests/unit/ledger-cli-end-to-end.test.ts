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


/**
 * The strict contract every ledger is held to, because the policy ceilings the route at `strict`.
 *
 * Stated once here rather than repeated per case: one claim per required risk class, evidence for each, and the discovery
 * floor's one independent challenge on record. A fixture that skipped it would be testing a weaker route than the one
 * shipped — and would fail for a reason unrelated to its subject.
 */
async function satisfyStrictTier(): Promise<void> {
    const classes = ['boundary', 'failure_mode'] as const;
    for (const [index, riskClass] of classes.entries()) {
        const evidenceId = `E${index + 2}`;
        const claimId = `C${index + 2}`;
        await ledger(['claim', 'add', '--statement', `the ${riskClass} case holds`, '--risk-class', riskClass,
            '--severity', 'major', '--evidence', evidenceId, '--depends-on', 'path:src/a.ts', '--id', claimId]);
        const path = join(root, `${claimId}.json`);
        await writeFile(path, `${JSON.stringify({ claims: [], evidence: [
            { id: evidenceId, type: 'static_witness', ref: 'src/a.ts', assertion: 'contains:holds' },
        ] }, null, 2)}\n`);
        await ledger(['evidence', 'add', '--file', path]);
    }
    await ledger(['evidence', 'verify']);
    // **A challenge that reproduced is the discovery the floor asks for.** It is raised against a file outside the
    // frozen subject, measured, and found to fail (`grep` finds no marker) — that failure is the reproduction the floor
    // counts. The author then writes the marker, the same command passes, and the challenge is withdrawn.
    //
    // The previous fixture used `exit 0` and relied on the count alone, which is exactly the hole the floor's
    // `verifiedChallenges` half closes: a command that never failed on anything is not a challenge, whatever state it
    // ends in. The file lives outside the subject so applying the fix does not move the revision and stale the verdicts.
    await mkdir(join(root, 'notes'), { recursive: true });
    await writeFile(join(root, 'notes', 'discovery.txt'), 'Nothing here yet\n');
    await ledger(['challenge', 'add', '--claim', 'C1', '--command', 'grep -q marked notes/discovery.txt', '--id', 'X1']);
    await ledger(['challenge', 'check']);
    await writeFile(join(root, 'notes', 'discovery.txt'), 'marked\n');
    await ledger(['challenge', 'check']);
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

    it('never decides below the declared ceiling, so a change under no high-floor pattern is still strict', async () => {
        // The ceiling exists because a floor is only as good as its patterns: a change to what evidence is accepted can sit
        // under a path no rule names (`src/**` has no `high` rule). The classification would say `standard` here — and the
        // route refuses to certify on auto-evidence alone, which is a decision rather than a derivation.
        await ledger(['policy', '--init']);
        await ledger(['freeze']);
        await ledger(claimArgv());
        expect((await ledger(['decide'])).tier).toBe('strict');

        // And an operator who names a tier still wins: the bound is on the automatic path, not on a person.
        expect((await ledger(['decide', '--tier', 'standard'])).tier).toBe('standard');
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

        // One claim is not a review at the strict tier, which is where the ceiling puts every ledger: the tier's whole risk
        // space has to be claimed, and the discovery floor asks for an independent challenge.
        const oneClaim = await ledger(['decide']);
        expect(oneClaim.verdict).toBe('insufficient');
        expect((oneClaim.reasons as Array<{ code: string }>).map((reason) => reason.code))
            .toEqual(expect.arrayContaining(['uncovered_risk_class', 'discovery_floor']));
        await satisfyStrictTier();

        const decision = await ledger(['decide']);
        expect(decision.tier).toBe('strict');
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
        await satisfyStrictTier();
        expect((await ledger(['decide'])).verdict).toBe('pass');

        // A counterexample against a path the claim does not rest on, so resolving it does not also move the claim's
        // dependency digests and turn the verdict stale — that is a different rule, tested in its own case.
        await mkdir(join(root, 'notes'), { recursive: true });
        await writeFile(join(root, 'notes', 'fix.txt'), 'not yet\n');
        await ledger(['challenge', 'add', '--claim', 'C1', '--command', 'grep -q marker notes/fix.txt', '--id', 'X2']);
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
            riskFloors: Record<string, { floor: string; riskClasses: string[] }>;
        };
        const wanted = join(root, 'policy-widened.json');
        // The entry carries the classes too, so a widened floor and a re-described pattern are the same kind of change.
        await writeFile(
            wanted,
            `${JSON.stringify({ ...stored, riskFloors: { ...stored.riskFloors, 'src/**': { floor: 'low', riskClasses: ['consistency'] } } }, null, 2)}\n`,
        );

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
        // The older half of the same command: `revalidateClaims` is the kernel's own delta answer, and it is checked here
        // because `focus` reports what the decision already computed rather than an impact cone of its own.
        await ledger(['policy', '--init']);
        await ledger(['freeze']);
        await ledger(claimArgv());
        await ledger(['evidence', 'add', '--file', await submission()]);
        await ledger(['evidence', 'verify']);

        // No previous revision has ever been recorded, so every claim is revalidated — the conservative direction the
        // delta rule takes when it cannot name the content it is comparing against.
        expect((await ledger(['decide'])).revalidateClaims).toEqual(['C1']);

        // And the same command's older half is still the kernel's answer about reuse rather than an impact cone of its own.
        const carried = await ledger(['decide']);
        expect(carried.reusedEvidence).toEqual([]);
    });

    it('amends a counterexample whose command measured the wrong thing, and refuses a duplicate id', async () => {
        await ledger(['policy', '--init']);
        await ledger(['freeze']);
        await ledger(claimArgv());
        await ledger(['evidence', 'add', '--file', await submission()]);
        await ledger(['evidence', 'verify']);
        await satisfyStrictTier();

        // A command that measures a file nobody wrote: it fails, so the challenge stays open, and the ledger blocks.
        await ledger(['challenge', 'add', '--claim', 'C1', '--command', 'grep -q marker notes/absent.txt', '--id', 'X3']);
        await ledger(['challenge', 'check']);
        expect((await ledger(['decide'])).verdict).toBe('insufficient');

        // The measurement was wrong, so it is amended rather than hand-edited: the state resets, the old command is kept,
        // and the duplicate add is refused by name instead of reporting a success it did not perform.
        const amended = await ledger(['challenge', 'amend', '--id', 'X3', '--command', 'exit 0', '--reason', 'the first command measured a file that does not exist']);
        expect((amended.challenge as { state: string }).state).toBe('open');
        expect(String(amended.replaced)).toContain('notes/absent.txt');
        const duplicate = await ledger(['challenge', 'add', '--claim', 'C1', '--command', 'exit 1', '--id', 'X3']);
        expect(duplicate.ok).toBe(false);
        expect(String(duplicate.error)).toContain('already exists');

        const checked = await ledger(['challenge', 'check']);
        expect((checked.outcomes as Array<{ state: string }>)[0]?.state).toBe('withdrawn');
        expect((await ledger(['decide'])).verdict).toBe('pass');
    });

    it('records a measured budget, and a spent one cannot be decided as a pass', async () => {
        await ledger(['policy', '--init']);
        await ledger(['freeze']);
        await ledger(claimArgv());
        await ledger(['evidence', 'add', '--file', await submission()]);
        await ledger(['evidence', 'verify']);
        await satisfyStrictTier();
        expect((await ledger(['decide'])).verdict).toBe('pass');

        // The measured numbers enter here: without a writer the budget rule would be a mechanism nothing feeds.
        await ledger(['usage', 'set', '--tokens', '900000', '--tool-calls', '12']);
        const spent = await ledger(['decide', '--c0', '1000000']);
        expect(spent.verdict).toBe('insufficient');
        expect((spent.reasons as Array<{ code: string }>).map((reason) => reason.code)).toContain('budget_exhausted');

        // With no baseline the same usage cannot be judged, and it must not read as a satisfied limit either.
        const unknown = await ledger(['decide']);
        expect(unknown.verdict).toBe('pass');
    });

    it('measures what the round-shaped loop never did: author-side latency, reopenings and discovery rates', async () => {
        // Before anything is verified the rates are not computable, and the honest answer is null rather than 0: a zero
        // would read as "the evidence caught nothing", which is a claim nobody has the data to make.
        await ledger(['policy', '--init']);
        await ledger(['freeze']);
        await ledger(claimArgv());
        const empty = (await ledger(['status', '--cost'])).report as {
            claims: { total: number; automaticReopens: number; attributableReopens: number; namingUnrecordedEvidence: number; bySupport: Record<string, number> | null; derived: Array<{ state: string }> };
            evidence: { unverified: number };
            discovery: { refutationRate: number | null; baseline: string };
            authorSide: { medianClaimToSupportedMs: number | null };
        };
        expect(empty.claims.total).toBe(1);
        expect(empty.evidence.unverified).toBe(0);
        // The claim names E1 and no evidence item carries that id, which is the same gap the kernel reports as
        // `claim_unsupported` — the report and the decision name the same thing.
        expect(empty.claims.namingUnrecordedEvidence).toBe(1);
        // Nothing has moved and nobody has re-opened anything, so both counters are a measured zero rather than absent.
        expect(empty.claims.attributableReopens).toBe(0);
        expect(empty.claims.automaticReopens).toBe(0);
        // The declared status is `open` while the measured one is derived from the evidence: the report says both, and the
        // second comes from the same predicate the gate uses, so the two halves of a report cannot answer different
        // questions.
        expect(empty.claims.bySupport?.unsupported).toBe(1);
        expect(empty.claims.derived[0]?.state).toBe('unsupported');

        // The item exists and has no verdict: a different gap, with its own state.
        await ledger(['evidence', 'add', '--file', await submission()]);
        const recordedUnverified = (await ledger(['status', '--cost'])).report as { claims: { bySupport: Record<string, number> | null } };
        expect(recordedUnverified.claims.bySupport?.missing).toBe(1);
        expect(empty.discovery.refutationRate).toBeNull();
        // **The baseline is read, not asserted.** It was the literal `'none recorded yet'`, written by no code path, so
        // it stayed that string however much data accumulated. It now comes from `buildBaseline`: zero changes is a
        // measured zero with a null mean, which is the honest shape of "no data yet" — a denominator nobody can compute is
        // not zero, and a constant that never changes is not a measurement.
        expect(empty.discovery.baseline).toEqual({ changes: 0, meanReportedTokens: null });
        expect(empty.authorSide.medianClaimToSupportedMs).toBeNull();

        await ledger(['evidence', 'add', '--file', await submission()]);
        await ledger(['evidence', 'verify']);
        await ledger(['claim', 'reopen', 'C1']);
        const measured = (await ledger(['status', '--cost'])).report as {
            claims: { total: number; automaticReopens: number; attributableReopens: number; reReviewClaims: number; byStatus: Record<string, number>; namingUnrecordedEvidence: number; bySupport: Record<string, number> | null };
            evidence: { unverified: number; byType: Record<string, number> };
            discovery: { refutationRate: number | null };
            authorSide: { medianClaimToSupportedMs: number | null; firstClaimAt: string | null };
        };
        // **Two facts, two names.** `attributableReopens` is what `ledger claim reopen` stamps — a person's decision,
        // recorded so it survives. `automaticReopens` is what the delta computes at each decision (claims whose
        // dependencies moved, `ClaimState.stale`) and never persists. They used to share one field called `reopenings`,
        // and the acceptance item about re-review read the operator's counter while the mechanism's own reopen went
        // uncounted; `reReviewClaims` is their sum, for a reader who wants the one number.
        expect(measured.claims.attributableReopens).toBe(1);
        expect(measured.claims.automaticReopens).toBe(0);
        expect(measured.claims.reReviewClaims).toBe(measured.claims.attributableReopens + measured.claims.automaticReopens);
        expect(measured.claims.namingUnrecordedEvidence).toBe(0);
        expect(measured.claims.byStatus.open).toBe(1);
        expect(measured.claims.bySupport?.supported).toBe(1);
        expect(measured.evidence.unverified).toBe(0);
        expect(measured.evidence.byType.static_witness).toBe(1);
        expect(measured.discovery.refutationRate).toBe(0);
        expect(measured.authorSide.firstClaimAt).toBeTruthy();
        expect(measured.authorSide.medianClaimToSupportedMs).not.toBeNull();
    });

    it('stores the plan, then narrows its reading sets by what actually moved', async () => {
        await ledger(['policy', '--init']);
        await ledger(['freeze']);
        await ledger(claimArgv());
        await ledger(['evidence', 'add', '--file', await submission()]);
        await ledger(['evidence', 'verify']);

        // **Without a plan there is nothing to narrow**, and that is a named state rather than a silently re-derived impact
        // cone: the reading set is the planner's answer, and a second derivation of it here would be the defect this line
        // keeps removing.
        const beforePlan = await ledger(['focus']);
        expect(beforePlan.ok).toBe(false);
        expect(String(beforePlan.error)).toContain('no plan has been stored');

        const planned = await ledger(['plan', '--c0', '600000']);
        // The envelope is reported from the policy, not derived a second time: a plan that says what evidence a review must
        // produce is incomplete without the limits it must produce it within, and one number for one fact is the point.
        const envelope = planned.envelope as { maxWallMs: number; deadlineToolCalls: number | null };
        expect(envelope.maxWallMs).toBe(3_940_500);
        expect(envelope.deadlineToolCalls).toBeNull();

        const unchanged = await ledger(['focus']);
        expect((unchanged.reopened as unknown[]).length).toBe(0);
        expect((unchanged.untouched as string[])).toEqual(['C1']);
        expect(String(unchanged.note)).toContain('nothing the plan covers has moved');

        // A path the claim depends on that has moved is the claim's reading set, so the plan the operator was handed now
        // says what to read rather than what to read everything for.
        await writeFile(join(root, 'src', 'a.ts'), 'export const holds = false;\n');
        const drifted = await ledger(['focus']);
        const reopened = drifted.reopened as Array<{ claimId: string; read: string[]; why: string }>;
        expect(reopened.map((entry) => entry.claimId)).toEqual(['C1']);
        expect(reopened[0]?.read).toEqual(['src/a.ts']);
        expect(String(drifted.note)).toContain('read 1 path(s) across 1 claim(s)');
        expect(drifted.changed).toEqual(['src/a.ts']);
    });

    it('plans from the risk of the touched paths and derives a deadline from a recorded baseline', async () => {
        await ledger(['policy', '--init']);
        await ledger(['freeze']);
        await ledger(claimArgv());
        const planned = await ledger(['plan', '--c0', '600000']);
        const plan = planned.plan as { tier: string; discovery: { deadlineToolCalls: number | null }; readingSets: Array<{ paths: string[] }> };
        // **The tier the decision will use, which is the classification raised to the policy ceiling.** This asserted
        // `standard` while `ledger decide` on the same ledger answered `strict` — two derivations of one fact, and the plan
        // was the one computing its required evidence for a weaker tier than its own gate would enforce.
        expect(plan.tier).toBe('strict');
        expect(plan.discovery.deadlineToolCalls).toBe(200);
        expect(plan.readingSets[0]?.paths).toEqual(['src/a.ts']);
    });
});
