import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultPolicy } from '../../src/kernel/policy.js';

const root = join(import.meta.dirname, '..', '..');
const transitionRecord = join(root, 'docs', 'design', '2026-09-30-security-tier-platform-boundary.md');

/**
 * The migration is a one-time human policy decision, not a fabricated sandboxed
 * ledger pass. The record lives in an owned document, so the seal binds it to this
 * revision together with the policy it authorizes.
 */
describe('security policy transition record', () => {
    it('records the bound one-time authorization and the policy it authorizes', async () => {
        const record = await readFile(transitionRecord, 'utf8');

        expect(record).toContain('## 8. Migration record');
        expect(record).toContain('security-tier-platform-boundary');
        expect(record).toContain('Decision: user authorization');
        expect(record).toContain('Previous floor: `sandboxed`');
        expect(record).toContain('New floor: `observed`');
        expect(record).toContain('does not authorize any later change');
        expect(defaultPolicy().tiers.security.assuranceFloor).toBe('observed');
    });
});
