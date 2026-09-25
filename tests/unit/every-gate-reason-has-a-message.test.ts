import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * **Every member of the gate's reason union has a message** — `r7-f-reason-members`, and the class is closed rather than the four
 * instances.
 *
 * `adversarialReasonFor` is a switch over `AdversarialGateReason`, and four members had no case: they fell to `default: 'The
 * independent adversarial pass is not satisfied.'`, so the operator read a sentence with no remedy and had to open the JSON to find
 * which path or capability was refused. A reason the gate can return and this function cannot explain is a refusal whose remedy is
 * hidden.
 *
 * The union is **read from the source**, not restated here: a hand-written list is what let the members go missing, and a case
 * declared for a member the switch does not have is the same defect from the other side.
 */
describe('every gate reason has a message', () => {
    it('names a case for each member of the union, and none for a member that does not exist', () => {
        const source = readFileSync(join(process.cwd(), 'src/quality/adversarial.ts'), 'utf8');
        const union = source.slice(source.indexOf('export type AdversarialGateReason'), source.indexOf(';', source.indexOf('export type AdversarialGateReason')));
        const members = [...union.matchAll(/\|\s*'([a-z_]+)'/g)].map((m) => m[1]);
        expect(members.length).toBeGreaterThan(8);
        const reasonFn = source.slice(source.indexOf('export function adversarialReasonFor'));
        const cases = new Set([...reasonFn.matchAll(/case '([a-z_]+)'/g)].map((m) => m[1]));
        const missing = members.filter((member) => !cases.has(member));
        expect(missing).toEqual([]);
        const invented = [...cases].filter((name) => !members.includes(name));
        expect(invented).toEqual([]);
    });
});
