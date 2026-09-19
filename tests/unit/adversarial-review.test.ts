import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { renderSkill, skillCommands } from '../../src/adapters/manifest.js';
import {
    adversarialBriefSha256,
    blockingAdversarialFindings,
    evaluateAdversarialGate,
    renderAdversarialBrief,
    type AdversarialRecord,
} from '../../src/quality/adversarial.js';

/**
 * The independent adversarial pass: kata renders the brief, checks the recorded result against the revision and that
 * brief, and holds the gate. It cannot start a subagent or inspect the host's session, so the attestation that the pass
 * ran in a clean context is reported by the executing agent — but everything else about the pass is checked here.
 */
describe('independent adversarial review', () => {
    const roots: string[] = [];

    afterEach(async () => {
        await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
    });

    const brief = renderAdversarialBrief({
        taskId: 'adversarial-task',
        node: 'verify',
        revisionId: 'revision-abc',
        acceptance: [{ id: 'AC-1', statement: 'The behaviour holds at the boundary.' }],
        evidence: [{
            id: 'evidence-1', taskId: 'adversarial-task', kind: 'test', command: 'npm test', exitCode: 0,
            startedAt: '2026-09-17T00:00:00.000Z', finishedAt: '2026-09-17T00:00:01.000Z', diffHash: 'a'.repeat(64),
        }],
        ownedPaths: ['src/foo.ts'],
        reviewFindings: [{ severity: 'minor', message: 'Naming.' }],
    });

    function record(overrides: Partial<AdversarialRecord> = {}): AdversarialRecord {
        return {
            node: 'verify',
            status: 'recorded',
            revisionId: 'revision-abc',
            createdAt: '2026-09-17T00:00:00.000Z',
            executedInFreshContext: true,
            contextNote: 'Subagent with no prior conversation.',
            briefSha256: adversarialBriefSha256(brief),
            verdict: 'no_defect_found',
            attempts: [{ hypothesis: 'Boundary input is unhandled.', method: 'Read the guard and run the case.', outcome: 'refuted', evidence: 'The guard rejects it.' }],
            findings: [],
            ...overrides,
        };
    }

    it('renders a brief a clean context can act on', () => {
        // The brief has to carry everything: a fresh context has no conversation to fall back on.
        expect(brief).toContain('You are an independent adversarial reviewer. **You have no prior context.**');
        expect(brief).toContain('revision-abc');
        expect(brief).toContain('AC-1: The behaviour holds at the boundary.');
        expect(brief).toContain('evidence-1 | kind=test | exit=0');
        expect(brief).toContain('src/foo.ts');
        expect(brief).toContain('minor: Naming.');
        expect(brief).toContain('falsification attempt per claim');
        expect(brief).toContain('kata-cli adversarial record --change adversarial-task --node verify');
    });

    it('satisfies the gate only for a fresh-context pass over this revision and this brief', () => {
        const issued = adversarialBriefSha256(brief);
        const current = { node: 'verify' as const, revisionId: 'revision-abc', issuedBriefSha256s: [issued] };

        expect(evaluateAdversarialGate(record(), current)).toMatchObject({ satisfied: true });
        expect(evaluateAdversarialGate(null, current)).toMatchObject({ satisfied: false, reason: 'missing' });
        expect(evaluateAdversarialGate(record({ revisionId: 'revision-older' }), current)).toMatchObject({ satisfied: false, reason: 'stale_revision' });
        expect(evaluateAdversarialGate(record({ executedInFreshContext: false }), current)).toMatchObject({ satisfied: false, reason: 'not_fresh_context' });
        // A hash kata never issued for this node — invented, mistyped, or absent — is refused, and the refusal names
        // what to run instead of pretending the pass answered a different brief.
        expect(evaluateAdversarialGate(record({ briefSha256: 'f'.repeat(64) }), current)).toMatchObject({ satisfied: false, reason: 'brief_not_issued' });
        expect(evaluateAdversarialGate(record({ briefSha256: undefined }), current)).toMatchObject({ satisfied: false, reason: 'brief_not_issued' });
        // A hash that *was* issued, but for another revision, is a different refusal: the round answered another round's question.
        expect(evaluateAdversarialGate(record({ briefSha256: 'a'.repeat(64) }), { ...current, otherRevisionBriefSha256s: ['a'.repeat(64)] }))
            .toMatchObject({ satisfied: false, reason: 'brief_mismatch' });
        expect(evaluateAdversarialGate(record({ attempts: [] }), current)).toMatchObject({ satisfied: false, reason: 'incomplete' });
        expect(evaluateAdversarialGate(record(), { ...current, revisionId: null })).toMatchObject({ satisfied: false, reason: 'no_revision' });
    });

    it('reports a waiver as a waiver rather than hiding it', () => {
        const waived = record({ status: 'waived', waivedReason: 'No subagent facility on this host.', waivedBy: 'reviewer' });

        expect(evaluateAdversarialGate(waived, { node: 'verify', revisionId: 'revision-abc', issuedBriefSha256s: [] }))
            .toMatchObject({ satisfied: true, reason: 'waived' });
        expect(blockingAdversarialFindings(waived)).toEqual([]);
    });

    it('carries the defects it confirmed, so the node cannot pass over them', () => {
        const withDefects = record({
            verdict: 'defects_found',
            findings: [
                { id: 'F-1', taskId: 'adversarial-task', severity: 'blocking', message: 'The boundary case is unhandled.' },
                { id: 'F-2', taskId: 'adversarial-task', severity: 'nit', message: 'Naming.' },
            ],
        });

        expect(evaluateAdversarialGate(withDefects, { node: 'verify', revisionId: 'revision-abc', issuedBriefSha256s: [adversarialBriefSha256(brief)] }))
            .toMatchObject({ satisfied: true });
        expect(blockingAdversarialFindings(withDefects).map((finding) => finding.id)).toEqual(['F-1']);
    });

    it('tells the verify and review skills to run the brief in a clean-context subagent', () => {
        for (const [id, node] of [['kata-verify', 'verify'], ['kata-review', 'review']] as const) {
            const command = skillCommands.find((entry) => entry.id === id);
            expect(command).toBeDefined();
            const rendered = renderSkill(command!, 'generic');

            expect(rendered).toContain('## Independent adversarial review (clean context)');
            expect(rendered).toContain(`kata-cli adversarial brief --change <task-id> --node ${node}`);
            expect(rendered).toContain(`kata-cli adversarial record --change <task-id> --node ${node} --from-file <result.json>`);
            expect(rendered).toContain('Run that brief in a clean context.');
            expect(rendered).toContain(`kata-cli adversarial waive --change <task-id> --node ${node}`);
        }

        // The other nodes do not carry it: the mechanism belongs to the two nodes that conclude about a change.
        const build = skillCommands.find((entry) => entry.id === 'kata-build');
        expect(renderSkill(build!, 'generic')).not.toContain('## Independent adversarial review');
    });
});


