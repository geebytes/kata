import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initLayout } from '../../src/core/layout.js';
import { createTask } from '../../src/core/task.js';
import { createTaskRevision, readTaskRevision } from '../../src/workflow/revision.js';
import { buildAdversarialBrief } from '../../src/quality/adversarial.js';

/**
 * AC-1 of `kata-gate-surface`. The change surface a round reviews has **one** derivation.
 *
 * Written this way on purpose: the test **enumerates the producers** and asserts they agree, rather than asserting one pair.
 * That is the mistake that let f8 survive — the test written for it asserted the record against the gate and nothing else,
 * and `wcc2-f1` found the next pair immediately (the brief's delta against the gate), then `wcc3-f1` the pair after that
 * (the brief's own declared delta against its own prose).
 *
 * So every producer reachable from here is listed, and the assertion is that none of them disagrees with the others.
 */
const cleanup: string[] = [];

async function fixture(id: string): Promise<{ root: string; first: string; second: string }> {
    const root = await mkdtemp(join(tmpdir(), `kata-surface-${id}-`));
    cleanup.push(root);
    await initLayout(root);
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src/one.ts'), 'export const one = 1;\n', 'utf8');
    await createTask({
        root,
        id,
        title: id,
        ownedPaths: ['src/one.ts'],
        acceptance: [{ id: 'AC-1', statement: 'the surface has one derivation' }],
    } as never);
    // Two revisions, because a delta only exists between two: the second changes a file the first hashed.
    const first = await createTaskRevision({ root, taskId: id, ownedPaths: ['src/one.ts'], checkIds: [] });
    await writeFile(join(root, 'src/two.ts'), 'export const two = 2;\n', 'utf8');
    const second = await createTaskRevision({ root, taskId: id, ownedPaths: ['src/one.ts', 'src/two.ts'], checkIds: [] });
    return { root, first: first.id, second: second.id };
}

