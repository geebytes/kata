import { mkdir, mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
    appendClaim,
    appendEvidence,
    freezeSubject,
    readLedger,
    recordVerdicts,
    reviewDir,
    verdictsPath,
    writeSubject,
} from '../../src/store/ledger.js';
import { makeClaim, makeEvidence, makeVerdict } from '../helpers/review.js';
import type { EvidenceVerdict } from '../../src/kernel/types.js';

/**
 * **A reading is a fact about a run, and recording another run's reading must not erase it.**
 *
 * Measured on a real change: the `security` tier requires two independent reviewers, a second independent reading was
 * recorded in full (six verdicts, `supported`), and the ledger still reported one reviewer. The cause was in this store —
 * `recordVerdicts` replaced by `evidenceId`, so the second run's reading overwrote the first and `groupByProducer` could
 * only ever see one run. The store's job is to keep what was observed; deciding what it adds up to is the kernel's.
 */
let root: string;
const changeId = 'readings-fixture';

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'kata-readings-'));
    await mkdir(join(root, '.kata', 'tasks', changeId), { recursive: true });
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src', 'a.ts'), 'holds\n');
    await writeFile(
        join(root, '.kata', 'tasks', changeId, 'task.json'),
        `${JSON.stringify({ id: changeId, ownedPaths: ['src/a.ts'], workflowProfile: { reviewMode: 'strict' } }, null, 2)}\n`,
    );
});

afterEach(async () => {
    await rm(root, { recursive: true, force: true });
});

/** A frozen subject, one claim and one evidence item, so a verdict has something to be about. */
async function seededLedger(): Promise<void> {
    const frozen = await freezeSubject({ root, paths: ['src/a.ts'] });
    if (!frozen.ok) throw new Error(frozen.error);
    await writeSubject(root, changeId, frozen.subject);
    await appendClaim(root, changeId, makeClaim({ id: 'C1', severity: 'major', evidenceIds: ['E1'], dependsOn: ['path:src/a.ts'] }));
    await appendEvidence(root, changeId, makeEvidence({ id: 'E1', type: 'executable_falsifier', command: 'true', mutation: { file: 'src/a.ts', find: 'holds', replace: 'held' } }));
}

function reading(runId: string, actor: string, verdict: EvidenceVerdict['verdict'] = 'supported', at = '2026-09-29T00:00:00.000Z'): EvidenceVerdict {
    return { ...makeVerdict({ evidenceId: 'E1', verdict, at }), producer: { runId, actor } };
}

describe('a reading belongs to the run that took it', () => {
    it('keeps both readings when two runs decide the same evidence, each with its own producer', async () => {
        await seededLedger();
        await recordVerdicts(root, changeId, [reading('run-1', 'reviewer-a')]);
        await recordVerdicts(root, changeId, [reading('run-2', 'reviewer-b')]);

        const ledger = await readLedger(root, changeId);
        const runs = ledger.readings.map((entry) => entry.producer?.runId).sort();
        expect(runs).toEqual(['run-1', 'run-2']);
        // And each reading still names the actor that produced it, which is the only independence signal a ledger holds.
        expect(ledger.readings.map((entry) => entry.producer?.actor).sort()).toEqual(['reviewer-a', 'reviewer-b']);
    });

    it('treats a second record by the same run as idempotent rather than as a second reading', async () => {
        await seededLedger();
        await recordVerdicts(root, changeId, [reading('run-1', 'reviewer-a')]);
        await recordVerdicts(root, changeId, [reading('run-1', 'reviewer-a', 'refuted')]);

        const ledger = await readLedger(root, changeId);
        expect(ledger.readings).toHaveLength(1);
        // The run's later answer is the run's answer: re-deciding is not a second observation of a different kind.
        expect(ledger.readings[0]?.verdict).toBe('refuted');
    });

    it('loses nothing: what the document holds, the reader shows', async () => {
        await seededLedger();
        await recordVerdicts(root, changeId, [reading('run-1', 'reviewer-a'), { ...reading('run-1', 'reviewer-a'), evidenceId: 'E1' }]);
        await recordVerdicts(root, changeId, [reading('run-2', 'reviewer-b', 'inconclusive')]);

        const stored = JSON.parse(await readFile(verdictsPath(root, changeId), 'utf8')) as EvidenceVerdict[];
        const ledger = await readLedger(root, changeId);
        expect(ledger.readings).toHaveLength(stored.length);
        // The projection is a view, not a store: it never has more entries than there are evidence items.
        expect(ledger.verdicts.length).toBeLessThanOrEqual(ledger.readings.length);
        expect(ledger.verdicts.map((entry) => entry.evidenceId)).toEqual(['E1']);
    });
});
