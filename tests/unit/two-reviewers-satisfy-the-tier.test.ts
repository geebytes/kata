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
    await ensureAssurance(root, changeId, 'observed');
    await appendClaim(root, changeId, makeClaim({ id: 'C1', severity: 'major', riskClass: 'consistency', evidenceIds: ['E1'], dependsOn: ['path:src/kernel.ts'] }));
    await appendEvidence(root, changeId, makeEvidence({ id: 'E1', type: 'executable_falsifier', command: 'true' }));
});

afterEach(async () => {
    await rm(root, { recursive: true, force: true });
});

/** A reading of this ledger's own subject: the projection's revision region only applies to readings that name it. */
let subjectRevision = '';

function reading(runId: string, actor: string, overrides: Partial<EvidenceVerdict> = {}): EvidenceVerdict {
    return {
        ...makeVerdict({ evidenceId: 'E1', verdict: 'supported', at: NOW }),
        subjectRevision,
        producer: { runId, actor },
        ...overrides,
    };
}

async function reasonCodes(): Promise<string[]> {
    const verdict = await ledgerVerdict({ root, changeId, tier: 'security' });
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
