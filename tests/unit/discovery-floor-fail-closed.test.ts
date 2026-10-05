import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendChallenge, appendClaim, appendEvidence, freezeSubject, readLedger, readProbeAnswers, recordVerdicts, writeSubject } from '../../src/store/ledger.js';
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
    options: { stored?: unknown; answers?: unknown[] } = {},
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