describe('a recorded pass is bound to the content it reviewed', () => {
    const base = {
        node: 'verify' as const,
        status: 'recorded' as const,
        revisionId: 'revision-old',
        manifestHash: 'aa'.repeat(32),
        createdAt: '2026-09-17T00:00:00.000Z',
        executedInFreshContext: true,
        briefSha256: 'brief',
        attempts: [{ hypothesis: 'h', method: 'm', outcome: 'refuted' as const, evidence: 'e' }],
    };

    it('accepts a pass whose revision id changed but whose content did not', () => {
        // A re-seal of unchanged owned paths issues a new revision id (the id covers the manifest hash and the check
        // ids), and paying for a second adversarial pass over the same artefact is the cost this binds away.
        expect(evaluateAdversarialGate(base, {
            node: 'verify',
            revisionId: 'revision-new',
            manifestHash: 'aa'.repeat(32),
            issuedBriefSha256s: ['brief'],
        })).toMatchObject({ satisfied: true });
    });

    it('still refuses when the content moved', () => {
        expect(evaluateAdversarialGate(base, {
            node: 'verify',
            revisionId: 'revision-new',
            manifestHash: 'bb'.repeat(32),
            issuedBriefSha256s: ['brief'],
        })).toMatchObject({ satisfied: false, reason: 'stale_revision' });
    });

    it('falls back to the revision id when no content identity was stamped', () => {
        const legacy = { ...base, manifestHash: undefined };
        expect(evaluateAdversarialGate(legacy, { node: 'verify', revisionId: 'revision-old', issuedBriefSha256s: ['brief'] }))
            .toMatchObject({ satisfied: true });
        expect(evaluateAdversarialGate(legacy, { node: 'verify', revisionId: 'revision-new', manifestHash: 'aa'.repeat(32), issuedBriefSha256s: ['brief'] }))
            .toMatchObject({ satisfied: false, reason: 'stale_revision' });
    });
});

