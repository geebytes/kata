import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendClaim, appendEvidence, ensureAssurance, freezeSubject, recordVerdicts, writeSubject } from '../../src/store/ledger.js';
import { ledgerVerdict } from '../../src/store/verdict.js';
import { makeChallenge, makeClaim, makeEvidence, makeVerdict } from '../helpers/review.js';
import type { EvidenceVerdict } from '../../src/kernel/types.js';

/**
 * **The `security` tier asks for two independent reviewers, and until now no ledger could satisfy it.**
 *
 * This is the reachability case: the requirement is met by two runs that decided the same evidence, and it is the reason
 * the store keeps readings per run at all. Measured before the change — a second independent reading recorded in full, and
 * `quorum_missing` still reported — because `recordVerdicts` replaced on the evidence id.
 *
 * The mutation that must redden this: put that replacement back (one entry per evidence item). Then the second run
 * overwrites the first, `groupByProducer` groups one reading, and `quorum_missing` returns.
 */
let root: string;
const changeId = 'two-reviewers';
const NOW = '2026-09-29T00:00:00.000Z';

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'kata-two-reviewers-'));
    await mkdir(join(root, '.kata', 'tasks', changeId), { recursive: true });
    await mkdir(join(root, 'src'), { recursive: true });
    // A kernel path, so the classification floor puts this ledger at the tier that asks for two reviewers.
    await writeFile(join(root, 'src', 'kernel.ts'), 'export const policy = 1;\n');
    await writeFile(
        join(root, '.kata', 'tasks', changeId, 'task.json'),
        `${JSON.stringify({ id: changeId, ownedPaths: ['src/kernel.ts'], workflowProfile: { reviewMode: 'security' } }, null, 2)}\n`,
    );
    const frozen = await freezeSubject({ root, paths: ['src/kernel.ts'] });
    if (!frozen.ok) throw new Error(frozen.error);
    await writeSubject(root, changeId, frozen.subject);
    subjectRevision = frozen.subject.revision;
    frozenAt = frozen.subject.revision;
    await ensureAssurance(root, changeId, 'observed');
    await appendClaim(root, changeId, makeClaim({ id: 'C1', severity: 'major', riskClass: 'consistency', evidenceIds: ['E1'], dependsOn: ['path:src/kernel.ts'] }));
    await appendEvidence(root, changeId, makeEvidence({ id: 'E1', type: 'executable_falsifier', command: 'true' }));
});

afterEach(async () => {
    await rm(root, { recursive: true, force: true });
});

/** A reading of this ledger's own subject: the projection's revision region only applies to readings that name it. */
let subjectRevision = '';
/** The revision the fixture froze first, so a case that re-freezes can prove the subject actually moved. */
let frozenAt = '';

function reading(runId: string, actor: string, overrides: Partial<EvidenceVerdict> = {}): EvidenceVerdict {
    return {
        ...makeVerdict({ evidenceId: 'E1', verdict: 'supported', at: NOW }),
        subjectRevision,
        producer: { runId, actor },
        ...overrides,
    };
}

async function reasonCodes(actor?: string): Promise<string[]> {
    const verdict = await ledgerVerdict({ root, changeId, tier: 'security', ...(actor === undefined ? {} : { actor }) });
    if (verdict.kind !== 'decided') throw new Error(`expected a decided ledger, got ${verdict.kind}${'detail' in verdict ? `: ${verdict.detail}` : ''}`);
    return verdict.decision.reasons.map((reason) => reason.code);
}

