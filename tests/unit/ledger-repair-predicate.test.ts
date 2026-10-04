import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

function authorizerBody(source: string, name: string): string {
    const start = source.indexOf(`export async function ${name}`);
    expect(start).toBeGreaterThanOrEqual(0);
    const next = source.indexOf('\nexport async function ', start + 1);
    return source.slice(start, next === -1 ? undefined : next);
}

describe('ledger-deficit repair admission derivation', () => {
    it('has one ledger reader and delegates every gate authorizer to its shared admission predicate', async () => {
        const source = await readFile(new URL('../../src/workflow/repair-entry.ts', import.meta.url), 'utf8');

        expect(source).toContain('export async function ledgerDeficitRepairAdmission');
        expect([...source.matchAll(/\bledgerVerdict\(\{/g)]).toHaveLength(1);
        for (const name of ['authorizeVerifyRepair', 'authorizeReviewRepair', 'authorizeJudgeRepair']) {
            expect(authorizerBody(source, name)).toContain('await ledgerDeficitRepairAdmission(');
        }
    });
});
