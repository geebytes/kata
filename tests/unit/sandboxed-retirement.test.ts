import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runLedgerCommand } from '../../src/cli/ledger.js';
import { defaultPolicy } from '../../src/kernel/policy.js';
import { writePolicy } from '../../src/store/ledger.js';
import { ASSURANCE_LEVELS } from '../../src/kernel/types.js';

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

        const source = await readFile(join(root, 'src', 'cli', 'ledger.ts'), 'utf8');
        expect(source).toContain('isCurrentAssuranceLevel');
        expect(source).toContain('sandboxed is historical');

        const reviewSchema = await readFile(join(root, 'schemas', 'review.schema.json'), 'utf8');
        expect(reviewSchema).toContain('"sandboxed"'); // legacy review artefacts remain readable
        // The approval route needs no special case for a retired value: a later round replaces it (see
        // `legacy-assurance-vocabulary.test.ts`), so the state a guard would have refused cannot be reached by an
        // operator who re-runs. What the write surface must not offer is the value itself.
        const approval = await readFile(join(root, 'src', 'workflow', 'orchestrator.ts'), 'utf8');
        expect(approval).not.toContain("fabricated for a retired value");

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
