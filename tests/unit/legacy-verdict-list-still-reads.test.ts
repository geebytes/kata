import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendClaim, appendEvidence, freezeSubject, readLedger, reviewDir, verdictsPath, writeSubject } from '../../src/store/ledger.js';
import { makeClaim, makeEvidence } from '../helpers/review.js';

/**
 * **Every ledger in existence before this change has one verdict per evidence item, and it must keep deciding.**
 *
 * The readings list is keyed by `(evidence, run)` now; a document written before that has no run at all on its verdicts.
 * The reader treats those as one unattributed reading — the same grouping the quorum already used — so an old ledger reads
 * as one observation rather than as one per item, and nothing about its decision changes. This is the lesson the change that
 * found this defect paid for twice: **altering the shape a store writes alters the readability of what is already stored.**
 */
let root: string;
const changeId = 'legacy-verdicts';

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'kata-legacy-verdicts-'));
    await mkdir(join(root, '.kata', 'tasks', changeId), { recursive: true });
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src', 'a.ts'), 'holds\n');
    await writeFile(
        join(root, '.kata', 'tasks', changeId, 'task.json'),
        `${JSON.stringify({ id: changeId, ownedPaths: ['src/a.ts'], workflowProfile: { reviewMode: 'strict' } }, null, 2)}\n`,
    );
    const frozen = await freezeSubject({ root, paths: ['src/a.ts'] });
    if (!frozen.ok) throw new Error(frozen.error);
    await writeSubject(root, changeId, frozen.subject);
    await appendClaim(root, changeId, makeClaim({ id: 'C1', severity: 'major', evidenceIds: ['E1'], dependsOn: ['path:src/a.ts'] }));
    await appendEvidence(root, changeId, makeEvidence({ id: 'E1', type: 'executable_falsifier', command: 'true' }));
});

afterEach(async () => {
    await rm(root, { recursive: true, force: true });
});

describe('a document written before readings were per run', () => {
    it('reads the old shape without a producer, and answers the same way', async () => {
        // The old shape, written by hand: one entry per evidence item, no producer at all. Every ledger in existence before
        // this change looks like this, so a reader that cannot read it has destroyed the record.
        await mkdir(reviewDir(root, changeId), { recursive: true });
        await writeFile(
            verdictsPath(root, changeId),
            `${JSON.stringify([{ evidenceId: 'E1', evidenceType: 'executable_falsifier', verdict: 'supported', observed: 'exit 0', at: '2026-09-29T00:00:00.000Z', verifier: 'producers/verifiers#executable', subjectRevision: 'rev:old' }], null, 2)}\n`,
        );

        const ledger = await readLedger(root, changeId);
        expect(ledger.verdicts.map((entry) => entry.verdict)).toEqual(['supported']);
        expect(ledger.verdicts[0]?.evidenceId).toBe('E1');
    });
});
