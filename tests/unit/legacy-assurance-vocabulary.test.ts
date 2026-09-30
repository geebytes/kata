import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensureAssurance, readLedger, reviewDir } from '../../src/store/ledger.js';
import { defaultPolicy } from '../../src/kernel/policy.js';

let root: string;
const changeId = 'historical-assurance';

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'kata-legacy-assurance-'));
    await mkdir(reviewDir(root, changeId), { recursive: true });
});

afterEach(async () => {
    await rm(root, { recursive: true, force: true });
});

/**
 * Retiring a writer vocabulary cannot erase an audit fact. A historical sandboxed
 * record is reportable, while a current observed round cannot manufacture or rewrite it.
 */
describe('historical assurance vocabulary', () => {
    it('reads and preserves sandboxed assurance without classifying the ledger unreadable', async () => {
        const usagePath = join(reviewDir(root, changeId), 'usage.json');
        const historical = { usage: {}, assurance: 'sandboxed' };
        await writeFile(usagePath, `${JSON.stringify(historical)}\n`);
        const currentPolicy = defaultPolicy();
        const historicalPolicy = {
            ...currentPolicy,
            tiers: { ...currentPolicy.tiers, security: { ...currentPolicy.tiers.security, assuranceFloor: 'sandboxed' } },
        };
        await writeFile(join(reviewDir(root, changeId), 'policy.json'), `${JSON.stringify(historicalPolicy)}\n`);

        const before = await readFile(usagePath, 'utf8');
        const ledger = await readLedger(root, changeId);
        expect(ledger.assurance).toBe('sandboxed');
        expect(ledger.malformedFiles).toEqual([]);
        expect(ledger.policy.tiers.security.assuranceFloor).toBe('sandboxed');
        expect(ledger.policyRejected).toBeNull();

        // A current adapter may not downgrade an old record or rewrite it into its own vocabulary.
        expect(await ensureAssurance(root, changeId, 'observed')).toBe('sandboxed');
        expect(await readFile(usagePath, 'utf8')).toBe(before);
    });
});