describe('the change surface has one derivation', () => {
    afterEach(async () => {
        await Promise.all(cleanup.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
    });

    it('the brief declares one scope, and its own prose does not contradict it', async () => {
        const { root, first, second } = await fixture('one-derivation');
        // `since` is what puts the round on the delta path without needing a closed repair batch: the same code path the
        // default scope takes when a batch closes, reached explicitly.
        const brief = await buildAdversarialBrief(root, 'one-derivation', 'review', { since: first });

        // Producer 1: the structured scope the round is bound to.
        const declared = brief.ir?.scope
            ? brief.ir.scope.kind === 'delta'
                ? [...brief.ir.scope.changedPaths]
                : [...brief.ir.scope.paths]
            : [];
        // Producer 2: the prose the reviewer reads. It is generated from the same facts, so it cannot disagree.
        const proseLine = brief.text.split('\n').find((line) => line.startsWith('Paths under review:')) ?? '';
        const prose = proseLine
            .replace('Paths under review:', '')
            .split(',')
            .map((path) => path.trim())
            .filter((path) => path.length > 0 && path !== '(none declared)');

        const onlyInProse = prose.filter((path) => !declared.includes(path));
        const onlyInScope = declared.filter((path) => !prose.includes(path));

        expect({ onlyInProse, onlyInScope }).toEqual({ onlyInProse: [], onlyInScope: [] });

        // Producer 3: the sealed change record's changed paths — a **different derivation** from the delta's, which is
        // exactly the pair wcc3-f1 measured (the brief's declared delta held three paths, the record for the same revision
        // held five). Enumerating only producers 1 and 2 would repeat the mistake that let f8 survive.
        // `buildChangeRecord` computes a record; it does not persist one — the seal does. Measured twice: first the file was
        // never written, then it was written to the revision-suffixed path while `readChangeRecord` reads the plain
        // `change-record.json`. Both read as "the record reports nothing". Without this
        // write the fixture read an empty array and the test looked like a real divergence, when it was the fixture
        // reading a file that was never created. That is why the previous commit refused to call the disagreement real.
        const { buildChangeRecord, changeRecordPath, readChangeRecord } = await import('../../src/quality/change-record.js');
        const { writeFile: writeRecord } = await import('node:fs/promises');
        const built = await buildChangeRecord({
            root,
            taskId: 'one-derivation',
            revisionId: second,
            ownedPaths: ['src/one.ts', 'src/two.ts'],
            evidence: [],
            claimFailures: [],
            findings: [],
            contentDigests: { 'src/one.ts': 'aaa', 'src/two.ts': 'bbb' },
            baseContentDigests: { 'src/one.ts': 'aaa' },
        });
        await writeRecord(changeRecordPath(root, 'one-derivation'), `${JSON.stringify(built, null, 2)}\n`, 'utf8');
        const record = await readChangeRecord(root, 'one-derivation');
        const recorded = [...(record?.changedPaths ?? [])].sort();

        const onlyInRecord = recorded.filter((path) => !declared.includes(path));
        const missingFromRecord = declared.filter((path) => !recorded.includes(path));
        expect({ onlyInRecord, missingFromRecord }).toEqual({ onlyInRecord: [], missingFromRecord: [] });

        // Refuses to pass vacuously. A **full** round has no delta, so both producers agree trivially and this test would
        // go green while the defect it is written for lives — measured: on a minimal fixture it did exactly that. The
        // producers disagree on a **delta**, so the fixture must construct one (a base revision and a repair batch), and
        // until it does this test states the gap instead of reporting success.
        expect({
            note: 'this fixture must exercise the delta path, or the assertion above proves nothing',
            scopeKind: brief.ir?.scope?.kind ?? 'none',
        }).toEqual({ note: 'this fixture must exercise the delta path, or the assertion above proves nothing', scopeKind: 'delta' });
    });

    it('issues a delta scope that is the surface the gate verifies against, not the workspace-only one', async () => {
        // `rba-f9`: the brief issued its delta from `changeSurfaceAgainstWorkspace` — the owned-path manifest plus live
        // `git status` — while the gate verifies a recorded delta with `revisionChangeSurface`, which diffs the two
        // revisions' `contentDigests`. A repair committed outside the declaration was therefore in the gate's surface and
        // absent from the brief's, and the gate refused the round's own record with `delta_stale`. Two derivations of one
        // quantity; the brief must issue the one the gate measures.
        const root = await mkdtemp(join(tmpdir(), 'kata-surface-delta-'));
        cleanup.push(root);
        await initLayout(root);
        execFileSync('git', ['init', '--quiet'], { cwd: root });
        execFileSync('git', ['config', 'user.email', 'kata@example.test'], { cwd: root });
        execFileSync('git', ['config', 'user.name', 'Kata Test'], { cwd: root });
        await mkdir(join(root, 'src'), { recursive: true });
        await writeFile(join(root, 'src/one.ts'), 'export const one = 1;\n', 'utf8');
        await createTask({
            root, id: 'delta-scope', title: 'delta-scope', ownedPaths: ['src/one.ts'],
            acceptance: [{ id: 'AC-1', statement: 'the brief issues the gate\'s surface' }],
        } as never);
        execFileSync('git', ['add', '-A'], { cwd: root });
        execFileSync('git', ['commit', '--quiet', '-m', 'base'], { cwd: root });
        const base = await createTaskRevision({ root, taskId: 'delta-scope', ownedPaths: ['src/one.ts'], checkIds: [] });
        // The repair commits a path outside the declaration, and the round re-seals — so the workspace is clean and only
        // the sealed content snapshots can see the change.
        await writeFile(join(root, 'src/outside.ts'), 'export const outside = 2;\n', 'utf8');
        execFileSync('git', ['add', '-A'], { cwd: root });
        execFileSync('git', ['commit', '--quiet', '-m', 'the repair changed a path outside the declaration'], { cwd: root });
        const current = await createTaskRevision({ root, taskId: 'delta-scope', ownedPaths: ['src/one.ts'], checkIds: [] });

        const brief = await buildAdversarialBrief(root, 'delta-scope', 'review', { since: base.id });
        const declared = brief.ir?.scope?.kind === 'delta' ? [...brief.ir.scope.changedPaths] : [];

        // The gate's surface for the same pair of revisions — the one the pass must cover or be refused `delta_stale`.
        const { revisionChangeSurface } = await import('../../src/quality/revision-delta.js');
        const sealed = revisionChangeSurface(
            await readTaskRevision(root, 'delta-scope', base.id),
            await readTaskRevision(root, 'delta-scope', current.id),
        );
        expect(sealed.status).toBe('available');
        if (sealed.status === 'available') {
            expect([...declared].sort()).toEqual([...sealed.changedPaths].sort());
            expect(declared).toContain('src/outside.ts');
        }
    });
});
