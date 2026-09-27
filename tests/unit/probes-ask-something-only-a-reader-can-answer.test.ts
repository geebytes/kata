import { describe, expect, it } from 'vitest';
import { probesFor, responseRate } from '../../src/kernel/discovery.js';
import { subjectOf } from '../../src/kernel/subject.js';
import type { Claim } from '../../src/kernel/types.js';

/**
 * **The business action the receipt was trying to be, in the only form that is checkable.**
 *
 * `executedInFreshContext` was an agent's assertion about itself; the receipt that replaced it is a document only a host
 * can author, which is why two strict changes sat blocked for a day. The clean-sheet reading is that a reviewer cannot
 * prove its internals, so it should be asked something **only a reader of this revision can answer** — a question
 * generated from the claim's own surface, after the fact, which the reviewer was never given.
 *
 * These cases pin the properties that make it a question rather than a formality: it is derived (not authored), it is
 * reproducible from the ledger alone, it asks about content (so guessing and reading are distinguishable), a claim with
 * nothing to ask about is reported rather than padded, and the rate is `null` when nothing was asked.
 */
const subject = subjectOf({ 'src/a.ts': 'a1b2c3d4e5f60718', 'src/b.ts': 'ffffffff00000000' });

function claim(overrides: Partial<Claim> = {}): Claim {
    return {
        id: 'C1',
        statement: 'the export is present',
        riskClass: 'consistency',
        severity: 'major',
        dependsOn: ['path:src/a.ts'],
        evidenceIds: ['E1'],
        challengeIds: [],
        status: 'open',
        at: '2026-09-27T00:00:00.000Z',
        reopens: 0,
        ...overrides,
    };
}

describe('a probe asks something a reader can answer and a non-reader cannot', () => {
    it('is reproducible: the same seed and subject ask the same questions', () => {
        const first = probesFor({ claim: claim(), subject, seed: 'rev:1', count: 2, askedAt: 't' });
        const second = probesFor({ claim: claim(), subject, seed: 'rev:1', count: 2, askedAt: 't' });
        expect(first).toEqual(second);
        // And the draw is a draw rather than a constant: over several seeds at least two sets differ. Asserting that
        // *one* other seed differs would be asserting something sampling does not promise — with a two-path surface two
        // seeds can legitimately agree, and a test that demanded otherwise would be pinning luck.
        const sets = new Set(['rev:1', 'rev:2', 'rev:3', 'rev:4', 'rev:5'].map((seed) =>
            JSON.stringify(probesFor({ claim: claim(), subject, seed, count: 2, askedAt: 't' }))));
        expect(sets.size).toBeGreaterThan(1);
    });

    it('asks about content of a path the claim rests on, never about the claim text', () => {
        const probes = probesFor({ claim: claim(), subject, seed: 'rev:1', count: 4, askedAt: 't' });
        expect(probes.length).toBeGreaterThan(0);
        for (const probe of probes) {
            expect(['src/a.ts', 'src/b.ts']).toContain(probe.path);
            // The command must read the path — a probe whose answer is in the claim's own statement measures nothing.
            expect(probe.command).toContain(probe.path);
            expect(probe.command).not.toContain('the export is present');
        }
        // The digest probe asks for the recorded prefix, so answering it requires having hashed the file at this revision.
        const digest = probes.find((probe) => probe.kind === 'digest-prefix');
        expect(digest?.prefix).toBe(subject.pathDigests[digest!.path]!.slice(0, 8));
    });

    it('reports a claim with nothing to ask about rather than padding it', () => {
        // A dependency that is not in the subject is refused by the decision as unresolvable; asking about it would be a
        // question with one honest answer ("it is not there"), which measures nothing.
        const probes = probesFor({
            claim: claim({ dependsOn: ['path:src/deleted.ts'] }),
            subject,
            seed: 'rev:1',
            count: 2,
            askedAt: 't',
        });
        expect(probes).toEqual([]);
    });

    it('reports an unanswered question as null, not as zero', () => {
        expect(responseRate({ asked: 0, answered: 0 })).toBeNull();
        expect(responseRate({ asked: 4, answered: 1 })).toBe(0.25);
        // A rate above one would mean more answers than questions, which the store refuses; the clamp is for a caller that
        // computed its own counts.
        expect(responseRate({ asked: 2, answered: 5 })).toBe(1);
    });
});
