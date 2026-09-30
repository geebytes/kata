import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runLedgerCommand } from '../../src/cli/ledger.js';
import { defaultPolicy } from '../../src/kernel/policy.js';
import { writePolicy } from '../../src/store/ledger.js';
import { ASSURANCE_LEVELS, LEGACY_ASSURANCE_LEVELS, READABLE_ASSURANCE_LEVELS } from '../../src/kernel/types.js';
import { validateArtefact } from '../../src/core/schema.js';

const root = join(import.meta.dirname, '..', '..');

/**
 * `sandboxed` is a retired Kata write-side value: the host platform, not Kata,
 * owns command isolation.  It remains in the historical read vocabulary only.
 */
describe('sandboxed retirement on the current write surface', () => {
    it('does not offer sandboxed as a current floor or CLI override', async () => {
        expect(defaultPolicy().tiers.security.assuranceFloor).toBe('observed');
        expect(ASSURANCE_LEVELS).not.toContain('sandboxed');

        const policy = defaultPolicy();
        await expect(writePolicy(root, 'retired-assurance-fixture', {
            ...policy,
            tiers: { ...policy.tiers, security: { ...policy.tiers.security, assuranceFloor: 'sandboxed' } },
        } as never)).rejects.toThrow('retired assurance floor');

        // **The read side, asserted as a read rather than as a word in a file.** The schema must still accept a
        // historical artefact, and the way to say that is to validate one — a `toContain('"sandboxed"')` on the schema
        // text stays green if the enum is later narrowed to a different member that happens to be spelled the same way
        // in a comment.
        const legacy = {
            revisionId: 'revision-0000000000000000',
            status: 'approved',
            findings: [],
            ledgerReview: {
                subjectRevision: 'rev:0000000000000000',
                tier: 'security',
                assurance: 'sandboxed',
                claims: 1,
                limits: ['this route does not establish who wrote the claims'],
            },
        };
        expect(() => validateArtefact('review', legacy)).not.toThrow();

        const previousExitCode = process.exitCode;
        process.exitCode = 0;
        try {
            await runLedgerCommand(['decide', '--assurance', 'sandboxed'], { root, changeId: 'retired-assurance-fixture' });
            expect(process.exitCode).toBe(1);
        } finally {
            process.exitCode = previousExitCode;
        }
    });
});

/**
 * **The write vocabulary itself, not only the call sites that read it.**
 *
 * `sandboxed` was removed from the write set before this round, and `signed` joined it afterwards: neither has an
 * adapter that can produce it, so neither may be offered as a floor. The guard for that is the vocabulary value, and
 * the mutation that has to redden is widening it again — an assertion about a call site stays green while the set is
 * the thing that actually moved.
 */
describe('the writable assurance vocabulary', () => {
    it('offers only values a current adapter can produce', () => {
        expect([...ASSURANCE_LEVELS]).toEqual(['none', 'relayed', 'observed']);
        expect([...LEGACY_ASSURANCE_LEVELS].sort()).toEqual(['sandboxed', 'signed']);
        expect([...READABLE_ASSURANCE_LEVELS].sort()).toEqual(['none', 'observed', 'relayed', 'sandboxed', 'signed']);
    });
});
