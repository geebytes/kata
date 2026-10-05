import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendChallenge, appendClaim, appendEvidence, freezeSubject, ledgerReport, readLedger, readPlan, readProbeAnswers, readProbes, readVerdictHistory, recordVerdicts, resolveChallenge, writeSubject } from '../../src/store/ledger.js';
import { ledgerVerdict } from '../../src/store/verdict.js';
import { makeClaim, makeEvidence, makeVerdict } from '../helpers/review.js';

/**
 * **What the discovery floor still refuses to accept, from a real ledger to a real decision.**
 *
 * The floor was widened once — a terminal challenge counts because it ran and recorded an observation, not because it once
 * reproduced — and widening a floor is exactly the change that quietly removes the refusals beside it. This suite pins
 * those refusals at the layer that actually decides, rather than at the count alone: a ledger is written to disk, read
 * back, and decided, so a record state that stopped refusing would show up here and not only in a unit fixture.
 *
 * Three states must stay closed, and one must stay open:
 *
 *   - an **open** counterexample still blocks through `challenge_open`, and is not counted as discovery;
 *   - a check that **timed out** leaves the challenge open, so it blocks the same way — an unresolved measurement is not
 *     a completed one;
 *   - a **terminal** record whose observation is blank proves nothing ran, so it refuses through `discovery_unverified`
 *     with a deficit naming the command that would fix it;
 *   - a terminal record with a recorded observation clears discovery, including a legacy `resolved` one.
 *
 * Deliberately not asserted here: the overall verdict. The tier's other demands (risk-class coverage, assurance) are
 * other suites' subjects, and coupling this one to them would make a discovery-floor regression look like a coverage
 * regression.
 */
let root: string;
const changeId = 'discovery-floor-fixture';

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'kata-discovery-floor-'));
    await mkdir(join(root, '.kata', 'tasks', changeId), { recursive: true });
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src', 'a.ts'), 'export const holds = true;\n');
    await writeFile(
        join(root, '.kata', 'tasks', changeId, 'task.json'),
        `${JSON.stringify({ id: changeId, ownedPaths: ['src/a.ts'] }, null, 2)}\n`,
    );
});

afterEach(async () => {
    await rm(root, { recursive: true, force: true });
});

/**
 * A ledger with one supported claim and exactly one challenge in the state under test.
 *
 * `stored` writes the record straight to `challenges.json` instead of through `appendChallenge`. That is not a shortcut:
 * `challenges.json` is registered `internal` with no schema, so a record the typed writer cannot produce is exactly the
 * shape a legacy or hand-repaired ledger holds — and the reader has to survive it rather than assume it away.
 */
