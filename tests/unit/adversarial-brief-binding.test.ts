import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { adversarialBriefPath, initLayout } from '../../src/core/layout.js';
import { createTask } from '../../src/core/task.js';
import { createTaskRevision } from '../../src/workflow/revision.js';
import {
    adversarialGateFor,
    buildAdversarialBrief,
    issueAdversarialBrief,
    readAdversarialRecord,
    writeAdversarialRecord,
    type AdversarialBrief,
    type AdversarialNode,
    type AdversarialRecord,
} from '../../src/quality/adversarial.js';
import { runAdversarialCommand } from '../../src/cli/ops.js';

/**
 * The defect this file reproduces (reported 2026-09-19, reproduced on both nodes):
 *
 * `kata-cli adversarial record` invalidated its own record. The gate validated a recorded pass by **re-deriving** the
 * brief and comparing hashes, but the brief's text moves with state any other action can rewrite — the round framing
 * (`resolveBriefMode` reads the previous pass), the reading set (derived from the working tree), and `review.json`
 * (which the review node resets). So recording a pass, running the review phase, or editing an owned path rejected a
 * pass that answered a brief kata really handed out, with `brief_mismatch`, and the adversarial gate could never be
 * satisfied on a task that did anything at all.
 *
 * The fix binds the record to the **issued copy**: `kata-cli adversarial brief` stores the text and its hash, and only a
 * hash from that store satisfies the gate. The anti-forgery property is unchanged (a hash kata never issued is refused);
 * what is gone is a later action's ability to invalidate a brief it did not issue.
 */
