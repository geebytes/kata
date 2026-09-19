import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { findingLayer, instrumentPaths, isInstrumentPath } from '../../src/quality/code-surface.js';
import { classifyFindingCoverage, validateBoundaries } from '../../src/quality/instrument-boundary.js';
import { dispositionDenial } from '../../src/quality/finding-disposition.js';

/**
 * §21.1 and §21.2, together: an instrument is a third class of owned path, and a **declared** boundary is what gives an
 * adversarial search against a guard a terminating condition.
 *
 * The measurement: five consecutive rounds of one real task became an arms race against a guard's coverage boundary —
 * "your guard does not cover dimension X" — every round, until the guard is deleted or its boundary is declared. The
 * product layer stopped producing findings at r18; everything after was the tooling.
 */
describe('instruments and their declared boundaries', () => {
    const roots: string[] = [];
    afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

    const task = { instruments: ['scripts/assert_acceptance_claims.py'], ownedPaths: ['scripts/', 'src/', 'docs/'] };

    it('is declared, never inferred, and classifies paths by the declaration', () => {
        expect(instrumentPaths(task)).toEqual(['scripts/assert_acceptance_claims.py']);
        expect(isInstrumentPath(task, 'scripts/assert_acceptance_claims.py')).toBe(true);
        // A sibling that was not declared is not an instrument, however instrument-shaped it looks.
        expect(isInstrumentPath(task, 'scripts/heldout-qualification-real.py')).toBe(false);
        // A task that declares none has none: the layer only exists for tasks that asked for it.
        expect(isInstrumentPath({ instruments: [] }, 'scripts/assert_acceptance_claims.py')).toBe(false);
    });

    it('assigns each finding a layer from the path it names', () => {
        expect(findingLayer(task, 'scripts/assert_acceptance_claims.py')).toBe('instrument');
        expect(findingLayer(task, 'docs/spec.md')).toBe('governance');
        expect(findingLayer(task, 'src/core/task.ts')).toBe('deliverable');
        // A finding naming no path is a deliverable finding — the default the gate is built for, and guessing otherwise
        // would let an unlocated finding escape to the advisory layer.
        expect(findingLayer(task, undefined)).toBe('deliverable');
    });

    it('refuses a boundary for an undeclared instrument, a missing statement, or an empty boundary', async () => {
        const root = await mkdtemp(join(tmpdir(), 'kata-boundary-'));
        roots.push(root);
        await mkdir(join(root, 'docs'), { recursive: true });
        await writeFile(join(root, 'docs/checker-boundary.md'), '# boundary\n', 'utf8');

        expect(validateBoundaries(root, task, {
            boundaries: [{ instrument: 'scripts/other.py', covers: ['a'], doesNotCover: [{ dimension: 'x', reason: 'y' }], canonicalStatement: 'docs/checker-boundary.md' }],
        })[0]).toMatchObject({ reason: 'undeclared_instrument' });

        expect(validateBoundaries(root, task, {
            boundaries: [{ instrument: 'scripts/assert_acceptance_claims.py', covers: ['a'], doesNotCover: [{ dimension: 'x', reason: 'y' }], canonicalStatement: 'docs/missing.md' }],
        })[0]).toMatchObject({ reason: 'missing_canonical_statement' });

        expect(validateBoundaries(root, task, {
            boundaries: [{ instrument: 'scripts/assert_acceptance_claims.py', covers: ['a'], doesNotCover: [], canonicalStatement: 'docs/checker-boundary.md' }],
        })[0]).toMatchObject({ reason: 'empty_boundary' });

        // And a well-formed declaration passes.
        expect(validateBoundaries(root, task, {
            boundaries: [{ instrument: 'scripts/assert_acceptance_claims.py', covers: ['clause-to-command'], doesNotCover: [{ dimension: 'languages other than Python', reason: 'the project is Python' }], canonicalStatement: 'docs/checker-boundary.md' }],
        })).toEqual([]);
    });

    it('classifies a finding beyond the boundary only when it quotes a declared dimension', () => {
        const declaration = {
            boundaries: [{
                instrument: 'scripts/assert_acceptance_claims.py',
                covers: ['clause-to-command'],
                doesNotCover: [{ dimension: 'languages other than Python', reason: 'the project is Python' }],
                canonicalStatement: 'docs/checker-boundary.md',
            }],
        };

        // Quoting the declared dimension: beyond the boundary, closeable against the declaration.
        expect(classifyFindingCoverage(task, declaration, {
            path: 'scripts/assert_acceptance_claims.py',
            message: 'the checker would not detect the same clause written in languages other than Python',
        })).toMatchObject({ classification: 'beyond-declared-coverage', dimension: 'languages other than Python', canonicalStatement: 'docs/checker-boundary.md' });

        // A real gap in a covered dimension: still within, still must be repaired.
        expect(classifyFindingCoverage(task, declaration, {
            path: 'scripts/assert_acceptance_claims.py',
            message: 'the clause-to-command mapping drops a clause when the statement has two verbs',
        })).toMatchObject({ classification: 'within-declared-coverage' });

        // No declaration at all: the guard is answerable for everything it could cover, and that is said rather than assumed.
        const undecided = classifyFindingCoverage(task, null, { path: 'scripts/assert_acceptance_claims.py', message: 'anything' });
        expect(undecided).toMatchObject({ classification: 'within-declared-coverage' });
        expect(undecided?.undecidable).toMatch(/no boundary declaration/);

        // A deliverable finding has no boundary to be outside of.
        expect(classifyFindingCoverage(task, declaration, { path: 'src/core/task.ts', message: 'x' })).toBeNull();
    });

    it('lets a boundary closure relax I1 — and only with the declaration as the reason', () => {
        const blocking = { id: 'f-1', taskId: 't', severity: 'blocking' as const, message: 'dimension not covered', path: 'scripts/assert_acceptance_claims.py', disposition: 'open' as const, source: 'review' as const };

        // Without a coverage verdict, the invariant holds: blocking must be repaired.
        expect(dispositionDenial(blocking, 'deferred', 'because')).toMatch(/must be repaired/);

        // With it, the closure is allowed — and the reason is still required, so it cannot be a silent burial.
        expect(dispositionDenial(blocking, 'deferred', 'because', { classification: 'beyond-declared-coverage', dimension: 'languages other than Python', canonicalStatement: 'docs/checker-boundary.md' })).toBeNull();
        expect(dispositionDenial(blocking, 'deferred', undefined, { classification: 'beyond-declared-coverage', dimension: 'x' })).toMatch(/requires --reason/);
    });
});