async function ledgerWithChallenge(
    challenge: Parameters<typeof appendChallenge>[2] | null,
    options: { stored?: unknown; answers?: unknown[]; runs?: unknown[] } = {},
): Promise<{ codes: string[]; deficits: Array<{ claimId: string; need: string }> }> {
    const frozen = await freezeSubject({ root, paths: ['src/a.ts'] });
    expect(frozen.ok).toBe(true);
    if (!frozen.ok) throw new Error('the fixture could not freeze its subject');
    await writeSubject(root, changeId, frozen.subject);
    await appendClaim(root, changeId, makeClaim({
        id: 'C1',
        riskClass: 'consistency',
        severity: 'major',
        evidenceIds: ['E1'],
        dependsOn: ['path:src/a.ts'],
    }));
    await appendEvidence(root, changeId, makeEvidence({ id: 'E1', ref: 'src/a.ts', assertion: 'contains:holds' }));
    await recordVerdicts(root, changeId, [makeVerdict({ evidenceId: 'E1', verdict: 'supported', subjectRevision: frozen.subject.revision })]);
    if (options.stored !== undefined) {
        await writeFile(join(root, '.kata', 'tasks', changeId, 'review', 'challenges.json'), `${JSON.stringify([options.stored], null, 2)}\n`);
    } else if (challenge !== null) {
        await appendChallenge(root, changeId, challenge);
    } else if (options.answers === undefined) {
        throw new Error('the fixture must pass a challenge, a record to store, or the answers to store');
    }
    // The run log is schema-less too, and the quorum reads it.
    if (options.runs !== undefined) {
        await writeFile(join(root, '.kata', 'tasks', changeId, 'review', 'runs.json'), `${JSON.stringify(options.runs, null, 2)}\n`);
    }
    // The same shape question for the probe half, which reads a second schema-less artefact.
    if (options.answers !== undefined) {
        await writeFile(join(root, '.kata', 'tasks', changeId, 'review', 'probe-answers.json'), `${JSON.stringify(options.answers, null, 2)}\n`);
    }

    // The tier is named rather than classified: the discovery floor is a strict-tier rule, and letting the fixture's
    // automatic classification decide would make these cases depend on a path table they are not about.
    const verdict = await ledgerVerdict({ root, changeId, tier: 'strict' });
    if (verdict.kind !== 'decided') throw new Error(`the fixture ledger read as ${verdict.kind}: ${verdict.detail}`);
    return {
        codes: verdict.decision.reasons.map((reason) => reason.code),
        deficits: verdict.decision.deficits.map((deficit) => ({ claimId: deficit.claimId, need: deficit.need })),
    };
}

const base = {
    id: 'X1',
    claimId: 'C1',
    command: 'grep -q marked notes/discovery.txt',
    failsOn: 'rev:whatever',
    at: '2026-10-05T00:00:00.000Z',
} as const;