describe('a recorded pass is bound to the brief kata issued', () => {
    const roots: string[] = [];

    afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

    async function fixture(): Promise<string> {
        const root = await mkdtemp(join(tmpdir(), 'kata-brief-binding-'));
        roots.push(root);
        await initLayout(root);
        await createTask({ root, id: 'binding', title: 'Binding', ownedPaths: ['src/'], acceptance: [{ id: 'AC-1', statement: 'x' }] });
        await mkdir(join(root, 'src'), { recursive: true });
        await writeFile(join(root, 'src/a.ts'), 'export const a = 1;\n', 'utf8');
        await createTaskRevision({ root, taskId: 'binding', ownedPaths: ['src/a.ts'], checkIds: [] });
        return root;
    }

    /** Records a pass the way `kata-cli adversarial record` does: stamped from the issued brief, not from a flag. */
    async function recordFrom(root: string, node: AdversarialNode, brief: AdversarialBrief, overrides: Partial<AdversarialRecord> = {}): Promise<void> {
        await writeAdversarialRecord(root, 'binding', {
            node,
            status: 'recorded',
            revisionId: brief.revisionId ?? '',
            ...(brief.manifestHash ? { manifestHash: brief.manifestHash } : {}),
            createdAt: new Date().toISOString(),
            executedInFreshContext: true,
            contextNote: 'Fixture ran the brief in a subagent with no prior conversation.',
            briefSha256: brief.sha256,
            mode: brief.mode,
            verdict: 'no_defect_found',
            attempts: [{ hypothesis: 'The claim only holds for the shape of the test.', method: 'Read the test.', outcome: 'refuted' }],
            findings: [],
            ...overrides,
        });
    }

    for (const node of ['verify', 'review'] as const) {
        it(`${node}: a recorded pass survives the state behind its brief moving afterwards`, async () => {
            const root = await fixture();
            const issued = await issueAdversarialBrief(root, 'binding', node);
            await recordFrom(root, node, issued);
            expect(await adversarialGateFor(root, 'binding', node)).toMatchObject({ satisfied: true });

            // Everything that used to move the brief's text after the pass was recorded. The review node resets
            // `review.json` at the start of a round, the reading set follows the working tree, and recording this pass
            // flipped the framing of the next round. None of it may invalidate a brief kata really handed out.
            await writeFile(
                join(root, '.kata/tasks/binding/review.json'),
                `${JSON.stringify({
                    revisionId: issued.revisionId,
                    status: 'pending',
                    findings: [{ id: 'F-1', taskId: 'binding', severity: 'minor', message: 'Naming.', disposition: 'deferred', dispositionReason: 'later' }],
                })}\n`,
                'utf8',
            );
            await writeFile(join(root, 'src/a.ts'), 'export const a = 2;\n', 'utf8');

            expect(await adversarialGateFor(root, 'binding', node)).toMatchObject({ satisfied: true });

            // And the framing did rotate — visible only because the record now carries the mode it answered (M2).
            const next = await issueAdversarialBrief(root, 'binding', node);
            expect(next.mode).toBe('verify');
            expect(await adversarialGateFor(root, 'binding', node)).toMatchObject({ satisfied: true });
        });
    }

    it('accepts a delta round, whose brief the gate could never re-derive', async () => {
        const root = await fixture();
        const full = await issueAdversarialBrief(root, 'binding', 'verify');
        await recordFrom(root, 'verify', full, { scope: { kind: 'full' } });
        await writeFile(join(root, 'src/a.ts'), 'export const a = 2;\n', 'utf8');

        const delta = await issueAdversarialBrief(root, 'binding', 'verify', { since: full.revisionId ?? '' });
        expect(delta.delta).toMatchObject({ from: full.revisionId, changedPaths: ['src/a.ts'] });
        // The gate re-rendered a *full* brief here, so a delta round could never satisfy it — not even once.
        await recordFrom(root, 'verify', delta, { scope: { kind: 'delta', from: full.revisionId ?? '', changedPaths: ['src/a.ts'] } });

        expect(await adversarialGateFor(root, 'binding', 'verify')).toMatchObject({ satisfied: true });
    });

    it('does not accept a hash merely because it is what the brief renders now', async () => {
        const root = await fixture();
        // Rendered, deliberately not issued: the binding is the issued copy, so rendering cannot mint one.
        const rendered = await buildAdversarialBrief(root, 'binding', 'verify');
        await recordFrom(root, 'verify', rendered);

        expect(await adversarialGateFor(root, 'binding', 'verify')).toMatchObject({ satisfied: false, reason: 'brief_not_issued' });
    });

    it('refuses an invented hash, and a hash issued for another revision', async () => {
        const root = await fixture();
        const issued = await issueAdversarialBrief(root, 'binding', 'verify');
        await recordFrom(root, 'verify', issued);
        expect(await adversarialGateFor(root, 'binding', 'verify')).toMatchObject({ satisfied: true });

        // An invented hash (the schema accepts all zeros): refused, and told what to run instead.
        await recordFrom(root, 'verify', issued, { briefSha256: '0'.repeat(64) });
        const invented = await adversarialGateFor(root, 'binding', 'verify');
        expect(invented).toMatchObject({ satisfied: false, reason: 'brief_not_issued' });
        expect(invented.findings).toEqual([]);

        // A re-seal issues a new revision id, so the brief that was issued under the old one is another round's brief.
        await writeFile(join(root, 'src/a.ts'), 'export const a = 3;\n', 'utf8');
        await createTaskRevision({ root, taskId: 'binding', ownedPaths: ['src/a.ts'], checkIds: [] });
        const resealed = await issueAdversarialBrief(root, 'binding', 'verify');
        expect(resealed.revisionId).not.toBe(issued.revisionId);
        await recordFrom(root, 'verify', resealed, { briefSha256: issued.sha256 });

        expect(await adversarialGateFor(root, 'binding', 'verify')).toMatchObject({ satisfied: false, reason: 'brief_mismatch' });
    });
});

