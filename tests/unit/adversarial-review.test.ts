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
        const current = { node: 'verify' as const, revisionId: 'revision-abc', briefSha256: adversarialBriefSha256(brief) };

        expect(evaluateAdversarialGate(record(), current)).toMatchObject({ satisfied: true });
        expect(evaluateAdversarialGate(null, current)).toMatchObject({ satisfied: false, reason: 'missing' });
        expect(evaluateAdversarialGate(record({ revisionId: 'revision-older' }), current)).toMatchObject({ satisfied: false, reason: 'stale_revision' });
        expect(evaluateAdversarialGate(record({ executedInFreshContext: false }), current)).toMatchObject({ satisfied: false, reason: 'not_fresh_context' });
        expect(evaluateAdversarialGate(record({ briefSha256: 'f'.repeat(64) }), current)).toMatchObject({ satisfied: false, reason: 'brief_mismatch' });
        expect(evaluateAdversarialGate(record({ attempts: [] }), current)).toMatchObject({ satisfied: false, reason: 'brief_mismatch' });
        expect(evaluateAdversarialGate(record(), { ...current, revisionId: null })).toMatchObject({ satisfied: false, reason: 'no_revision' });
    });

    it('reports a waiver as a waiver rather than hiding it', () => {
        const waived = record({ status: 'waived', waivedReason: 'No subagent facility on this host.', waivedBy: 'reviewer' });

        expect(evaluateAdversarialGate(waived, { node: 'verify', revisionId: 'revision-abc', briefSha256: 'anything' }))
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

        expect(evaluateAdversarialGate(withDefects, { node: 'verify', revisionId: 'revision-abc', briefSha256: adversarialBriefSha256(brief) }))
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