describe('the brief points at sealed evidence instead of asking for it again (M1)', () => {
    it('names the envelopes on disk and the project-declared checks that must not be re-run', async () => {
        const { renderAdversarialBrief } = await import('../../src/quality/adversarial.js');

        const text = renderAdversarialBrief({
            taskId: 'm1-task',
            node: 'verify',
            revisionId: 'revision-1',
            acceptance: [{ id: 'AC-1', statement: 'x' }],
            evidence: [
                { id: 'e-1', kind: 'lint', command: 'make', args: ['lint'], exitCode: 0, startedAt: '', finishedAt: '', checkId: 'lint' },
                { id: 'e-2', kind: 'test', command: 'make', args: ['test'], exitCode: 0, startedAt: '', finishedAt: '', checkId: 'matrix:AC-1:test' },
            ] as never,
            ownedPaths: ['src'],
            declaredChecks: [{ id: 'lint', name: 'lint' }, { id: 'test', name: 'test' }],
            evidencePaths: [{ id: 'e-1', checkId: 'lint', path: '/w/.kata/evidence/m1-task-lint.json' }],
        });

        // The reading list, the "do not re-run" rule, and the price of the trade are all stated.
        expect(text).toContain('## Sealed evidence you may read instead of re-running');
        expect(text).toContain('/w/.kata/evidence/m1-task-lint.json');
        expect(text).toMatch(/Do not re-run a check whose sealed evidence already covers this revision/);
        expect(text).toMatch(/drops from \*re-derived\* to \*inspected\*/);
        // The narrow exception is stated, so a suite-global round is still possible.
        expect(text).toMatch(/Exception, narrow and explicit/);
        // And the batched-execution line, which is the largest lever on the turn term.
        expect(text).toContain('## Pacing yourself');
        expect(text).toMatch(/one\*\* invocation/);
        // A declared check is flagged; a matrix check is listed without the flag.
        expect(text).toMatch(/lint \| exit=0.*do not re-run it/);
        expect(text).not.toMatch(/matrix:AC-1:test \| exit=0.*do not re-run it/);
    });
});