describe('kata-cli adversarial: the issued copy is the way in', () => {
    const roots: string[] = [];

    afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

    async function fixture(): Promise<string> {
        const root = await mkdtemp(join(tmpdir(), 'kata-brief-cli-'));
        roots.push(root);
        await initLayout(root);
        await createTask({ root, id: 'binding', title: 'Binding', ownedPaths: ['src/'], acceptance: [{ id: 'AC-1', statement: 'x' }] });
        await mkdir(join(root, 'src'), { recursive: true });
        await writeFile(join(root, 'src/a.ts'), 'export const a = 1;\n', 'utf8');
        await createTaskRevision({ root, taskId: 'binding', ownedPaths: ['src/a.ts'], checkIds: [] });
        return root;
    }

    it('stores the brief it hands out, stamps its framing on the record, and refuses a hash it never issued', async () => {
        const root = await fixture();
        const previousCwd = process.cwd();
        process.chdir(root);
        try {
            const brief = await runAdversarialCommand(['brief', '--change', 'binding', '--node', 'verify']);
            const log = JSON.parse(await readFile(adversarialBriefPath(root, 'binding', 'verify', String(brief.revisionId)), 'utf8')) as {
                briefs: Array<{ briefSha256: string; revisionId: string; mode: string; issuedAt: string; text: string }>;
            };
            expect(log.briefs[0]).toMatchObject({ briefSha256: brief.briefSha256, mode: brief.mode });
            expect(log.briefs[0].revisionId).toBe(brief.revisionId);
            expect(log.briefs[0].text).toContain('You are an independent adversarial reviewer');

            const result = {
                node: 'verify',
                status: 'recorded',
                revisionId: '',
                executedInFreshContext: true,
                contextNote: 'Subagent with no prior conversation.',
                createdAt: new Date().toISOString(),
                briefSha256: brief.briefSha256,
                verdict: 'no_defect_found',
                attempts: [{ hypothesis: 'h', method: 'm', outcome: 'refuted' }],
                findings: [],
            };
            const file = join(root, 'result.json');
            await writeFile(file, JSON.stringify(result), 'utf8');

            // `--mode verify` contradicts the issued brief (which opens cold on a task with no pass yet): the brief the
            // round answered wins, and the disagreement is reported rather than silently recorded.
            const recorded = await runAdversarialCommand(['record', '--change', 'binding', '--node', 'verify', '--from-file', file, '--mode', 'verify']);
            expect(recorded).toMatchObject({ mode: brief.mode, briefSha256: brief.briefSha256, gate: { satisfied: true } });
            expect(recorded.mode).toBe('cold');
            expect(String(recorded.modeNote)).toContain('--mode verify was ignored');

            // A pass claiming a hash kata never issued changes nothing: the refusal is reported, and the good record stands.
            await writeFile(file, JSON.stringify({ ...result, briefSha256: '0'.repeat(64) }), 'utf8');
            const refused = await runAdversarialCommand(['record', '--change', 'binding', '--node', 'verify', '--from-file', file]);
            expect(refused).toMatchObject({ recorded: false, gate: { satisfied: false, reason: 'brief_not_issued' } });
            expect(String(refused.error)).toContain('kata-cli adversarial brief --change binding --node verify');
            expect((await readAdversarialRecord(root, 'binding', 'verify'))?.briefSha256).toBe(brief.briefSha256);
            expect(await adversarialGateFor(root, 'binding', 'verify')).toMatchObject({ satisfied: true });
        } finally {
            process.chdir(previousCwd);
        }
    });


    it('records a delta round through the CLI by naming the brief it answered', async () => {
        const root = await fixture();
        const previousCwd = process.cwd();
        process.chdir(root);
        try {
            // Round one: full, recorded.
            const full = await runAdversarialCommand(['brief', '--change', 'binding', '--node', 'verify']);
            const resultFor = (briefSha256: string, scope: Record<string, unknown>): string =>
                JSON.stringify({
                    node: 'verify',
                    status: 'recorded',
                    revisionId: '',
                    executedInFreshContext: true,
                    contextNote: 'Subagent with no prior conversation.',
                    createdAt: new Date().toISOString(),
                    briefSha256,
                    verdict: 'no_defect_found',
                    attempts: [{ hypothesis: 'h', method: 'm', outcome: 'refuted' }],
                    findings: [],
                    scope,
                });
            const first = join(root, 'first.json');
            await writeFile(first, resultFor(String(full.briefSha256), { kind: 'full' }), 'utf8');
            await runAdversarialCommand(['record', '--change', 'binding', '--node', 'verify', '--from-file', first]);

            // One file changes, and round two asks for the delta.
            await writeFile(join(root, 'src/a.ts'), 'export const a = 2;\n', 'utf8');
            const delta = await runAdversarialCommand(['brief', '--change', 'binding', '--node', 'verify', '--since', String(full.revisionId)]);
            expect(delta.delta).toMatchObject({ changedPaths: ['src/a.ts'] });

            // A pass is pointed at the brief it answered — not at a flag the platform would have to re-derive.
            const second = join(root, 'second.json');
            await writeFile(second, resultFor(String(delta.briefSha256), { kind: 'delta', from: full.revisionId, changedPaths: ['src/a.ts'] }), 'utf8');
            const recorded = await runAdversarialCommand(['record', '--change', 'binding', '--node', 'verify', '--from-file', second]);
            expect(recorded).toMatchObject({ briefSha256: delta.briefSha256, gate: { satisfied: true } });
            // And the second round reports the cost terms the measurement depends on.
            const status = await runAdversarialCommand(['status', '--change', 'binding']);
            const node = (status.nodes as Record<string, Record<string, unknown>>).verify!;
            expect(node.mode).toBe(delta.mode);
        } finally {
            process.chdir(previousCwd);
        }
    });
});