describe('the discovery floor keeps refusing what did not run', () => {
    it('blocks an open counterexample and does not count it as discovery', async () => {
        const { codes } = await ledgerWithChallenge({ ...base, state: 'open' });
        expect(codes).toContain('challenge_open');
        // An open challenge is not a completed reading, so the floor is still unmet rather than "verified and passing".
        expect(codes).not.toContain('discovery_unverified');
    });

    it('treats a timed-out check as unresolved, so it blocks like any other open counterexample', async () => {
        const { codes } = await ledgerWithChallenge({
            ...base,
            state: 'open',
            resolution: { at: '2026-10-05T00:01:00.000Z', observed: 'timed out after 60000 when checked against rev:whatever' },
        });
        expect(codes).toContain('challenge_open');
        expect(codes).not.toContain('discovery_unverified');
    });

    it('refuses a terminal record with no usable observation, and names the command that would fix it', async () => {
        const { codes, deficits } = await ledgerWithChallenge({
            ...base,
            state: 'withdrawn',
            resolution: { at: '2026-10-05T00:01:00.000Z', observed: '   ' },
        });
        expect(codes).toContain('discovery_unverified');
        expect(codes).not.toContain('challenge_open');
        // The refusal carries the step, not only the state: an author reading it can act without inventing the remedy.
        const deficit = deficits.find((entry) => entry.claimId === 'discovery:verified_challenge');
        expect(deficit?.need).toContain('challenge check');
    });

    it('refuses an answer whose observation key is absent instead of crashing on it', async () => {
        // The probe half reads a second schema-less artefact, and it had the same unguarded dereference the challenge half
        // was repaired for — one branch below it. An answer recorded without an `observed` is not an answer that proved
        // anything, so it must land on the refusing path; a `TypeError` here reaches every surface that reads the ledger.
        const { codes } = await ledgerWithChallenge(null, {
            answers: [{ probeId: 'P1-C1', command: 'test -f src/a.ts', answeredAt: '2026-10-05T00:00:00.000Z' }],
        });
        expect(codes).toContain('discovery_unverified');
        expect(codes).not.toContain('challenge_open');
    });

    it('refuses an answer whose command is a non-string instead of crashing on it', async () => {
        const { codes } = await ledgerWithChallenge(null, {
            answers: [{ probeId: 'P1-C1', command: 42, observed: 'exit 0', answeredAt: '2026-10-05T00:00:00.000Z' }],
        });
        expect(codes).toContain('discovery_unverified');
    });

    it('clears discovery for a terminal record that recorded an observation, without any counterexample history', async () => {
        const { codes } = await ledgerWithChallenge({
            ...base,
            state: 'withdrawn',
            resolution: { at: '2026-10-05T00:01:00.000Z', observed: 'exit 0 when checked against rev:whatever' },
        });
        expect(codes).not.toContain('discovery_unverified');
        expect(codes).not.toContain('challenge_open');
    });

    it('names the floor, not an unrun challenge, when the only record has no usable state', async () => {
        // The negation `state !== 'open'` used to count a record whose state is missing or unknown as an independent
        // challenge, so the refusal said "run the recorded challenge" about a ledger that holds none. Both refuse; only
        // one of them names the step that would fix it.
        const { codes } = await ledgerWithChallenge(null, {
            stored: { id: 'X1', claimId: 'C1', command: 'true', failsOn: 'rev:x', at: '2026-10-05T00:00:00.000Z' },
        });
        expect(codes).toContain('discovery_floor');
        expect(codes).not.toContain('discovery_unverified');
    });

    it('still reads a legacy resolved challenge, so a pre-existing record is not silently demoted', async () => {
        const { codes } = await ledgerWithChallenge({
            ...base,
            state: 'resolved',
            resolution: { at: '2026-10-05T00:01:00.000Z', observed: 'exit 1 when checked against rev:whatever' },
        });
        expect(codes).not.toContain('discovery_unverified');
        expect(codes).not.toContain('challenge_open');
    });

    it('refuses a terminal record whose observation key is absent instead of crashing on it', async () => {
        // The absent key is not the blank string. `observed` is required by the type and by nothing else — the artefact has
        // no schema — so this record reaches the derivation, and the derivation must turn it into the same refusal as a
        // blank one. A guard that dereferences the field instead converts a promised refusal into a crash on every surface
        // that reads the ledger, which is strictly worse than the state it was meant to reject.
        const { codes } = await ledgerWithChallenge(null, {
            stored: {
                id: 'X1',
                claimId: 'C1',
                command: 'grep -q marked notes/discovery.txt',
                failsOn: 'rev:whatever',
                state: 'withdrawn',
                at: '2026-10-05T00:00:00.000Z',
                resolution: { at: '2026-10-05T00:01:00.000Z' },
            },
        });
        expect(codes).toContain('discovery_unverified');
        expect(codes).not.toContain('challenge_open');
    });
});

/**
 * **The other readers of the same schema-less files, at the layer where the type is claimed.**
 *
 * The cases above drive the decision; these drive the readers themselves. Three review rounds found the same defect one
 * consumer at a time — a reader trusted `Challenge[]`/`ProbeAnswer[]` and dereferenced a field the file did not have —
 * so the guarantee is asserted where the type is promised rather than at each consumer that might forget it.
 */
