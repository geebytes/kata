import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendClaim, appendEvidence, readLedger, recordVerdicts, reviewDir, ensureAssurance, freezeSubject, writeSubject } from '../../src/store/ledger.js';
import { ledgerVerdict } from '../../src/store/verdict.js';
import { readUpstreamSummary, suggestCandidateAction } from '../../src/workflow/navigation.js';
import { makeClaim, makeEvidence, makeVerdict } from '../helpers/review.js';

/**
 * **The ledger decides the ladder's next action, and its absence is a fact rather than a fallback nobody can see.**
 *
 * The wiring is the point of the whole subsystem: evidence that ends in a report nobody acts on is paperwork. Three states
 * are distinguished here, because they mean different things — a ledger that decides and does not pass sends the change to
 * repair with the kernel's own deficits; a ledger that exists and cannot be parsed refuses rather than looking like a
 * change with no ledger; and a change with no ledger at all keeps the route it had before, which is what lets the old path
 * be retired one change at a time instead of all at once.
 */
let root: string;
const changeId = 'ladder-fixture';

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'kata-ladder-'));
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

async function ladderReason(): Promise<string> {
    const summary = await readUpstreamSummary(root, changeId);
    return suggestCandidateAction('review', summary).reason;
}

describe('the ledger gates the ladder', () => {
    it('reports absence as absence, and leaves the round-shaped branches in charge', async () => {
        const summary = await readUpstreamSummary(root, changeId);
        expect(summary.ledger?.state).toBe('absent');
        expect(summary.ledger?.reason).toContain('no ledger has been recorded');
        expect(await ladderReason()).not.toBe('satisfy_ledger_deficits');
    });

    it('sends the change to repair with the kernel\'s deficits when the ledger does not pass', async () => {
        const subject = await freezeSubject({ root, paths: ['src/a.ts'] });
        expect(subject.ok).toBe(true);
        if (!subject.ok) return;
        await writeSubject(root, changeId, subject.subject);
        await appendClaim(root, changeId, makeClaim({ id: 'C1', severity: 'major', evidenceIds: ['E1'], dependsOn: ['path:src/a.ts'] }));

        const verdict = await ledgerVerdict({ root, changeId });
        expect(verdict.kind).toBe('decided');
        if (verdict.kind === 'decided') {
            expect(verdict.decision.verdict).toBe('insufficient');
            expect(verdict.decision.deficits[0]?.claimId).toBe('C1');
        }
        expect(await ladderReason()).toBe('satisfy_ledger_deficits');
    });

    it('stops gating once the ledger passes', async () => {
        const subject = await freezeSubject({ root, paths: ['src/a.ts'] });
        if (!subject.ok) return;
        await writeSubject(root, changeId, subject.subject);
        await ensureAssurance(root, changeId, 'observed');
        await appendClaim(root, changeId, makeClaim({ id: 'C1', severity: 'major', evidenceIds: ['E1'], dependsOn: ['path:src/a.ts'] }));
        await appendEvidence(root, changeId, makeEvidence({ id: 'E1', ref: 'src/a.ts', assertion: 'contains:holds' }));
        await recordVerdicts(root, changeId, [makeVerdict({ evidenceId: 'E1', subjectRevision: subject.subject.revision })]);

        const verdict = await ledgerVerdict({ root, changeId });
        expect(verdict.kind).toBe('decided');
        if (verdict.kind === 'decided') expect(verdict.decision.verdict).toBe('pass');
        expect(await ladderReason()).not.toBe('satisfy_ledger_deficits');
    });

    it('refuses a change whose claims do not cover the tier\'s risk space, which is what makes coverage failable', async () => {
        // The defect this pins: when the required classes are derived from the claims themselves, coverage is true by
        // construction and the check can never fail. Here the tier is strict (a `src/quality/**` path), the tier requires
        // consistency, boundary and failure_mode, and the ledger holds one consistency claim.
        await mkdir(join(root, 'src', 'quality'), { recursive: true });
        await writeFile(join(root, 'src', 'quality', 'x.ts'), 'export const x = 1;\n');
        await writeFile(
            join(root, '.kata', 'tasks', changeId, 'task.json'),
            `${JSON.stringify({ id: changeId, ownedPaths: ['src/quality/x.ts'], workflowProfile: { reviewMode: 'strict' } }, null, 2)}\n`,
        );
        const subject = await freezeSubject({ root, paths: ['src/quality/x.ts'] });
        if (!subject.ok) return;
        await writeSubject(root, changeId, subject.subject);
        await ensureAssurance(root, changeId, 'observed');
        await appendClaim(root, changeId, makeClaim({ id: 'C1', severity: 'major', evidenceIds: ['E1'], dependsOn: ['path:src/quality/x.ts'] }));
        await appendEvidence(root, changeId, makeEvidence({ id: 'E1', ref: 'src/quality/x.ts', assertion: 'contains:export' }));
        await recordVerdicts(root, changeId, [makeVerdict({ evidenceId: 'E1', subjectRevision: subject.subject.revision })]);

        const verdict = await ledgerVerdict({ root, changeId });
        expect(verdict.kind).toBe('decided');
        if (verdict.kind !== 'decided') return;
        expect(verdict.tier).toBe('strict');
        expect(verdict.decision.verdict).toBe('insufficient');
        const uncovered = verdict.decision.reasons.find((reason) => reason.code === 'uncovered_risk_class');
        expect(uncovered?.detail).toContain('boundary');
        expect(uncovered?.detail).toContain('failure_mode');
    });

    it('refuses an unreadable ledger instead of reading it as one that was never written', async () => {
        await mkdir(reviewDir(root, changeId), { recursive: true });
        await writeFile(join(reviewDir(root, changeId), 'claims.json'), '{ this is not json');

        const verdict = await ledgerVerdict({ root, changeId });
        expect(verdict.kind).toBe('unreadable');
        if (verdict.kind === 'unreadable') expect(verdict.detail).toContain('claims.json');
        expect((await readLedger(root, changeId)).malformedFiles).toEqual(['claims.json']);
        expect(await ladderReason()).toBe('satisfy_ledger_deficits');
    });
});