describe('the brief hands over a starting set, bounded (M4)', () => {
    it('lists the changed paths first, then the matrix collaborators, and says it is not a boundary', async () => {
        const { renderAdversarialBrief } = await import('../../src/quality/adversarial.js');

        const text = renderAdversarialBrief({
            taskId: 'm4-task',
            node: 'verify',
            revisionId: 'revision-1',
            acceptance: [{ id: 'AC-1', statement: 'x' }],
            evidence: [],
            ownedPaths: ['src'],
            readingSet: [
                { path: 'src/a.ts', why: 'changed in this change' },
                { path: 'src/b.ts', why: 'implements the same acceptance criterion as this change (AC-1)' },
            ],
        });

        expect(text).toContain('## Where to start reading');
        // The framing matters as much as the list: a starting set that reads as a boundary hides defects outside it.
        expect(text).toMatch(/starting set, \*\*not a boundary\*\*/);
        expect(text).toMatch(/src\/a\.ts — changed in this change/);
        expect(text).toMatch(/src\/b\.ts — implements the same acceptance criterion/);
    });

    it('says so plainly when it cannot name a starting set', async () => {
        const { renderAdversarialBrief } = await import('../../src/quality/adversarial.js');
        const text = renderAdversarialBrief({
            taskId: 'm4-empty',
            node: 'verify',
            revisionId: null,
            acceptance: [],
            evidence: [],
            ownedPaths: [],
        });

        expect(text).toMatch(/cannot name a starting set/);
    });
});

describe('the framing rotates, and never rotates past an unrepaired blocker (M2)', () => {
    it('cold mode carries no author claims and says why there are none', async () => {
        const { renderAdversarialBrief } = await import('../../src/quality/adversarial.js');

        const text = renderAdversarialBrief({
            taskId: 'm2-task',
            node: 'verify',
            revisionId: 'revision-1',
            acceptance: [{ id: 'AC-1', statement: 'the author thinks this is what matters' }],
            evidence: [],
            ownedPaths: ['src'],
            mode: 'cold',
            modeReason: 'the previous verify round was verify',
        });

        expect(text).toContain('Round framing: cold');
        expect(text).toMatch(/no author claims are given/);
        // The claim text itself must not appear: withholding the framing is the whole point of a cold round.
        expect(text).not.toContain('the author thinks this is what matters');
        expect(text).toMatch(/Decide what to attack first/);
    });

    it('verify mode lists the claims, and still requires the whole delta to be walked', async () => {
        const { renderAdversarialBrief } = await import('../../src/quality/adversarial.js');

        const text = renderAdversarialBrief({
            taskId: 'm2-task',
            node: 'verify',
            revisionId: 'revision-1',
            acceptance: [{ id: 'AC-1', statement: 'the author thinks this is what matters' }],
            evidence: [],
            ownedPaths: ['src'],
            mode: 'verify',
        });

        expect(text).toContain('Round framing: verify');
        expect(text).toContain('the author thinks this is what matters');
        expect(text).toMatch(/falsification attempt per claim/);
    });
});

describe('the brief contract of §18.5', () => {
    it('carries a starting reading set with sizes, an attempt cap, and what the round does not cover', async () => {
        const { renderAdversarialBrief } = await import('../../src/quality/adversarial.js');

        const text = renderAdversarialBrief({
            taskId: 'contract-task',
            node: 'verify',
            revisionId: 'revision-1',
            acceptance: [{ id: 'AC-1', statement: 'x' }],
            evidence: [],
            ownedPaths: ['src'],
            mode: 'verify',
            scopeReason: 'repair batch batch-1 closed on revision-0',
            readingSet: [
                { path: 'src/big.ts', why: 'changed in this change', lines: 1200 },
                { path: 'src/gone.ts', why: 'owned by this task', lines: null },
            ],
        });

        // The size turns "read this file" into a decision about whether to read a region instead.
        expect(text).toContain('src/big.ts (~1200 lines)');
        // …and an unreadable path says nothing about a size rather than claiming zero.
        expect(text).toContain('src/gone.ts —');
        expect(text).not.toContain('src/gone.ts (~0 lines)');
        // The cap, with its escape hatch named as a reproduction rather than as permission to keep going.
        expect(text).toContain('at most six attempts');
        expect(text).toMatch(/Exceed that only with a \*\*reproduction\*\*/);
        // And the scope's reason is stated in the brief, so an unexamined area is never read as verified.
        expect(text).toContain('repair batch batch-1 closed on revision-0');
        expect(text).toMatch(/What this round does not cover/);
    });
});
