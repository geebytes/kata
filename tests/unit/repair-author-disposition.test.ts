import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The repair disposition has **one** derivation, and the closure criterion consumes it rather than restating it. A second copy of
 * "the repair is done" is the class this whole line has spent a change on, so this asserts there is one derivation and names
 * where it lives.
 *
 * **This is not AC-2's check, and its old docstring said it was** (`rba7-8df1f72e`). AC-2's declared selector is
 * `tests/unit/repair-author-consumes-the-rule.test.ts`; AC-2 was corrected (`declaration-corrections.json`, by user
 * 2026-09-24T00:09:21Z) to be about the tool that writes the repair record, and a later correction (2026-09-24T07:15:45Z)
 * restored the disposition clause into it. What this file pins is the *rule* the criterion asks — the reddening/absence
 * decision and its single derivation — which is `closure-gate`'s subject, not this change's deliverable. Naming the wrong
 * criterion here was itself a small instance of the class: a check claiming a criterion it does not measure.
 */
describe('the repair disposition has one derivation, and it is consumed rather than restated', () => {
    const read = (path: string) => readFileSync(join(process.cwd(), path), 'utf8');

    it('decides it in one function, which both shapes go through', () => {
        const ledger = read('src/quality/falsifier-reddenings.ts');
        // The one place that answers it, and it answers with both shapes: a reddening, or a recorded absence with a reason.
        expect(ledger).toContain('export function hasFalsifierDisposition(');
        expect(ledger).toContain('export function hasReddening(');
        expect(ledger).toContain('absence.reason.trim().length > 0');
    });

    it('is consumed by the criterion rather than copied', () => {
        const criterion = read('src/quality/repair-obligations.ts');
        expect(criterion).toContain('hasFalsifierDisposition(');
        // No second decision: the criterion must not grow its own reddening or absence test.
        expect(criterion).not.toMatch(/reddening\.observed/);
        expect(criterion).not.toMatch(/absence\.reason/);
    });

    it('is consumed at the repair-author write too, so the record cannot claim a disposition it has not met', () => {
        // `rba4-f2`'s other half, and it is the clause AC-2's later correction restored: the author record is refused when the
        // finding has neither a reddening nor an absence, and it records **which shape** closed the disposition by asking the
        // same function the criterion asks rather than testing for a record's presence.
        const writer = read('src/quality/repair-author.ts');
        expect(writer).toContain('hasFalsifierDisposition(');
        expect(writer).toContain('hasReddening(');
    });

    it('is reachable from the repair path the author is handed', () => {
        // The agent type is the repair author's entry point; if it does not name the rule, the author is asked to satisfy a
        // rule it was not told the shape of.
        const author = read('.pi/agents/kata-implementer.md');
        expect(author).toContain('redden');
        expect(author).toContain('recorded disposition');
    });
});
