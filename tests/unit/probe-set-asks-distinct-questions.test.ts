import { describe, expect, it } from 'vitest';
import { probesFor, responseRate, type ProbeAnswer } from '../../src/kernel/discovery.js';
import { verifiedChallengeCount } from '../../src/store/verdict.js';
import { makeClaim, makeSubject } from '../helpers/review.js';

/**
 * **The discovery floor counts independent readings, and repetition is not one.**
 *
 * Measured on a real change: `ledger ask --per-claim 2` produced six probes of which three were duplicates — `P1-AC-1`
 * and `P2-AC-1` carried the same kind, the same path and therefore the same command. The floor read six, so answering one
 * question twice satisfied it, which is the one thing this mechanism exists to prevent: it is a *substitute credential*,
 * and a credential that a repeated answer satisfies is not a credential.
 *
 * Two fixes, because one would leave the other exposed: the generator no longer emits a question it already asked, and the
 * count is over distinct questions rather than over records, so a hand-written or pre-fix list cannot pad it either.
 */
const subject = makeSubject({ 'src/a.ts': 'holds', 'src/b.ts': 'other', 'src/c.ts': 'third' });

function answersOf(commands: string[]): ProbeAnswer[] {
    return commands.map((command, index) => ({ probeId: `P${index}`, command, observed: 'exit 0', answeredAt: '2026-09-27T00:00:00.000Z' }));
}

describe('a probe set asks distinct questions', () => {
    it('does not ask the same question twice when more questions are requested than the surface distinguishes', () => {
        const claim = makeClaim({ id: 'C1', dependsOn: ['path:src/a.ts'] });
        const probes = probesFor({ claim, subject, seed: 'rev:test', count: 4, askedAt: '2026-09-27T00:00:00.000Z' });
        // One path, two kinds: at most two distinct questions exist, so four are asked for and fewer are asked.
        const commands = probes.map((probe) => probe.command);
        expect(new Set(commands).size).toBe(commands.length);
        expect(probes.length).toBeLessThan(4);
        expect(probes.length).toBeGreaterThan(0);
    });

    it('asks the number requested when the surface can distinguish them', () => {
        const claim = makeClaim({ id: 'C1', dependsOn: ['path:src/a.ts', 'path:src/b.ts', 'path:src/c.ts'] });
        const probes = probesFor({ claim, subject, seed: 'rev:test', count: 2, askedAt: '2026-09-27T00:00:00.000Z' });
        expect(probes).toHaveLength(2);
        expect(new Set(probes.map((probe) => probe.command)).size).toBe(2);
    });

    it('is reproducible: the same seed and surface ask the same questions', () => {
        // The reproducible draw is why a probe cannot be softened for the round being asked. De-duplication must not
        // introduce a dependency on arrival order.
        const claim = makeClaim({ id: 'C1', dependsOn: ['path:src/a.ts', 'path:src/b.ts', 'path:src/c.ts'] });
        const first = probesFor({ claim, subject, seed: 'rev:test', count: 3, askedAt: '2026-09-27T00:00:00.000Z' });
        const second = probesFor({ claim, subject, seed: 'rev:test', count: 3, askedAt: '2026-09-27T00:00:00.000Z' });
        expect(first.map((probe) => probe.command)).toEqual(second.map((probe) => probe.command));
    });

    it('counts one reading when one command is answered twice', () => {
        // Defence in depth: whatever wrote the list, the floor and the rate read distinct questions.
        const repeated = answersOf(['test -f src/a.ts', 'test -f src/a.ts', 'test -f src/b.ts']);
        expect(verifiedChallengeCount([], repeated)).toBe(2);
        expect(responseRate({ asked: distinct(repeated.map((answer) => answer.command)), answered: distinct(repeated.map((answer) => answer.command)) })).toBe(1);
        // The rate over records would have read 3/3 and over questions 2/2 — both 1 here, so the interesting number is the
        // answered count, which the floor uses.
        expect(verifiedChallengeCount([], answersOf(['a', 'b', 'c']))).toBe(3);
    });

    it('counts a terminal observation whether or not it previously reproduced, while rejecting open and unobserved records', () => {
        const observed = [{ id: 'X1', claimId: 'C1', command: 'grep -q holds src/a.ts', failsOn: 'rev:test', state: 'withdrawn' as const, at: 'x', resolution: { at: 'y', observed: 'exit 0' } }];
        expect(verifiedChallengeCount(observed, [])).toBe(1);
        expect(verifiedChallengeCount([{ ...observed[0]!, reproduced: true }], [])).toBe(1);
        expect(verifiedChallengeCount([{ ...observed[0]!, state: 'open' as const }], [])).toBe(0);
        expect(verifiedChallengeCount([{ ...observed[0]!, resolution: { at: 'y', observed: '  ' } }], [])).toBe(0);
    });
});

function distinct(values: string[]): number {
    return new Set(values).size;
}
