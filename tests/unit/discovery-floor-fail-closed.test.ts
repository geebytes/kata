import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendChallenge, appendClaim, appendEvidence, freezeSubject, recordVerdicts, writeSubject } from '../../src/store/ledger.js';
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

/** A ledger with one supported claim and exactly one challenge in the state under test. */
async function ledgerWithChallenge(challenge: Parameters<typeof appendChallenge>[2]): Promise<{ codes: string[]; deficits: Array<{ claimId: string; need: string }> }> {
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
    await appendChallenge(root, changeId, challenge);

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
});
