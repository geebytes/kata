import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { answerProbe, appendChallenge, appendClaim, appendEvidence, freezeSubject, ledgerReport, readLedger, readPlan, readProbeAnswers, readProbes, readVerdictHistory, recordVerdicts, resolveChallenge, writeSubject } from '../../src/store/ledger.js';
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

    it('names the floor for a free-form terminal record, because it is not an attempt at all', async () => {
        // The free form is a record, not a reproduction: nothing declared a defect for it to be sensitive to, so it is not
        // an attempt this revision can verify. `discovery_floor` ("record one") is the honest remedy, and the deficit names
        // the flag that declares a falsifier rather than the free command that cannot count.
        const { codes, deficits } = await ledgerWithChallenge({
            ...base,
            state: 'withdrawn',
            resolution: { at: '2026-10-05T00:01:00.000Z', observed: '   ' },
        });
        expect(codes).toContain('discovery_floor');
        expect(codes).not.toContain('discovery_unverified');
        expect(codes).not.toContain('challenge_open');
        const deficit = deficits.find((entry) => entry.claimId === 'discovery:independent_challenge');
        expect(deficit?.need).toContain('--falsifier');
    });

    it('refuses an answer whose observation key is absent, naming the artefact instead of inventing a blank one', async () => {
        // The probe half reads a second schema-less artefact. An answer that lacks a declared field is not a blank
        // answer: under this boundary the artefact is unreadable, and the refusal names the file rather than coercing a
        // value the file never held.
        await mkdir(join(root, '.kata', 'tasks', changeId, 'review'), { recursive: true });
        await writeFile(
            join(root, '.kata', 'tasks', changeId, 'review', 'probe-answers.json'),
            `${JSON.stringify([{ probeId: 'P1-C1', command: 'test -f src/a.ts', answeredAt: '2026-10-05T00:00:00.000Z' }], null, 2)}\n`,
        );
        const verdict = await ledgerVerdict({ root, changeId, tier: 'strict' });
        expect(verdict.kind).toBe('unreadable');
        expect(verdict.kind === 'unreadable' ? verdict.detail : '').toContain('probe-answers.json');
        expect((await readLedger(root, changeId)).malformedFiles).toContain('probe-answers.json');
    });

    it('refuses an answer whose command is a non-string, rather than coercing it', async () => {
        await mkdir(join(root, '.kata', 'tasks', changeId, 'review'), { recursive: true });
        await writeFile(
            join(root, '.kata', 'tasks', changeId, 'review', 'probe-answers.json'),
            `${JSON.stringify([{ probeId: 'P1-C1', command: 42, observed: 'exit 0', answeredAt: '2026-10-05T00:00:00.000Z' }], null, 2)}\n`,
        );
        const verdict = await ledgerVerdict({ root, changeId, tier: 'strict' });
        expect(verdict.kind).toBe('unreadable');
        expect(verdict.kind === 'unreadable' ? verdict.detail : '').toContain('probe-answers.json');
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

    it('names the floor, not an unrun challenge, when the only record carries a state this build does not know', async () => {
        // The negation `state !== 'open'` used to count a record whose state is missing or unknown as an independent
        // challenge, so the refusal said "run the recorded challenge" about a ledger that holds none. Both refuse; only
        // one of them names the step that would fix it. A *missing* state is now unreadable instead (see the reader
        // cases below), so the unknown-but-present state is what keeps this distinction testable.
        const { codes } = await ledgerWithChallenge(null, {
            stored: { id: 'X1', claimId: 'C1', command: 'true', failsOn: 'rev:x', state: 'not-a-state', at: '2026-10-05T00:00:00.000Z' },
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
        expect(codes).toContain('discovery_floor');
        expect(codes).not.toContain('discovery_unverified');
        expect(codes).not.toContain('challenge_open');
    });
});

/**
 * **The other readers of the same schema-less files, at the layer where the type is claimed.**
 *
 * The cases above drive the decision; these drive the readers themselves. The guarantee is asserted where the type is
 * promised rather than at each consumer that might forget it — but the guarantee is now stronger than "hand out what
 * can be coerced": a document whose container or element does not answer its declared type is *unreadable*, and the
 * artefact is named. Coercing a field to `''` and dropping a record were both ways of reporting a state the file never
 * held, and a dropped record is indistinguishable from one that was never written.
 */
describe('the readers of the schema-less ledger files', () => {
    const reviewDirOf = (): string => join(root, '.kata', 'tasks', changeId, 'review');
    const writeArtefact = async (file: string, content: string): Promise<void> => {
        await mkdir(reviewDirOf(), { recursive: true });
        await writeFile(join(reviewDirOf(), file), content);
    };
    const unreadableDetail = async (): Promise<string> => {
        const verdict = await ledgerVerdict({ root, changeId, tier: 'strict' });
        return verdict.kind === 'unreadable' ? verdict.detail : `read as ${verdict.kind}`;
    };

    it('refuses an artefact whose element is not a record, and names it', async () => {
        await writeArtefact('challenges.json', `${JSON.stringify([null, { id: 'X1', claimId: 'C1', command: 'true', failsOn: 'rev:x', state: 'withdrawn', at: 'x' }], null, 2)}\n`);
        expect(await unreadableDetail()).toContain('challenges.json');
        expect((await readLedger(root, changeId)).malformedFiles).toContain('challenges.json');
    });

    it('does not mistake an array for a record', async () => {
        await writeArtefact('probe-answers.json', `${JSON.stringify([['x'], { probeId: 'P1-C1', command: 'test -f src/a.ts', observed: 'exit 0', answeredAt: 'x' }], null, 2)}\n`);
        expect(await unreadableDetail()).toContain('probe-answers.json');
    });

    it('refuses a record that lacks a required field, rather than answering with a value the file never held', async () => {
        await writeArtefact('probe-answers.json', `${JSON.stringify([{ probeId: 'P1-C1' }], null, 2)}\n`);
        expect(await unreadableDetail()).toContain('probe-answers.json');
    });

    it('refuses a record whose declared field is not a string', async () => {
        await writeArtefact('probes.json', `${JSON.stringify([{ id: 'P1-C1', claimId: 'C1', kind: 'file-exists', path: 'src/a.ts', command: 42, askedAt: 'x' }], null, 2)}\n`);
        expect(await unreadableDetail()).toContain('probes.json');
    });

    it('still reads a legacy record whose required fields are all present', async () => {
        // The boundary refuses records that do not answer the type; it does not refuse an old record that does. This is
        // the distinction the whole change turns on: a legacy record stays readable, and is only ineligible for current
        // discovery credit (asserted in the end-to-end suite).
        const frozen = await freezeSubject({ root, paths: ['src/a.ts'] });
        if (!frozen.ok) throw new Error('the fixture could not freeze its subject');
        await writeSubject(root, changeId, frozen.subject);
        await writeArtefact('challenges.json', `${JSON.stringify([{ id: 'X1', claimId: 'C1', command: 'true', failsOn: 'rev:x', state: 'withdrawn', at: 'x', resolution: { at: 'y', observed: 'exit 0' } }], null, 2)}\n`);
        const challenges = await readLedger(root, changeId).then((ledger) => ledger.challenges);
        expect(challenges.map((challenge) => challenge.id)).toEqual(['X1']);
    });

    it('reads the run log through the same boundary, so a corrupt entry cannot stop the decision', async () => {
        // `runs.json` is listed as schema-less beside the others. Its array element is the discriminating case: it
        // declares no identity field, so an element that is not a record reaches the container check.
        await writeArtefact('runs.json', `${JSON.stringify([null, { at: 'x', producer: 'pi', claims: 1, evidence: 1, diversity: 'prompt_strategy' }], null, 2)}\n`);
        expect(await unreadableDetail()).toContain('runs.json');
    });

    it('refuses a plan whose mapped field is not an array of records', async () => {
        // Both `focus` and the request builder write `(plan.readingSets ?? []).map(...)`; a plan whose key is present but
        // is not an array of records used to throw inside the command. It is unreadable now.
        await writeArtefact('plan.json', `${JSON.stringify({ readingSets: [null, { claimId: 'C1', paths: ['src/a.ts'] }], requiredEvidence: 42, tier: 'strict' }, null, 2)}\n`);
        expect(await unreadableDetail()).toContain('plan.json');
    });

    it('refuses a JSONL history whose line is not a record', async () => {
        await writeArtefact('verdict-history.jsonl', `null\n{"evidenceId":"E1","verdict":"supported"}\n`);
        expect(await unreadableDetail()).toContain('verdict-history.jsonl');
    });

    it('refuses a write over an unreadable artefact and leaves its bytes alone', async () => {
        // **A writer is not a repair tool.** Replacing bytes the reader could not use with `[]` would destroy the evidence
        // that the file is corrupt and report a successful append over it.
        await writeArtefact('challenges.json', `${JSON.stringify([null, { id: 'X1', claimId: 'C1', command: 42, failsOn: 'rev:x', state: 'open', at: 'x' }], null, 2)}\n`);
        const before = await readFile(join(reviewDirOf(), 'challenges.json'), 'utf8');
        await expect(appendChallenge(root, changeId, {
            id: 'X2', claimId: 'C1', command: 'true', failsOn: 'rev:x', state: 'open', at: 'x',
        })).rejects.toThrow(/challenges\.json/);
        expect(await readFile(join(reviewDirOf(), 'challenges.json'), 'utf8')).toBe(before);
    });

    it('refuses to append an answer to an unreadable answer list, and says so instead of throwing', async () => {
        await writeArtefact('probe-answers.json', `${JSON.stringify([{ probeId: 42, command: 'x', observed: 'y', answeredAt: 'z' }], null, 2)}\n`);
        const before = await readFile(join(reviewDirOf(), 'probe-answers.json'), 'utf8');
        const recorded = await answerProbe(root, changeId, { probeId: 'P1-C1', command: 'test -f src/a.ts', observed: 'exit 0', answeredAt: 'x' });
        expect(recorded.ok).toBe(false);
        expect(await readFile(join(reviewDirOf(), 'probe-answers.json'), 'utf8')).toBe(before);
    });

    it('creates a valid document when the artefact is absent, and does not confuse that with unreadable', async () => {
        await expect(appendChallenge(root, changeId, {
            id: 'X1', claimId: 'C1', command: 'true', failsOn: 'rev:x', state: 'open', at: 'x',
        })).resolves.toBeDefined();
        const challenges = await readLedger(root, changeId).then((ledger) => ledger.challenges);
        expect(challenges.map((challenge) => challenge.id)).toEqual(['X1']);
    });
});