describe('§21.3: growth is a recorded decision, not a drift', () => {
    const roots: string[] = [];
    afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

    async function workspace(): Promise<string> {
        const root = await mkdtemp(join(tmpdir(), 'kata-scope-'));
        roots.push(root);
        const { initLayout } = await import('../../src/core/layout.js');
        const { createTask } = await import('../../src/core/task.js');
        await initLayout(root);
        await createTask({ root, id: 'grow', title: 'Grow', ownedPaths: ['src/'], acceptance: [{ id: 'AC-1', statement: 'x' }] });
        return root;
    }

    it('requires a reason and refuses a change that changes nothing', async () => {
        const root = await workspace();
        const { recordScopeChange } = await import('../../src/quality/scope-change.js');

        // Growth expands what a round is about; an unexplained one is the drift this exists to record.
        expect(await recordScopeChange(root, 'grow', { next: ['src/', 'scripts/'], current: ['src/'], reason: '   ', by: 'agent' }))
            .toMatchObject({ refused: expect.stringContaining('requires --reason') });
        expect(await recordScopeChange(root, 'grow', { next: ['src/'], current: ['src/'], reason: 'nothing', by: 'agent' }))
            .toMatchObject({ refused: expect.stringContaining('nothing to record') });
    });

    it('records what grew, by whom, why — and the revision the growth is measured against', async () => {
        const root = await workspace();
        const { recordScopeChange, readScopeChanges, lastScopeChangeBase } = await import('../../src/quality/scope-change.js');
        const { createTaskRevision } = await import('../../src/workflow/revision.js');
        const base = await createTaskRevision({ root, taskId: 'grow', ownedPaths: ['src'], checkIds: [] });

        const recorded = await recordScopeChange(root, 'grow', {
            next: ['src/', 'scripts/assert_acceptance_claims.py'],
            current: ['src/'],
            reason: 'the acceptance claims need a checker the project can run',
            by: 'author',
        });
        expect(recorded).toMatchObject({ id: 'scope-1', added: ['scripts/assert_acceptance_claims.py'], removed: [], by: 'author' });
        // The base is read here, not supplied: a caller passing the revision they are about to seal would empty the delta.
        expect((recorded as { baseRevisionId?: string }).baseRevisionId).toBe(base.id);
        expect((await readScopeChanges(root, 'grow')).changes).toHaveLength(1);
        expect(await lastScopeChangeBase(root, 'grow')).toMatchObject({ id: base.id });
    });

    it('reports growth that never went through the decision', async () => {
        const root = await workspace();
        const { recordScopeChange, unreportedScopeGrowth } = await import('../../src/quality/scope-change.js');
        await recordScopeChange(root, 'grow', { next: ['src/', 'scripts/'], current: ['src/'], reason: 'checker', by: 'author' });

        // A path the record has never seen is exactly the silent growth the measured task showed four times.
        expect(await unreportedScopeGrowth(root, 'grow', ['src/', 'scripts/', 'tests/test_checker.py']))
            .toEqual(['tests/test_checker.py']);
        expect(await unreportedScopeGrowth(root, 'grow', ['src/', 'scripts/'])).toEqual([]);
    });
});

