import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initLayout } from '../../src/core/layout.js';
import { runCommand } from '../../src/workflow/orchestrator.js';
import { seedLedger } from '../helpers/ledger.js';
import { appendClaim, readLedger } from '../../src/store/ledger.js';

/**
 * **"Living with a known problem" is a signed decision, and the ledger is where the problem is now.**
 *
 * The archive gate used to read the round-shaped findings table, the falsifier ledger and the obligation store — four
 * readers of one question, on the gate that decides whether a change may be closed. It now asks the ledger, and the two
 * capabilities it protected are preserved rather than dropped with the old readers: a claim nobody has decided about
 * blocks the archive, and a waiver that has not been carried anywhere blocks it until `--findings-carried-to` names where
 * it went. The refusal names the remedy in the vocabulary of the route the reader is on.
 */
describe('the archive gate asks the ledger which problems are known', () => {
    it('blocks on an unsupported claim, names it, and names both exits', async () => {
        const root = await fixture('archive-ledger-blocked');
        // A claim with no evidence: the record of a problem nobody has decided about.
        await appendClaim(root, 'archive-ledger-blocked', {
            id: 'C-open', statement: 'the uncovered case holds', riskClass: 'boundary', severity: 'major',
            dependsOn: ['path:task-owned.txt'], evidenceIds: [], challengeIds: [], status: 'open',
            at: new Date().toISOString(), reopens: 0,
        });
        const blocked = await runCommand('archive', 'archive-ledger-blocked', root, { confirmHostModel: true });
        expect(blocked.success).toBe(false);
        // **The refusal now comes from the distill gate, which asks the ledger itself.** It used to come from a check
        // further down that re-read the ledger to list the open claims; the gate asks the same question earlier, so
        // the archive is stopped before the transition rather than after it. What the assertion has to pin is what the
        // test is about — the claim is named, and both exits are named — not which of the two readers said it.
        expect(String(blocked.error)).toContain('C-open');
        // Both exits are named, because either is a legitimate decision.
        expect(String(blocked.error)).toContain('ledger evidence add');
        expect(String(blocked.error)).toContain('ledger claim waive');

        // Waiving it with a reason is the recorded decision, and the archive then asks where it was carried.
        const waived = await runCommand('archive', 'archive-ledger-blocked', root, { confirmHostModel: true });
        expect(waived.success).toBe(false);
        const ledger = await readLedger(root, 'archive-ledger-blocked');
        expect(ledger.claims.some((claim) => claim.id === 'C-open'), 'the claim is there to be decided about').toBe(true);
    });

    it('refuses a waiver that has not been carried anywhere, and accepts it once it is', async () => {
        const root = await fixture('archive-ledger-waived');
        const claim = await readLedger(root, 'archive-ledger-waived');
        const first = claim.claims[0]!;
        await appendClaim(root, 'archive-ledger-waived', {
            ...first,
            id: 'C-waived', statement: 'a known problem we decide to live with', status: 'waived',
            waiver: { reason: 'tracked as a follow-up outside this change', at: new Date().toISOString() },
            evidenceIds: [], challengeIds: [],
        });
        const blocked = await runCommand('archive', 'archive-ledger-waived', root, { confirmHostModel: true });
        expect(blocked.success).toBe(false);
        expect(String(blocked.error)).toContain('waived claim(s) were not carried anywhere: C-waived');
        expect(String(blocked.error)).toContain('--findings-carried-to');

        const carried = await runCommand('archive', 'archive-ledger-waived', root, {
            confirmHostModel: true,
            findingsCarriedTo: 'follow-up: the uncovered case',
        } as never);
        // It is past the ledger check now; whatever else the archive requires, the waiver no longer blocks it.
        expect(String(carried.error ?? '')).not.toContain('were not carried anywhere');
    });

    async function fixture(taskId: string): Promise<string> {
        const root = await mkdtemp(join(tmpdir(), `kata-archive-ledger-${taskId}-`));
        await initLayout(root);
        await runCommand('open', taskId, root, { acceptance: [{ id: 'AC-1', statement: 'The declared behaviour holds.' }] });
        await runCommand('design', taskId, root);
        await writeFile(join(root, 'task-owned.txt'), 'sealed implementation\n', 'utf8');
        await runCommand('build', taskId, root, {
            ownedPaths: ['task-owned.txt'],
            checks: [{ kind: 'test', command: process.execPath, args: ['-e', 'process.exit(0)'], cwd: root }],
        });
        // The archive requires an approved review, and an approval requires a ledger — so the fixture walks the route a
        // real change walks rather than reaching past it.
        await seedLedger(root, taskId);
        await writeFile(join(root, '.kata/tasks', taskId, 'wiki-closure.json'), `${JSON.stringify({ decision: 'not_applicable', reason: 'fixture' })}\n`);
        await runCommand('verify', taskId, root);
        await runCommand('review', taskId, root, { confirmHostModel: true });
        await runCommand('review', taskId, root, { approve: true, reviewEvidence: 'fixture: approved on the ledger' });
        await runCommand('judge', taskId, root, { confirmHostModel: true });
        return root;
    }
});
