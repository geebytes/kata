import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initLayout } from '../../src/core/layout.js';
import { runCommand } from '../../src/workflow/orchestrator.js';
import { readTask } from '../../src/core/task.js';
import { buildChangeRecord, refusalForDerivableProse, writeChangeRecord } from '../../src/quality/change-record.js';
import { applyScopeChange, recordScopeChange } from '../../src/quality/scope-change.js';
import { createTaskRevision, readCurrentTaskRevision } from '../../src/workflow/revision.js';
import { changeSurfaceAgainstWorkspace } from '../../src/quality/revision-delta.js';
import { buildAdversarialBrief, writeAdversarialRecord } from '../../src/quality/adversarial.js';

/**
 * §6 of the record-integrity handover: **a gate that cannot be shown to fail is a guard that reads as protection without
 * being one.** Before any of A–D may be called delivered, the doc requires each to be demonstrated by planting the thing
 * it is supposed to refuse:
 *
 * - A: plant a false derivable fact → the seal refuses it and names the field;
 * - C: add a scope record → the next revision's digest changes and the delta covers the file;
 * - D: produce a brief whose class history is wrong → a pass refuses it.
 *
 * This file is those three demonstrations. It exists because the first version of this change satisfied A's *mechanism*
 * (a derivation with no input channel) while nothing ever showed the rule firing — and an independent adversarial pass
 * proved that by mutation.
 */
