import { mkdir, mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendClaim, appendEvidence, freezeSubject, readLedger, recordVerdicts, verdictsPath, writeSubject } from '../../src/store/ledger.js';
import { makeClaim, makeEvidence, makeVerdict } from '../helpers/review.js';
import type { EvidenceVerdict } from '../../src/kernel/types.js';

/**
 * **The store keeps what it was given; the projection is a view of it.**
 *
 * Two views come out of one read: `readings` is the document, `verdicts` is what each item currently counts as. The
 * distinction is the whole design — a consumer that wants "every run's reading" and one that wants "the answer" cannot both
 * be served by one list, which is why the store publishes both and the projection is computed in exactly one place.
 */
let root: string;
const changeId = 'nothing-lost';

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'kata-nothing-lost-'));
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

function reading(runId: string, actor: string, verdict: EvidenceVerdict['verdict'] = 'supported'): EvidenceVerdict {
    return { ...makeVerdict({ evidenceId: 'E1', verdict, at: '2026-09-29T00:00:00.000Z' }), producer: { runId, actor } };
}

describe('nothing recorded is dropped by reading it', () => {
    it('shows the document as it is, and never more entries than the document holds', async () => {
        await recordVerdicts(root, changeId, [reading('run-1', 'reviewer-a'), { ...reading('run-1', 'reviewer-a'), evidenceId: 'E1' }]);
        await recordVerdicts(root, changeId, [reading('run-2', 'reviewer-b', 'inconclusive')]);

        const stored = JSON.parse(await readFile(verdictsPath(root, changeId), 'utf8')) as EvidenceVerdict[];
        const ledger = await readLedger(root, changeId);
        // The readings list *is* the document: a reader that disagreed with it would be reading something else.
        expect(ledger.readings).toHaveLength(stored.length);
        // And the projection is a view of the same bytes: one entry per evidence item, never more.
        expect(ledger.verdicts.length).toBeLessThanOrEqual(ledger.readings.length);
        expect(ledger.verdicts.map((entry) => entry.evidenceId)).toEqual(['E1']);
    });
});