describe('two independent readings satisfy the tier that asks for them', () => {
    it('stops reporting a missing quorum once a second run has read the same evidence', async () => {
        await recordVerdicts(root, changeId, [reading('run-1', 'reviewer-a')]);
        // Before the second reading the requirement is genuinely unmet, so the case is about the second reading and not
        // about a tier that never asked.
        expect(await reasonCodes()).toContain('quorum_missing');

        await recordVerdicts(root, changeId, [reading('run-2', 'reviewer-b')]);
        expect(await reasonCodes()).not.toContain('quorum_missing');
    });

    it('reports a refutation of a dead revision as stale rather than as a failure of this one', async () => {
        // The other half of the same rule, and pre-existing in `decide`: the refuted branch ran before the staleness branch,
        // so an item whose only reading refuted content that no longer exists produced `evidence_refuted` — a hard fail with
        // no deficit, so no remedy — instead of naming the re-read. Measured by an independent review.
        await recordVerdicts(root, changeId, [
            { ...reading('run-1', 'reviewer-a', { verdict: 'refuted', at: '2026-09-28T00:00:00.000Z' }), subjectRevision: 'rev:dead' },
        ]);
        const codes = await reasonCodes();
        expect(codes).toContain('evidence_stale_subject');
        expect(codes).not.toContain('evidence_refuted');
        // And not "never read": the item has a reading, it is simply not about this content — which is a different remedy,
        // and the projection's per-item region is what keeps it visible to the decision at all.
        expect(codes).not.toContain('evidence_missing');
    });

    it('does not count a run that only read the previous revision, so the tier needs two runs on THIS content', async () => {
        // **Measured by an independent review on a real flow.** Re-sealing is what makes old readings stale, and the ledger
        // says so in its own reasons — yet the quorum was still counting the old run, so the two-reviewer requirement could
        // be satisfied by a reading nothing else in the kernel would decide on. The case drives `ledgerVerdict`, which is
        // the surface that answers; a case that only exercised the kernel helper stayed green when the store stopped
        // filtering, which is why this one goes through the real path.
        await recordVerdicts(root, changeId, [reading('run-1', 'reviewer-a')]);
        // The content moves, and the subject is frozen again: every reading so far is about a revision that no longer exists.
        await writeFile(join(root, 'src', 'kernel.ts'), 'export const policy = 2;\n');
        const refrozen = await freezeSubject({ root, paths: ['src/kernel.ts'] });
        if (!refrozen.ok) throw new Error(refrozen.error);
        await writeSubject(root, changeId, refrozen.subject);
        subjectRevision = refrozen.subject.revision;
        expect(refrozen.subject.revision).not.toBe(frozenAt);

        // One run has read the new content; the other only read the old one, so the requirement is still unmet.
        await recordVerdicts(root, changeId, [reading('run-2', 'reviewer-b')]);
        expect(await reasonCodes()).toContain('quorum_missing');

        // A third run reading the same new content is the second independent reviewer of *this* revision.
        await recordVerdicts(root, changeId, [reading('run-3', 'reviewer-c')]);
        expect(await reasonCodes()).not.toContain('quorum_missing');
    });

    it('still reports it when the same run recorded its reading twice', async () => {
        // Two writes, one run: a replay is not a second reviewer, and the count must not be satisfiable by repetition.
        await recordVerdicts(root, changeId, [reading('run-1', 'reviewer-a')]);
        await recordVerdicts(root, changeId, [reading('run-1', 'reviewer-a')]);
        expect(await reasonCodes()).toContain('quorum_missing');
    });

    it('reports it when both readings came from one actor, because the count is not independence', async () => {
        await recordVerdicts(root, changeId, [reading('run-1', 'the-author')]);
        await recordVerdicts(root, changeId, [reading('run-2', 'the-author')]);
        const codes = await reasonCodes();
        expect(codes).not.toContain('quorum_missing');
        // Two runs by one actor is a different defect with its own name, and the tier's contract is what reports it.
        expect(codes).toContain('quorum_undiversified');
    });

    it('keeps the item as the reading it already was when a second run agrees, so the count moves and the verdict does not', async () => {
        await recordVerdicts(root, changeId, [reading('run-1', 'reviewer-a')]);
        const before = await reasonCodes();
        await recordVerdicts(root, changeId, [reading('run-2', 'reviewer-b')]);
        const after = await reasonCodes();
        // The assertion is about the reading, not about the tier's other demands: adding an agreeing reading must not turn
        // a supported item into a refuted one (or the reverse), which is what a projection that averaged would do.
        expect(after).not.toContain('evidence_refuted');
        expect(before).not.toContain('evidence_refuted');
    });

    it('refuses an approval by an actor who produced a reading, even one the projection no longer holds', async () => {
        // **The independence check asks about the actors, not about the surviving reading.** Measured by an independent
        // review: the check read the projection, so an author whose reading had been displaced (here by a re-seal making it
        // stale) could approve a decision its own reading had been part of. Which reading survives is a freshness question;
        // who took part is an identity question, and this check is about identity.
        await recordVerdicts(root, changeId, [reading('run-1', 'the-author')]);
        await writeFile(join(root, 'src', 'kernel.ts'), 'export const policy = 3;\n');
        const refrozen = await freezeSubject({ root, paths: ['src/kernel.ts'] });
        if (!refrozen.ok) throw new Error(refrozen.error);
        await writeSubject(root, changeId, refrozen.subject);
        subjectRevision = refrozen.subject.revision;
        await recordVerdicts(root, changeId, [reading('run-2', 'reviewer-b')]);

        const codes = await reasonCodes('the-author');
        expect(codes).toContain('same_actor');
        // And a party that produced nothing can still approve, so the refusal is about participation rather than noise.
        expect(await reasonCodes('a-later-maintainer')).not.toContain('same_actor');
    });

    it('a second run that refutes the evidence makes the item refuted rather than outvoted', async () => {
        // **The refutation is the OLDER reading**, which is the point: with the newest reading supporting the item, only
        // refuted-priority can produce `evidence_refuted`. The first version of this case had the refutation last, so it
        // stayed green under a projection that simply took the newest — it could not tell the two rules apart.
        await recordVerdicts(root, changeId, [reading('run-1', 'reviewer-a', { verdict: 'refuted', at: '2026-09-28T00:00:00.000Z' })]);
        await recordVerdicts(root, changeId, [reading('run-2', 'reviewer-b', { at: '2026-09-29T12:00:00.000Z' })]);
        const codes = await reasonCodes();
        expect(codes).toContain('evidence_refuted');
        expect(codes).not.toContain('claim_unsupported');
    });

    it('an open counterexample still stands beside a satisfied quorum, because the two are different questions', async () => {
        await recordVerdicts(root, changeId, [reading('run-1', 'reviewer-a')]);
        await recordVerdicts(root, changeId, [reading('run-2', 'reviewer-b')]);
        const { appendChallenge } = await import('../../src/store/ledger.js');
        await appendChallenge(root, changeId, makeChallenge({ id: 'X1', claimId: 'C1', command: 'false', state: 'open' }));
        const codes = await reasonCodes();
        // Both facts are reported at once: the requirements are not alternatives, and satisfying one does not silence the
        // other — a satisfied quorum beside a standing counterexample must still say the counterexample stands.
        expect(codes).not.toContain('quorum_missing');
        expect(codes).toContain('challenge_open');
    });
});
