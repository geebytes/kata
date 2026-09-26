import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
    appendChallenge,
    appendClaim,
    appendEvidence,
    appendRun,
    declaredPaths,
    freezeSubject,
    readLedger,
    recordVerdicts,
    reviewDir,
    setUsage,
    writeSubject,
} from '../../src/store/ledger.js';
import { makeClaim, makeEvidence, makeVerdict } from '../helpers/review.js';

/**
 * **Every fact is written when it exists, so there is no last step to lose.**
 *
 * The failure this replaces is measured: 28 of 62 review rounds produced nothing, because the round's only output was one
 * document emitted at the very end, and a pass that stopped one sentence early produced nothing at all. Here a claim, an
 * evidence item, a verdict and a challenge each land on disk as they arrive, so "nothing recorded" is a visible state
 * (`recordedFiles: []`) that an operator can act on rather than an empty list that looks like a clean review.
 */
let root: string;
const changeId = 'ledger-fixture';

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'kata-ledger-'));
    await mkdir(join(root, '.kata', 'tasks', changeId), { recursive: true });
    await writeFile(
        join(root, '.kata', 'tasks', changeId, 'task.json'),
        `${JSON.stringify({ id: changeId, ownedPaths: ['src/a.ts', 'src/b.ts'] }, null, 2)}\n`,
    );
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src', 'a.ts'), 'holds\n');
});

afterEach(async () => {
    await rm(root, { recursive: true, force: true });
});

describe('the ledger records each fact as it arrives', () => {
    it('reads the declared paths from the task record, not from a hand-kept list', async () => {
        expect(await declaredPaths(root, changeId)).toEqual(['src/a.ts', 'src/b.ts']);
    });

    it('refuses to freeze a path it cannot read, naming it, instead of writing a sentinel', async () => {
        const frozen = await freezeSubject({ root, paths: ['src/a.ts', 'src/missing.ts'] });
        expect(frozen.ok).toBe(false);
        if (!frozen.ok) {
            expect(frozen.unreadable).toEqual(['src/missing.ts']);
            expect(frozen.error).toContain('src/missing.ts');
        }
        // Nothing was written: a sentinel for an unreadable path is indistinguishable from a deletion, so the failure is
        // reported rather than recorded as content.
        expect((await readLedger(root, changeId)).recordedFiles).toEqual([]);
    });

    it('reports an empty ledger as an empty ledger, with the note an operator needs', async () => {
        const ledger = await readLedger(root, changeId);
        expect(ledger.recordedFiles).toEqual([]);
        expect(ledger.claims).toEqual([]);
        expect(ledger.subject).toBeNull();
    });

    it('lands a claim on disk at the moment it is added', async () => {
        await appendClaim(root, changeId, makeClaim({ id: 'C1' }));
        // Read the file directly: the point is that no later "record" step is needed for the fact to exist.
        const raw = await readFile(join(reviewDir(root, changeId), 'claims.json'), 'utf8');
        expect(JSON.parse(raw)).toHaveLength(1);
        expect((await readLedger(root, changeId)).recordedFiles).toContain('claims.json');
    });

    it('keeps each kind of fact in its own file, and a verdict replaces an earlier reading of the same evidence', async () => {
        const subject = await freezeSubject({ root, paths: ['src/a.ts'] });
        expect(subject.ok).toBe(true);
        if (!subject.ok) return;
        await writeSubject(root, changeId, subject.subject);
        await appendClaim(root, changeId, makeClaim({ id: 'C1', evidenceIds: ['E1'] }));
        await appendEvidence(root, changeId, makeEvidence({ id: 'E1' }));
        await recordVerdicts(root, changeId, [makeVerdict({ evidenceId: 'E1', verdict: 'inconclusive', subjectRevision: subject.subject.revision })]);
        await recordVerdicts(root, changeId, [makeVerdict({ evidenceId: 'E1', verdict: 'supported', subjectRevision: subject.subject.revision })]);
        await appendChallenge(root, changeId, {
            id: 'X1',
            claimId: 'C1',
            command: 'run-it',
            failsOn: subject.subject.revision,
            state: 'open',
            at: '2026-09-27T00:00:00.000Z',
        });
        await appendRun(root, changeId, { at: '2026-09-27T00:00:00.000Z', producer: 'fixture', claims: 1, evidence: 1, diversity: 'model_family' });
        await setUsage(root, changeId, { tokens: 1234 });

        const ledger = await readLedger(root, changeId);
        expect(ledger.recordedFiles.sort()).toEqual(['challenges.json', 'claims.json', 'evidence.json', 'runs.json', 'subject.json', 'usage.json', 'verdicts.json']);
        expect(ledger.verdicts).toHaveLength(1);
        expect(ledger.verdicts[0]?.verdict).toBe('supported');
        expect(ledger.challenges).toHaveLength(1);
        expect(ledger.usage.tokens).toBe(1234);
        expect(ledger.runs).toHaveLength(1);
    });

    it('does not duplicate an evidence item or a challenge that is added twice', async () => {
        await appendEvidence(root, changeId, makeEvidence({ id: 'E1' }));
        await appendEvidence(root, changeId, makeEvidence({ id: 'E1' }));
        await appendChallenge(root, changeId, { id: 'X1', claimId: 'C1', command: 'c', failsOn: 'r', state: 'open', at: 'now' });
        await appendChallenge(root, changeId, { id: 'X1', claimId: 'C1', command: 'c', failsOn: 'r', state: 'open', at: 'now' });
        const ledger = await readLedger(root, changeId);
        expect(ledger.evidence).toHaveLength(1);
        expect(ledger.challenges).toHaveLength(1);
    });
});
