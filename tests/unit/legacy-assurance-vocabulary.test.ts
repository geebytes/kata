import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensureAssurance, readLedger, reviewDir } from '../../src/store/ledger.js';
import { initLayout } from '../../src/core/layout.js';
import { createTask } from '../../src/core/task.js';
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

        // **Reading is not deciding.** A reader preserves what the file says: the current assurance stays `sandboxed`
        // and the document is not rewritten by the act of reading it. What a later round *writes* is a separate
        // question, answered by the case below — a retired value must not outrank the round that just ran.
        expect(await readFile(usagePath, 'utf8')).toBe(before);
        expect(ledger.assurance).toBe('sandboxed');
    });
});

/**
 * A retired value that outranks every later round is a value that decides the gate for ever.
 *
 * Measured before this fix: an approval refused the change and dispatched "re-run the verification so Kata records
 * current observed assurance", and re-running returned the same `sandboxed` byte for byte, because `ensureAssurance`
 * kept the stronger of the two and no command removes a ledger file. The state the refusal named as its remedy was
 * therefore unreachable.
 */
describe('a recorded round replaces a recorded round', () => {
    it('lets a later observed round replace a retired sandboxed value, keeping the value as history', async () => {
        const replaceRoot = await mkdtemp(join(tmpdir(), 'kata-assurance-replace-'));
        const replaceChange = 'replace-fixture';
        try {
            await initLayout(replaceRoot);
            await createTask({
                root: replaceRoot,
                id: replaceChange,
                title: 'replace fixture',
                acceptance: [{ id: 'AC-1', statement: 'a recorded round replaces a recorded round' }],
                ownedPaths: ['src/store/ledger.ts'],
                workflowProfile: {
                    version: 1, isolationMode: 'current_worktree', developmentMode: 'tdd', reviewMode: 'strict',
                    comet: { projectInit: 'not_requested', openStatus: 'acknowledged' },
                },
            });
            await ensureAssurance(replaceRoot, replaceChange, 'observed');
            await writeFile(
                join(reviewDir(replaceRoot, replaceChange), 'usage.json'),
                `${JSON.stringify({ usage: {}, assurance: 'sandboxed' })}\n`,
                'utf8',
            );

            expect(await ensureAssurance(replaceRoot, replaceChange, 'observed')).toBe('observed');
            const written = JSON.parse(await readFile(join(reviewDir(replaceRoot, replaceChange), 'usage.json'), 'utf8')) as {
                assurance: string;
                assuranceHistory: Array<{ replaced: string }>;
            };
            expect(written.assurance).toBe('observed');
            // The retired value is not erased: it becomes history rather than the current assurance.
            expect(written.assuranceHistory.map((entry) => entry.replaced)).toEqual(['sandboxed']);
        } finally {
            await rm(replaceRoot, { recursive: true, force: true });
        }
    });
});
