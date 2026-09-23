import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * AC-2: a repair's disposition follows the rule the falsifier mechanism already established — and it must **consume** that rule
 * rather than restate it. A second copy of "the repair is done" is the class this whole line has spent a change on, so this
 * asserts there is one derivation and names where it lives.
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

    it('is reachable from the repair path the author is handed', () => {
        // The agent type is the repair author's entry point; if it does not name the rule, the author is asked to satisfy a
        // rule it was not told the shape of.
        const author = read('.pi/agents/kata-implementer.md');
        expect(author).toContain('redden');
        expect(author).toContain('recorded disposition');
    });
});