describe('the readers of the schema-less ledger files', () => {
    it('hands out records whose declared string fields are strings, whatever the file holds', async () => {
        const frozen = await freezeSubject({ root, paths: ['src/a.ts'] });
        if (!frozen.ok) throw new Error('the fixture could not freeze its subject');
        await writeSubject(root, changeId, frozen.subject);
        await writeFile(
            join(root, '.kata', 'tasks', changeId, 'review', 'probe-answers.json'),
            `${JSON.stringify([{ probeId: 'P1-C1', command: 42, observed: { seen: true }, answeredAt: null }], null, 2)}\n`,
        );

        const answers = await readProbeAnswers(root, changeId);
        expect(answers).toHaveLength(1);
        expect(answers[0]?.command).toBe('');
        expect(answers[0]?.observed).toBe('');
        expect(answers[0]?.probeId).toBe('P1-C1');
    });

    it('answers its declared type when a required field is absent, not merely when it is present', async () => {
        // The first version of the coercion only touched fields the file *had*, so a record that simply lacked a required
        // one was handed out with `undefined` where `Challenge`/`Probe`/`ProbeAnswer` promise `string` — and the next
        // `.trim()` threw. A sixth independent round found it, one round after the filter was fixed for the same reason.
        await mkdir(join(root, '.kata', 'tasks', changeId, 'review'), { recursive: true });
        await writeFile(join(root, '.kata', 'tasks', changeId, 'review', 'probe-answers.json'), `${JSON.stringify([{ probeId: 'P1-C1' }], null, 2)}\n`);
        await writeFile(join(root, '.kata', 'tasks', changeId, 'review', 'probes.json'), `${JSON.stringify([{ id: 'P1-C1', claimId: 'C1' }], null, 2)}\n`);
        await writeFile(join(root, '.kata', 'tasks', changeId, 'review', 'challenges.json'), `${JSON.stringify([{ id: 'X1', claimId: 'C1' }], null, 2)}\n`);

        const answers = await readProbeAnswers(root, changeId);
        const probes = await readProbes(root, changeId);
        const challenges = await readLedger(root, changeId).then((ledger) => ledger.challenges);
        expect(answers[0]?.command).toBe('');
        expect(answers[0]?.observed).toBe('');
        expect(probes[0]?.command).toBe('');
        expect(challenges[0]?.command).toBe('');
        // `state` is required too, and an unknown state must not read as one the floor can count.
        expect(challenges[0]?.state).toBe('');
        await expect(ledgerReport(root, changeId)).resolves.toBeDefined();
    });

    it('lets the write path resolve the record by the name the reader handed out', async () => {
        // The reader coerces a non-string id, so the caller's copy of the name is the coerced one. Looking the record up by
        // the raw value could not find it — and the caller discarded the `false`, printing a resolution the file never
        // recorded. Both sides now name a record the same way.
        await mkdir(join(root, '.kata', 'tasks', changeId, 'review'), { recursive: true });
        await writeFile(
            join(root, '.kata', 'tasks', changeId, 'review', 'challenges.json'),
            `${JSON.stringify([{ id: 42, claimId: 'C1', command: 'true', failsOn: 'rev:x', state: 'open', at: 'x' }], null, 2)}\n`,
        );

        const named = await readLedger(root, changeId).then((ledger) => ledger.challenges[0]?.id);
        const resolved = await resolveChallenge(root, changeId, named ?? '', { state: 'withdrawn', observed: 'exit 0 when checked', at: 'x' });
        expect(resolved).toBe(true);
        const after = JSON.parse(await readFile(join(root, '.kata', 'tasks', changeId, 'review', 'challenges.json'), 'utf8')) as Array<{ state: string }>;
        expect(after[0]?.state).toBe('withdrawn');
    });

    it('reads the run log through the same filter, so a corrupt entry cannot stop the decision', async () => {
        // `runs.json` is listed as schema-less beside the others, and it was the one file `readLedger` still handed out
        // raw — so a single null entry made the quorum's producer read throw on every surface that decides. An
        // independent round found it the round after the reader guard was extended to the other three.
        const { codes } = await ledgerWithChallenge(
            { ...base, state: 'withdrawn', resolution: { at: '2026-10-05T00:01:00.000Z', observed: 'exit 0 when checked' } },
            // The array element is the discriminating one for this file: `runs.json` declares no identity field, so an
            // element that is not a record reaches the array filter rather than being dropped as unnameable.
            { runs: [null, ['x'], { at: 'x', producer: 'pi', claims: 1, evidence: 1, diversity: 'prompt_strategy' }] },
        );
        expect(codes).not.toContain('discovery_unverified');
        // Asserted on the reader itself, not only through the decision: the decision stopped depending on the run log's
        // shape when the dead producer read was removed, so a decision-level assertion would no longer be able to redden.
        const runs = await readLedger(root, changeId).then((ledger) => ledger.runs);
        expect(runs).toHaveLength(1);
        expect(runs[0]?.producer).toBe('pi');
    });

    it('does not hand out a record nobody can name, so two records cannot share one name', async () => {
        // A record whose identity field is not a string is not usable: the reader coerces it to `''`, two such records
        // become one name, and naming one of them by position was how a resolution could be written to the record the
        // caller did not mean — with the command still reporting success. Dropping it upstream is what keeps a name a name.
        // The file keeps its bytes, so nothing is hidden; what the reader hands out is what a caller can act on.
        await mkdir(join(root, '.kata', 'tasks', changeId, 'review'), { recursive: true });
        const file = join(root, '.kata', 'tasks', changeId, 'review', 'challenges.json');
        await writeFile(file, `${JSON.stringify([
            { id: 42, claimId: 'C1', command: 'exit 1', failsOn: 'rev:x', state: 'open', at: 'x' },
            { id: 43, claimId: 'C1', command: 'exit 0', failsOn: 'rev:x', state: 'open', at: 'x' },
            { id: 'X1', claimId: 'C1', command: 'exit 0', failsOn: 'rev:x', state: 'open', at: 'x' },
        ], null, 2)}\n`);

        const named = await readLedger(root, changeId).then((ledger) => ledger.challenges.map((challenge) => challenge.id));
        expect(named).toEqual(['X1']);
        await expect(resolveChallenge(root, changeId, 'X1', { state: 'withdrawn', observed: 'exit 0', at: 'x' })).resolves.toBe(true);
        // The two it could not name are untouched on disk, and neither of them was written to.
        const after = JSON.parse(await readFile(file, 'utf8')) as Array<{ id: unknown; state: string }>;
        expect(after.map((entry) => entry.state)).toEqual(['open', 'open', 'withdrawn']);
    });

    it('refuses a name that a duplicate id makes ambiguous', async () => {
        await mkdir(join(root, '.kata', 'tasks', changeId, 'review'), { recursive: true });
        const file = join(root, '.kata', 'tasks', changeId, 'review', 'challenges.json');
        await writeFile(file, `${JSON.stringify([
            { id: 'X1', claimId: 'C1', command: 'exit 1', failsOn: 'rev:x', state: 'open', at: 'x' },
            { id: 'X1', claimId: 'C1', command: 'exit 0', failsOn: 'rev:x', state: 'open', at: 'x' },
        ], null, 2)}\n`);

        await expect(resolveChallenge(root, changeId, 'X1', { state: 'withdrawn', observed: 'exit 0', at: 'x' })).resolves.toBe(false);
        const after = JSON.parse(await readFile(file, 'utf8')) as Array<{ state: string }>;
        expect(after.map((entry) => entry.state)).toEqual(['open', 'open']);
    });

    it('promises the shape its consumers dereference for the plan, and drops a line that is not a record', async () => {
        // Both `focus` and the request builder write `(plan.readingSets ?? []).map(...)`; a plan whose key is present but
        // is not an array made `ledger focus` throw. And a `null` line in the history reached a consumer that read
        // `.evidenceId` off it — a line that parses is not yet a record.
        await mkdir(join(root, '.kata', 'tasks', changeId, 'review'), { recursive: true });
        await writeFile(join(root, '.kata', 'tasks', changeId, 'review', 'plan.json'), `${JSON.stringify({ readingSets: [null, { claimId: 'C1', paths: ['src/a.ts'] }], requiredEvidence: 42, tier: 'strict' }, null, 2)}\n`);
        await writeFile(join(root, '.kata', 'tasks', changeId, 'review', 'verdict-history.jsonl'), `null\n{"evidenceId":"E1","verdict":"supported"}\n`);

        const plan = await readPlan(root, changeId) as { readingSets: Array<{ claimId: string }>; requiredEvidence: unknown[]; tier: string };
        // Array-ness is not enough: the consumers dereference the elements, so a non-record element is dropped here too.
        expect(plan.readingSets.map((set) => set.claimId)).toEqual(['C1']);
        expect(plan.requiredEvidence).toEqual([]);
        expect(plan.tier).toBe('strict');
        const history = await readVerdictHistory(root, changeId);
        expect(history.entries.map((entry) => entry.evidenceId)).toEqual(['E1']);
        expect(history.malformed).toBe(1);
    });

    it('does not mistake an array for a record', async () => {
        // An array satisfies `typeof entry === 'object' && entry !== null`, so the first version of the filter let one
        // through, spread it into `{0: 'x'}`, and handed it out as an answer with no command — crashing the very report
        // reader the filter was written to protect. An independent round found it the round after the guard moved here.
        await mkdir(join(root, '.kata', 'tasks', changeId, 'review'), { recursive: true });
        await writeFile(
            join(root, '.kata', 'tasks', changeId, 'review', 'probe-answers.json'),
            `${JSON.stringify([['x'], { probeId: 'P1-C1', command: 'test -f src/a.ts', observed: 'exit 0', answeredAt: 'x' }], null, 2)}\n`,
        );

        const answers = await readProbeAnswers(root, changeId);
        expect(answers.map((answer) => answer.probeId)).toEqual(['P1-C1']);
        await expect(ledgerReport(root, changeId)).resolves.toBeDefined();
    });

    it('lets a write path read the same file the readers do, without crashing on what it cannot dereference', async () => {
        // The write paths dereference `entry.id` too, so the guarantee has to hold there as well — and it must hold
        // without coercing, because rewriting a legacy record's fields as a side effect of an unrelated append would
        // destroy the value that says the file is corrupt.
        await mkdir(join(root, '.kata', 'tasks', changeId, 'review'), { recursive: true });
        await writeFile(
            join(root, '.kata', 'tasks', changeId, 'review', 'challenges.json'),
            `${JSON.stringify([null, { id: 'X1', claimId: 'C1', command: 42, failsOn: 'rev:x', state: 'open', at: 'x' }], null, 2)}\n`,
        );

        await expect(appendChallenge(root, changeId, {
            id: 'X2', claimId: 'C1', command: 'true', failsOn: 'rev:x', state: 'open', at: 'x',
        })).resolves.toBeDefined();
        const written = await readLedger(root, changeId).then((ledger) => ledger.challenges);
        expect(written.map((challenge) => challenge.id)).toEqual(['X1', 'X2']);
        // The preserved field is the point, and it has to be read from the file rather than through the coercing reader:
        // the write path must leave a legacy value alone, so an unrelated append cannot destroy what says the file is corrupt.
        const raw = JSON.parse(await readFile(join(root, '.kata', 'tasks', changeId, 'review', 'challenges.json'), 'utf8')) as Array<{ id: string; command: unknown }>;
        expect(raw.map((entry) => entry.id)).toEqual(['X1', 'X2']);
        expect(raw[0]?.command).toBe(42);
    });

    it('drops an element that is not a record instead of dereferencing it', async () => {
        const frozen = await freezeSubject({ root, paths: ['src/a.ts'] });
        if (!frozen.ok) throw new Error('the fixture could not freeze its subject');
        await writeSubject(root, changeId, frozen.subject);
        await writeFile(
            join(root, '.kata', 'tasks', changeId, 'review', 'challenges.json'),
            `${JSON.stringify([null, { id: 'X1', claimId: 'C1', command: 'true', failsOn: 'rev:x', state: 'withdrawn', at: 'x' }], null, 2)}\n`,
        );

        // The reader hands out the record it can act on. The element it cannot act on is gone, and nothing dereferenced it.
        const challenges = await readLedger(root, changeId).then((ledger) => ledger.challenges);
        expect(challenges.map((challenge) => challenge.id)).toEqual(['X1']);
    });
});