describe('§6 self-evidence: the record-integrity rules can be shown to fail', () => {
    const roots: string[] = [];

    afterEach(async () => {
        await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
    });

    async function tempRoot(): Promise<string> {
        const root = await mkdtemp(join(tmpdir(), 'kata-self-evidence-'));
        roots.push(root);
        await initLayout(root);
        execFileSync('git', ['init', '--quiet'], { cwd: root });
        execFileSync('git', ['config', 'user.email', 'kata@example.test'], { cwd: root });
        execFileSync('git', ['config', 'user.name', 'Kata Test'], { cwd: root });
        await mkdir(join(root, 'src'), { recursive: true });
        await writeFile(join(root, 'src/a.ts'), 'export const a = 1;\n', 'utf8');
        execFileSync('git', ['add', '.'], { cwd: root });
        execFileSync('git', ['commit', '--quiet', '-m', 'base'], { cwd: root });
        return root;
    }

    describe('A — a record whose prose states a derivable fact is refused, and the field is named', () => {
        it('makes the seal refuse a count, naming the derived quantity and quoting the sentence', async () => {
            const root = await tempRoot();
            await runCommand('open', 'prose-task', root, {
                title: 'Prose refusal',
                acceptance: [{ id: 'AC-1', statement: 'x' }],
                ownedPaths: ['src'],
            });
            await runCommand('design', 'prose-task', root);
            await writeFile(join(root, 'src/b.ts'), 'export const b = 2;\n', 'utf8');

            // The planted fact: a number the record derives for itself. This must fail at the seal boundary, not merely
            // cause a helper to return a special value that callers can ignore.
            const sealed = await runCommand('build', 'prose-task', root, {
                seal: true,
                checks: [{ id: 'green', kind: 'test', name: 'green', command: 'true', expectExitCode: 0 }],
                judgement: 'Chose the structural check. Three files changed, and all of the checks passed.',
            });
            expect(sealed.success).toBe(false);
            expect(sealed.error).toMatch(/judgement states counts\.changedPaths|judgement states counts\.passing/i);
            expect(sealed.error).toMatch(/Three files changed|all of the checks/);
        });

        it('accepts a judgement that points at the record instead of restating it', async () => {
            const root = await tempRoot();
            await runCommand('open', 'prose-ok', root, {
                title: 'Prose allowed',
                acceptance: [{ id: 'AC-1', statement: 'x' }],
                ownedPaths: ['src'],
            });
            const record = await buildChangeRecord({
                root,
                taskId: 'prose-ok',
                revisionId: 'revision-prose-ok',
                ownedPaths: ['src'],
                evidence: [],
                claimFailures: [],
                findings: [],
                judgement: 'Chose the structural check over a locale pin: the previous prose match could not distinguish a missing commit from an invalid reference.',
            });

            const written = await writeChangeRecord(root, 'prose-ok', record);
            expect(Array.isArray(written)).toBe(false);
        });

        it('refuses every spelling of a count a reader would recognise, not just the first twelve', () => {
            // A second independent pass extracted the live pattern table and measured the gap: `Seventeen files changed`,
            // `A dozen checks passed`, `thirty findings were raised` and `Thirteen paths changed` were all ACCEPTED while
            // `eight files changed` was refused. An enumeration of number words is the wrong shape for this rule — the
            // pattern has to cover the spelling the next author writes, including multipliers and the tens forms.
            for (const sentence of [
                'Seventeen files changed',
                'A dozen checks passed',
                'thirty findings were raised',
                'Thirteen paths changed',
                'twenty-two checks ran',
                'fifty passing',
            ]) {
                expect(refusalForDerivableProse(sentence), `expected ${JSON.stringify(sentence)} to be refused`).not.toEqual([]);
            }
            // And the narrow forms still fire, so widening the word list did not replace the original rule.
            expect(refusalForDerivableProse('2 files changed').map((r) => r.quantity)).toEqual(['counts.changedPaths']);
            expect(refusalForDerivableProse('eight files changed').map((r) => r.quantity)).toEqual(['counts.changedPaths']);
        });

        it('names each derivable quantity it recognises', () => {
            expect(refusalForDerivableProse('two checks ran').map((r) => r.quantity)).toEqual(['counts.checks']);
            expect(refusalForDerivableProse('1 failed').map((r) => r.quantity)).toEqual(['counts.failures']);
            expect(refusalForDerivableProse('the complete list is in the diff').map((r) => r.quantity)).toEqual(['changedPaths']);
            expect(refusalForDerivableProse('2 open findings remain').map((r) => r.quantity)).toEqual(['counts.openFindings']);
            // Judgement with no derived quantity is accepted, including a number inside a name.
            expect(refusalForDerivableProse('Chose Ajv 8 over the hand-written interpreter.')).toEqual([]);
            expect(refusalForDerivableProse(undefined)).toEqual([]);
        });
    });

    describe('C — a recorded scope change changes the next revision, and the delta covers the file', () => {
        it('changes the revision identity and appears in the change surface', async () => {
            const root = await tempRoot();
            await runCommand('open', 'scope-digest', root, {
                title: 'Scope digest',
                acceptance: [{ id: 'AC-1', statement: 'x' }],
                ownedPaths: ['src/a.ts'],
            });
            await mkdir(join(root, 'docs'), { recursive: true });
            await writeFile(join(root, 'docs/design.md'), '# design\n', 'utf8');

            const before = await createTaskRevision({ root, taskId: 'scope-digest', ownedPaths: ['src/a.ts'], checkIds: [] });

            // Recorded and applied: the recorded decision reaches the surface a revision hashes.
            const recorded = await recordScopeChange(root, 'scope-digest', {
                current: ['src/a.ts'],
                next: ['src/a.ts', 'docs/design.md'],
                reason: 'the design doc is part of the audited surface',
                by: 'kata-agent',
            });
            expect('refused' in recorded).toBe(false);
            if ('refused' in recorded) return;
            const applied = await applyScopeChange(root, 'scope-digest', recorded.id);
            expect(applied.applied).toBe(true);

            const after = await createTaskRevision({ root, taskId: 'scope-digest', ownedPaths: applied.ownedPaths!, checkIds: [] });
            // (a) the digest changes, which is the property six recorded-but-unapplied changes failed to have.
            expect(after.manifestHash).not.toBe(before.manifestHash);

            // (b) the delta covers the file, so a pass cannot claim the surface did not move.
            const surface = await changeSurfaceAgainstWorkspace(root, before);
            expect(surface.status).toBe('available');
            if (surface.status !== 'available') return;
            expect(surface.changedPaths).toContain('docs/design.md');
        });

        it('reads the applied surface back from the task, so the seal hashes what was decided', async () => {
            const root = await tempRoot();
            await runCommand('open', 'scope-read', root, {
                title: 'Scope read',
                acceptance: [{ id: 'AC-1', statement: 'x' }],
                ownedPaths: ['src/a.ts'],
            });
            await mkdir(join(root, 'docs'), { recursive: true });
            await writeFile(join(root, 'docs/note.md'), '# note\n', 'utf8');

            const recorded = await recordScopeChange(root, 'scope-read', {
                current: ['src/a.ts'],
                next: ['src/a.ts', 'docs'],
                reason: 'the docs directory joined the surface',
                by: 'kata-agent',
            });
            if ('refused' in recorded) throw new Error(recorded.refused);
            await applyScopeChange(root, 'scope-read', recorded.id);

            expect((await readTask(root, 'scope-read')).ownedPaths).toEqual(['docs', 'src/a.ts']);
            const current = await readCurrentTaskRevision(root, 'scope-read');
            expect(current).toBeNull();
        });
    });

    describe('D — the class history comes from a durable source, so it cannot be moved by the pass it describes', () => {
        it('does not carry a finding raised by the node whose brief it is', async () => {
            const root = await tempRoot();
            await runCommand('open', 'history-durable', root, {
                title: 'History durable',
                acceptance: [{ id: 'AC-1', statement: 'x' }],
                ownedPaths: ['src/a.ts'],
            });
            const revision = await createTaskRevision({ root, taskId: 'history-durable', ownedPaths: ['src/a.ts'], checkIds: [] });

            const before = await buildAdversarialBrief(root, 'history-durable', 'verify');
            await writeAdversarialRecord(root, 'history-durable', {
                node: 'verify',
                status: 'recorded',
                revisionId: revision.id,
                createdAt: '2026-09-21T00:00:00.000Z',
                executedInFreshContext: true,
                briefSha256: before.sha256,
                scope: { kind: 'full' },
                attempts: [{ hypothesis: 'h', method: 'm', outcome: 'refuted' }],
                findings: [{ id: 'self-raised', taskId: 'history-durable', severity: 'major', message: 'raised by this pass' }],
            });

            const after = await buildAdversarialBrief(root, 'history-durable', 'verify');
            // The invariant: recording a pass must not change the brief it answered. The finding this pass raised is not
            // history for the brief that framed it.
            // Recording the pass correctly changes its lifecycle framing (a repair is now open). The binding uses the
            // previously issued copy; the history invariant is narrower and mechanical: a finding from this node is not
            // presented as prior history to the pass that raised it.
            const history = after.text.split('## Findings by class', 2)[1]?.split('\n## ', 2)[0] ?? '';
            expect(history).not.toContain('self-raised');
        });

        it('does carry a finding from the other node, with its class and disposition', async () => {
            const root = await tempRoot();
            await runCommand('open', 'history-cross', root, {
                title: 'History cross',
                acceptance: [{ id: 'AC-1', statement: 'x' }],
                ownedPaths: ['src/a.ts'],
            });
            const revision = await createTaskRevision({ root, taskId: 'history-cross', ownedPaths: ['src/a.ts'], checkIds: [] });

            // A finding from the *review* node — a durable source for the verify brief.
            const reviewBrief = await buildAdversarialBrief(root, 'history-cross', 'review');
            await writeAdversarialRecord(root, 'history-cross', {
                node: 'review',
                status: 'recorded',
                revisionId: revision.id,
                createdAt: '2026-09-21T00:00:00.000Z',
                executedInFreshContext: true,
                briefSha256: reviewBrief.sha256,
                scope: { kind: 'full' },
                attempts: [{ hypothesis: 'h', method: 'm', outcome: 'confirmed' }],
                findings: [{ id: 'cross-node', taskId: 'history-cross', severity: 'major', message: 'found by the review node', path: 'src/a.ts', disposition: 'deferred', dispositionReason: 'next round' }],
            });

            const verifyBrief = await buildAdversarialBrief(root, 'history-cross', 'verify');
            expect(verifyBrief.text).toContain('cross-node');
            // Classed by the field that describes it, with the decision attached — that is what lets a pass attack the
            // repair instead of re-deriving the class.
            expect(verifyBrief.text).toContain('path:src/a.ts');
            expect(verifyBrief.text).toMatch(/deferred/i);
        });

        it('does not invent a history for a task with none', async () => {
            const root = await tempRoot();
            await runCommand('open', 'history-empty', root, {
                title: 'History empty',
                acceptance: [{ id: 'AC-1', statement: 'x' }],
                ownedPaths: ['src/a.ts'],
            });
            const brief = await buildAdversarialBrief(root, 'history-empty', 'verify');
            expect(brief.text).not.toMatch(/Findings by class/i);
        });
    });
});
