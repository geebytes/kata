import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultPolicy } from '../../src/kernel/policy.js';
import { readLedger, reviewDir } from '../../src/store/ledger.js';

/**
 * **The exemption for a retired floor covers that field, not the whole document.**
 *
 * Measured before this fix: with a policy carrying a legitimate retired `sandboxed` floor, a *different* schema
 * violation (a reviewer count of `1.5`) was accepted — the schema check was skipped for the entire document, so the
 * exemption for one retired value became permission for every other violation to pass unnoticed. The same document with
 * a current floor was reported `unreadable`.
 */
async function ledgerWithPolicy(tiers: unknown): Promise<Awaited<ReturnType<typeof readLedger>>> {
    const root = await mkdtemp(join(tmpdir(), 'kata-floor-exemption-'));
    const changeId = 'exemption-fixture';
    const dir = reviewDir(root, changeId);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'policy.json'), `${JSON.stringify(tiers)}\n`);
    const ledger = await readLedger(root, changeId);
    await rm(root, { recursive: true, force: true });
    return ledger;
}

describe('a historical floor exempts the floor field only', () => {
    it('still reports a different schema violation in the same document', async () => {
        const policy = defaultPolicy();
        const retiredFloor = {
            ...policy,
            tiers: {
                ...policy.tiers,
                security: { ...policy.tiers.security, assuranceFloor: 'sandboxed' },
                strict: { ...policy.tiers.strict, reviewers: 1.5 },
            },
        };
        const ledger = await ledgerWithPolicy(retiredFloor);
        expect(ledger.malformedFiles).toContain('policy.json');
    });

    it('accepts a document that is valid apart from the retired floor', async () => {
        const policy = defaultPolicy();
        const retiredFloorOnly = {
            ...policy,
            tiers: { ...policy.tiers, security: { ...policy.tiers.security, assuranceFloor: 'sandboxed' } },
        };
        const ledger = await ledgerWithPolicy(retiredFloorOnly);
        expect(ledger.malformedFiles).toEqual([]);
    });
});
