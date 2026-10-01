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


    it('refuses a floor value it does not recognise instead of rewriting it', async () => {
        // R9-F4: the fill condition was `!isCurrentAssuranceLevel(floor)`, so any unknown string was silently rewritten to
        // the tier default — `bogus_value` read back as `observed` with `policyFilled` naming it — while `42` at the same
        // position was refused by the schema. A reader may be lenient about *history* (the retired set); rewriting a value
        // nobody ever wrote is inventing policy, and it is the silent direction.
        const policy = defaultPolicy();
        const unknown = await ledgerWithPolicy({
            ...policy,
            tiers: { ...policy.tiers, strict: { ...policy.tiers.strict, assuranceFloor: 'bogus_value' } },
        });
        expect(unknown.policyRejected ?? unknown.malformedReasons['policy.json']).toBeTruthy();

        // The non-string case, which was already refused, stays refused.
        const notAString = await ledgerWithPolicy({
            ...policy,
            tiers: { ...policy.tiers, strict: { ...policy.tiers.strict, assuranceFloor: 42 } },
        });
        expect(notAString.policyRejected ?? notAString.malformedReasons['policy.json']).toBeTruthy();

        // And the genuinely retired value is still filled, with its fill named.
        const retired = await ledgerWithPolicy({
            ...policy,
            tiers: { ...policy.tiers, security: { ...policy.tiers.security, assuranceFloor: 'sandboxed' } },
        });
        expect(retired.malformedFiles).toEqual([]);
        expect(retired.policyFilled).toContain('tiers.security.assuranceFloor');
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

    it('names the retired floor it substituted, instead of filling silently', async () => {
        // R8-F9: the reader substitutes a retired floor before validating, and the comment said the substitution was
        // "named in `policyFilled`" — it was not: only the schema check saw the substitute, so the policy read back with an
        // empty `policyFilled` and the one rule this file states about fills did not hold on this path.
        const policy = defaultPolicy();
        const ledger = await ledgerWithPolicy({
            ...policy,
            tiers: { ...policy.tiers, security: { ...policy.tiers.security, assuranceFloor: 'sandboxed' } },
        });
        expect(ledger.malformedFiles).toEqual([]);
        // R10-F6: the fill keeps the *stricter* of the historical floor and the tier default, so `sandboxed` (rank 3) is
        // kept above `observed` (rank 2) instead of being silently weakened to it: a reader may not lower a gate while
        // reporting that it only filled a field. The fill is still named.
        expect(ledger.policy.tiers.security.assuranceFloor).toBe('sandboxed');
        expect(ledger.policyFilled).toContain('tiers.security.assuranceFloor');
    });

    it("keeps a rolling tier historical floor when the tier default would be weaker", async () => {
        // The `standard` tier's default is `none`, so replacing a historical `sandboxed` with it would *lower* the gate —
        // the direction R10-F6 named. The conservative reading keeps the stronger value.
        const policy = defaultPolicy();
        const ledger = await ledgerWithPolicy({
            ...policy,
            tiers: { ...policy.tiers, standard: { ...policy.tiers.standard, assuranceFloor: 'sandboxed' } },
        });
        expect(ledger.malformedFiles).toEqual([]);
        expect(ledger.policy.tiers.standard.assuranceFloor).toBe('sandboxed');
        expect(ledger.policyFilled).toContain('tiers.standard.assuranceFloor');
    });
});
