import { describe, expect, it } from 'vitest';
import { probesFor, responseRate } from '../../src/kernel/discovery.js';
import { makeClaim, makeSubject } from '../helpers/review.js';

/**
 * **The generator asks distinct questions, and freezes each one to the revision it came from.**
 *
 * Measured on a real change: `ledger ask --per-claim 2` produced six probes of which three were duplicates — `P1-AC-1`
 * and `P2-AC-1` carried the same kind, the same path and therefore the same command. The floor read six, so answering one
 * question twice satisfied it, which is the one thing this mechanism exists to prevent: it is a *substitute credential*,
 * and a credential that a repeated answer satisfies is not a credential.
 *
 * The generator no longer emits a question it already asked within a claim, and each question records the revision whose
 * content it asks about. The count that reads those records is `tests/unit/discovery-count-projection.test.ts`, which owns
 * the projection; this suite owns the generator.
 */
const subject = makeSubject({ 'src/a.ts': 'holds', 'src/b.ts': 'other', 'src/c.ts': 'third' });

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

    it('freezes each question to the revision it was derived from', () => {
        // Without the revision on the record, an answer could be carried over to a subject the question says nothing about.
        const claim = makeClaim({ id: 'C1', dependsOn: ['path:src/a.ts', 'path:src/b.ts'] });
        const probes = probesFor({ claim, subject, seed: 'rev:test', count: 2, askedAt: '2026-09-27T00:00:00.000Z' });
        expect(probes.map((probe) => probe.subjectRevision)).toEqual([subject.revision, subject.revision]);
    });

    it('is reproducible: the same seed and surface ask the same questions', () => {
        // The reproducible draw is why a probe cannot be softened for the round being asked. De-duplication must not
        // introduce a dependency on arrival order.
        const claim = makeClaim({ id: 'C1', dependsOn: ['path:src/a.ts', 'path:src/b.ts', 'path:src/c.ts'] });
        const first = probesFor({ claim, subject, seed: 'rev:test', count: 3, askedAt: '2026-09-27T00:00:00.000Z' });
        const second = probesFor({ claim, subject, seed: 'rev:test', count: 3, askedAt: '2026-09-27T00:00:00.000Z' });
        expect(first.map((probe) => probe.command)).toEqual(second.map((probe) => probe.command));
    });

    it('keeps the response rate a rate over questions, not over records', () => {
        expect(responseRate({ asked: 0, answered: 0 })).toBeNull();
        expect(responseRate({ asked: 2, answered: 1 })).toBe(0.5);
    });
});