describe('the scope surface (§21.1–§21.3), through the command handlers', () => {
    const roots: string[] = [];
    afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

    it('declares an instrument, records its boundary, and refuses a boundary that cannot be closed against', async () => {
        const root = await mkdtemp(join(tmpdir(), 'kata-scope-cli-'));
        roots.push(root);
        const { initLayout } = await import('../../src/core/layout.js');
        const { createTask } = await import('../../src/core/task.js');
        const { runScopeCommand } = await import('../../src/cli/scope.js');
        await initLayout(root);
        await createTask({ root, id: 'cli', title: 'CLI', ownedPaths: ['src/'], acceptance: [{ id: 'AC-1', statement: 'x' }] });
        await mkdir(join(root, 'docs'), { recursive: true });
        await writeFile(join(root, 'docs/checker-boundary.md'), '# boundary\n', 'utf8');
        const previousCwd = process.cwd();
        process.chdir(root);
        try {

        // A boundary before the instrument is declared is refused — you cannot set a boundary for something you have not
        // admitted is an instrument.
        await expect(runScopeCommand(['boundary', '--change', 'cli', '--instrument', 'scripts/checker.py', '--statement', 'docs/checker-boundary.md', '--excludes', 'languages other than Python: the project is Python']))
            .rejects.toThrow(/not in the task's instruments/);

        const declared = await runScopeCommand(['declare', '--change', 'cli', '--instrument', 'scripts/checker.py']);
        expect(declared).toMatchObject({ instruments: ['scripts/checker.py'] });

        const boundary = await runScopeCommand(['boundary', '--change', 'cli', '--instrument', 'scripts/checker.py', '--statement', 'docs/checker-boundary.md', '--excludes', 'languages other than Python: the project is Python']);
        expect(boundary.instrument).toBe('scripts/checker.py');

        const shown = await runScopeCommand(['show', '--change', 'cli']);
        expect(shown.instruments).toEqual([{ path: 'scripts/checker.py', layer: 'instrument', owned: false }]);
        expect(shown.boundaries).toHaveLength(1);
        } finally {
            process.chdir(previousCwd);
        }
    });

    it('records a scope change through the CLI, and reports growth that skipped it', async () => {
        const root = await mkdtemp(join(tmpdir(), 'kata-scope-cli2-'));
        roots.push(root);
        const { initLayout } = await import('../../src/core/layout.js');
        const { createTask } = await import('../../src/core/task.js');
        const { runScopeCommand } = await import('../../src/cli/scope.js');
        await initLayout(root);
        await createTask({ root, id: 'cli2', title: 'CLI2', ownedPaths: ['src/'], acceptance: [{ id: 'AC-1', statement: 'x' }] });
        const previousCwd = process.cwd();
        process.chdir(root);
        try {
            const recorded = await runScopeCommand(['change', '--change', 'cli2', '--add', 'scripts/checker.py', '--reason', 'the claims need a checker']);
            expect(recorded).toMatchObject({ added: ['scripts/checker.py'], removed: [] });

            // No reason is refused.
            await expect(runScopeCommand(['change', '--change', 'cli2', '--add', 'scripts/other.py'])).rejects.toThrow(/requires --reason/);
        } finally {
            process.chdir(previousCwd);
        }
    });
});

describe('§24.4: the instrument surface, so an instrument edit does not expire the deliverable pass', () => {
    const roots: string[] = [];
    afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

    const revisionWith = (digests: Record<string, string>): { ownedPaths: string[]; pathDigests: Record<string, string> } => ({
        ownedPaths: Object.keys(digests),
        pathDigests: digests,
    });

    it('splits three ways, and subtracts instruments before the code/governance split', async () => {
        const { splitOwnedPaths, surfaceDigests } = await import('../../src/quality/code-surface.js');
        const task = { instruments: ['scripts/checker.py'] };
        const split = splitOwnedPaths(['src/a.ts', 'docs/b.md', 'scripts/checker.py'], task);
        expect(split).toEqual({ instruments: ['scripts/checker.py'], code: ['src/a.ts'], nonCode: ['docs/b.md'] });

        // An instrument written in Markdown is still an instrument: the declaration is the more specific statement.
        expect(splitOwnedPaths(['docs/checker.md'], { instruments: ['docs/checker.md'] }).instruments).toEqual(['docs/checker.md']);

        const before = surfaceDigests(revisionWith({ 'src/a.ts': 'h1', 'docs/b.md': 'd1', 'scripts/checker.py': 'c1' }), task);
        const instrumentEdited = surfaceDigests(revisionWith({ 'src/a.ts': 'h1', 'docs/b.md': 'd1', 'scripts/checker.py': 'c2' }), task);
        // Editing the checker moves the instrument surface only — the code surface is what a deliverable pass binds to.
        expect(instrumentEdited.instrument).not.toBe(before.instrument);
        expect(instrumentEdited.code).toBe(before.code);
        expect(instrumentEdited.governance).toBe(before.governance);
    });

    it('spares a pass when only the instrument surface moved, and still requires the claims to be re-read', async () => {
        const { evaluateAdversarialGate } = await import('../../src/quality/adversarial.js');
        const record = {
            node: 'verify' as const,
            status: 'recorded' as const,
            revisionId: 'revision-1',
            manifestHash: 'manifest-1',
            codeManifestHash: 'code-1',
            instrumentManifestHash: 'inst-1',
            governanceManifestHash: 'gov-1',
            createdAt: '2026-09-19T00:00:00.000Z',
            executedInFreshContext: true,
            briefSha256: 'brief-1',
            verdict: 'no_defect_found' as const,
            attempts: [{ hypothesis: 'h', method: 'm', outcome: 'refuted' as const }],
            findings: [],
            scope: { kind: 'full' as const },
        };
        const gate = (overrides: Record<string, unknown> = {}): ReturnType<typeof evaluateAdversarialGate> =>
            evaluateAdversarialGate(record, {
                node: 'verify',
                revisionId: 'revision-2',
                manifestHash: 'manifest-2',
                codeManifestHash: 'code-1',
                instrumentManifestHash: 'inst-1',
                governanceManifestHash: 'gov-2',
                issuedBriefSha256s: ['brief-1'],
                claimsVerified: true,
                ...overrides,
            });

        // Governance text moved, code and instrument identical: the code pass stands (C2's path).
        expect(gate()).toMatchObject({ satisfied: true });
        // Only the instrument moved: same answer, and that is §24.4.
        expect(gate({ governanceManifestHash: 'gov-1', instrumentManifestHash: 'inst-2' })).toMatchObject({ satisfied: true });
        // The deliverable moved: nothing is spared.
        expect(gate({ codeManifestHash: 'code-2' })).toMatchObject({ satisfied: false, reason: 'stale_revision' });
        // And the precondition is the same on both paths.
        expect(gate({ instrumentManifestHash: 'inst-2', governanceManifestHash: 'gov-1', claimsVerified: false }))
            .toMatchObject({ satisfied: false, reason: 'stale_revision' });
    });

    it('binds per surface through bindsToRevision', async () => {
        const { bindsToRevision } = await import('../../src/workflow/verdict-binding.js');
        const current = { revisionId: 'r2', manifestHash: 'm2', codeManifestHash: 'c1', instrumentManifestHash: 'i2', governanceManifestHash: 'g1' };
        const artifact = { codeManifestHash: 'c1', instrumentManifestHash: 'i1', governanceManifestHash: 'g1' };

        expect(bindsToRevision(artifact, current, { scope: 'code' })).toBe(true);
        expect(bindsToRevision(artifact, current, { scope: 'instrument' })).toBe(false);
        expect(bindsToRevision(artifact, current, { scope: 'governance' })).toBe(true);
        // The default is unchanged: still `full`, so no existing caller is loosened by the new scopes.
        expect(bindsToRevision(artifact, current)).toBe(false);
    });
});
