import { describe, expect, it } from 'vitest';
import { resolveCheckForRow } from '../../src/quality/check-resolver.js';
import { collectEvidence } from '../../src/quality/evidence.js';
import { evidenceMatchesRow } from '../../src/quality/acceptance-matrix.js';
import type { AcceptanceMatrixRow } from '../../src/core/task.js';

/**
 * A declaration the project's own suite already covers records the pointer instead of running its own copy.
 *
 * Several acceptance rows re-run files the suite runs, which the notes measured as roughly a third of one seal's
 * evidence time. The covering check still runs — it is a real check — and the row is credited with its evidence, so
 * nothing is verified less; the row's own command simply is not executed a second time.
 */
describe('a check covered by another', () => {
    const row: AcceptanceMatrixRow = {
        acceptanceId: 'AC-1',
        implementationPaths: ['src/thing.py'],
        testPaths: ['tests/test_thing.py'],
        verificationLevel: 'unit',
        evidence: [{ id: 'row-check', kind: 'test', command: 'uv run pytest tests/test_thing.py', coveredBy: 'discovered:test' }],
    };

    it('carries the pointer onto the resolved check', () => {
        const check = resolveCheckForRow(row, row.evidence[0]!, '/tmp/root');
        expect(check).not.toBeInstanceOf(Error);
        expect(check).toMatchObject({ id: 'row-check', coveredBy: 'discovered:test' });
    });

    it('is not executed, and says so', async () => {
        const check = resolveCheckForRow(row, row.evidence[0]!, '/tmp/root');
        if (check instanceof Error) throw check;
        const events: Array<Record<string, unknown>> = [];

        const evidence = await collectEvidence('covered-task', [check], {
            onProgress: (event) => events.push(event as unknown as Record<string, unknown>),
        });

        // Nothing is recorded for a covered check: it did not run. The covering check's own envelope is what the row
        // is credited with, and the report names what was covered so the gap between "declared" and "ran" is visible.
        expect(evidence).toEqual([]);
        expect(events.find((event) => event.state === 'covered')).toMatchObject({ coveredBy: 'discovered:test' });
        expect(events.some((event) => event.state === 'started')).toBe(false);
    });

    it('credits the row with the covering check’s evidence', () => {
        // The covering check passed; the row is satisfied by it without having run its own command.
        expect(evidenceMatchesRow(row, 'make test', 'test', 'discovered:test')).toBe(true);
        // …and only by it: an unrelated check does not satisfy the row.
        expect(evidenceMatchesRow(row, 'make test', 'test', 'discovered:lint')).toBe(false);
    });
});
