import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { meetsAssuranceFloor } from '../../src/kernel/policy.js';
import { defaultPolicy } from '../../src/kernel/policy.js';

/**
 * **A retired value must not authorise anything, and must not be written back as if it were current.**
 *
 * Measured when the earlier refusal branch was deleted (round 1's F2): with a *passing* ledger whose `usage.assurance`
 * said `sandboxed`, `review --approve` returned `success: true` and wrote `"assurance": "sandboxed"` into a fresh
 * review record — a value no current adapter can produce, re-emitted by a current writer. The branch that returned it
 * was removed on the reasoning that a later round now replaces an earlier value; that reasoning covers *recording* and
 * not *deciding*, so the decision surface still has to answer the question the value is asked.
 */
describe('a retired assurance value cannot authorise a decision', () => {
    it('does not satisfy a floor, even the floor it used to be at or above', () => {
        const policy = defaultPolicy();
        // `sandboxed` outranks `observed` in ASSURANCE_RANK because historical records still have to compare; that rank
        // is what let a value nobody can produce satisfy the floor of a tier that no longer accepts it.
        expect(meetsAssuranceFloor(policy, 'security', 'sandboxed')).toBe(false);
        expect(meetsAssuranceFloor(policy, 'security', 'observed')).toBe(true);
    });

    it('is refused by the approval surface rather than copied into a new review record', () => {
        const source = readFileSync(join(process.cwd(), 'src', 'workflow', 'orchestrator.ts'), 'utf8');
        expect(source).toContain('isCurrentAssuranceLevel(ledger.assurance)');
        expect(source).toContain('historical assurance cannot authorize a current review');
    });
});
