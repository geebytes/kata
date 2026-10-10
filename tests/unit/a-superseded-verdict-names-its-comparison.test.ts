import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { initLayout } from '../../src/core/layout.js';
import { runCommand } from '../../src/workflow/orchestrator.js';
import { hashContent } from '../../src/core/hash.js';
import { readCurrentTaskRevisionState, readTaskRevision, revisionStatus } from '../../src/workflow/revision.js';

/**
 * **AC-2 — a `superseded` verdict names the comparison that produced it.**
 *
 * The status carried only two manifest *hashes*: `expectedManifestHash` and `revisionManifestHash`. Neither names a file,
 * and the map an operator can actually diff was useless for the purpose — `contentDigests` is built by the filtered walk, so
 * it **excludes exactly the declared paths that can move invisibly**. Measured downstream: the author of the report this
 * change exists for verified all 595 content digests one by one, found no difference, and concluded the gate was
 * self-refuting; the truth was three declared paths whose *own* digests (`pathDigests`) had moved. The verdict was right and
 * could not be witnessed from any artefact.
 *
 * So the verdict carries: which revision, which paths differ, and for each the recorded and the observed digest — computed
 * by the same derivation that produced the recorded ones (`feedOwnedTree`), so the comparison has one answer rather than two.
 */
const execFileAsync = promisify(execFile);
const roots: string[] = [];
const taskId = 'superseded-names-its-comparison';

afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function git(root: string, args: string[]): Promise<void> {
    await execFileAsync('git', args, { cwd: root });
}

const declared = ['src/kept.ts', 'src/moved.ts', 'src/also-moved.ts'];

async function fixture(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'kata-superseded-'));
    roots.push(root);
    await git(root, ['init', '-q']);
    await git(root, ['config', 'user.email', 'kata@example.test']);
    await git(root, ['config', 'user.name', 'Kata Test']);
    await initLayout(root);
    await mkdir(join(root, 'src'), { recursive: true });
    for (const path of declared) await writeFile(join(root, path), `export const value = '${path}';\n`);
    await git(root, ['add', '-A']);
    await git(root, ['commit', '-qm', 'baseline']);
    await runCommand('open', taskId, root, {
        title: 'Superseded comparison fixture',
        acceptance: [{ id: 'AC-1', statement: 'The verdict names its comparison.' }],
    });
    await runCommand('design', taskId, root);

    const check = { id: 'trivial', name: 'trivial', kind: 'test' as const, command: process.execPath, cwd: root, args: ['-e', 'process.exit(0)'] };
    const sealed = await runCommand('build', taskId, root, { seal: true, ownedPaths: declared, checks: [check] });
    expect(sealed.success, JSON.stringify(sealed).slice(0, 300)).toBe(true);
    return root;
}

describe('a superseded verdict names what it compared', () => {
    it('names the paths that differ, with the recorded and the observed digest for each', async () => {
        const root = await fixture();
        // Two of the three declared paths move after the seal, so the payload has to distinguish them from the untouched one.
        await writeFile(join(root, 'src/moved.ts'), 'export const value = "moved after the seal";\n');
        await writeFile(join(root, 'src/also-moved.ts'), 'export const value = "also moved";\n');

        const current = await readCurrentTaskRevisionState(root, taskId);
        expect(current.kind).toBe('current');
        if (current.kind !== 'current') return;
        const revision = (await readTaskRevision(root, taskId, current.revision.id))!;
        const status = await revisionStatus(root, revision, taskId);

        expect(status.status).toBe('superseded');
        if (status.status !== 'superseded') return;
        // The comparison, not just two hashes: which revision, which paths, recorded vs observed.
        expect(status.revisionId).toBe(revision.id);
        expect(status.differingPaths.map((entry) => entry.path)).toEqual(['src/also-moved.ts', 'src/moved.ts']);
        for (const entry of status.differingPaths) {
            // The recorded side is what the seal wrote; the observed side is the file as it is now — and the observed digest is
            // recomputed here from the bytes, so the payload cannot be self-consistent and wrong.
            expect(entry.recorded).toBe(revision.pathDigests?.[entry.path]);
            expect(entry.observed).toBe(hashContent(await readFile(join(root, entry.path))));
            expect(entry.observed).not.toBe(entry.recorded);
        }
        // The untouched declared path is not named, so a reader can tell "this one moved" from "everything is suspect".
        expect(status.differingPaths.map((entry) => entry.path)).not.toContain('src/kept.ts');
    }, 120_000);

    it('persists the comparison in the verify verdict a reviewer reads', async () => {
        const root = await fixture();
        await writeFile(join(root, 'src/moved.ts'), 'export const value = "moved";\n');

        await runCommand('verify', taskId, root);

        // `verify.json` is the artefact a reviewer reads instead of re-running anything, so the comparison has to be in it — a
        // value computed for the operator's terminal and not written down is the mechanism-without-a-consumer shape.
        const verdict = JSON.parse(await readFile(join(root, '.kata', 'tasks', taskId, 'verify.json'), 'utf8')) as {
            result?: string;
            supersededComparison?: { revisionId?: string; differingPaths?: Array<{ path: string; recorded: string | null; observed: string | null }> };
        };
        expect(verdict.result).toBe('FAIL');
        expect(verdict.supersededComparison?.revisionId).toBeTruthy();
        expect(verdict.supersededComparison?.differingPaths?.map((entry) => entry.path)).toEqual(['src/moved.ts']);
    }, 120_000);

    it('tells the two drift states apart: a moved declaration reports the declaration sets, not an empty path list', async () => {
        // **`!revisionIsCurrent` is true for two different facts, and the first version of this payload recorded both as
        // content drift.** Measured by an independent round: for a `declaration-moved` state the record said
        // `{revisionId, differingPaths: []}` — "no path changed" — while the real comparison (`added: ["src/b.ts"]`) was
        // discarded, and the manifest was in fact *equal*. A reviewer reading that artefact is told the opposite of the truth.
        const root = await fixture();
        const current = await readCurrentTaskRevisionState(root, taskId);
        expect(current.kind).toBe('current');
        if (current.kind !== 'current') return;
        const revision = (await readTaskRevision(root, taskId, current.revision.id))!;

        // The declaration moves: a fourth path is declared, and no content changes at all. Written to the task record directly,
        // because the fixture owns that file and the managed route (`kata-cli scope change` + `scope apply`) is exercised by
        // its own cases — what this one is about is what `revisionStatus` and `verify` report for the state it produces.
        const taskPath = join(root, '.kata', 'tasks', taskId, 'task.json');
        const record = JSON.parse(await readFile(taskPath, 'utf8')) as { ownedPaths?: string[] };
        await writeFile(taskPath, `${JSON.stringify({ ...record, ownedPaths: [...declared, 'src/fourth.ts'] }, null, 2)}\n`);
        const status = await revisionStatus(root, revision, taskId);
        expect(status.status, JSON.stringify(status)).toBe('declaration-moved');

        await runCommand('verify', taskId, root);
        const verdict = JSON.parse(await readFile(join(root, '.kata', 'tasks', taskId, 'verify.json'), 'utf8')) as {
            supersededComparison?: { kind?: string; revisionId?: string; added?: string[]; removed?: string[]; differingPaths?: unknown[] };
        };

        expect(verdict.supersededComparison?.kind).toBe('declaration-moved');
        expect(verdict.supersededComparison?.revisionId).toBe(revision.id);
        expect(verdict.supersededComparison?.added).toEqual(['src/fourth.ts']);
        expect(verdict.supersededComparison?.removed).toEqual([]);
        // The content comparison is absent rather than an empty list, because in this state it was not the comparison made.
        expect(verdict.supersededComparison?.differingPaths).toBeUndefined();
    }, 120_000);

    it('names a declared path whose key is exactly `__proto__`, rather than reporting no paths at all', async () => {
        // **A filename can be a prototype key.** On a plain object `map['__proto__'] = digest` is a silent no-op, so a
        // declared root-level `__proto__` file was dropped from the recorded set and from the observed set alike: a real move
        // reported `differingPaths: []` while the manifest hashes differed. Measured by an independent round; the sibling
        // guard (`the-recorded-digests-are-the-seals-map`) covers `computePathDigests`, not the revision's own map, and the
        // case there had the file *under a directory*, which does not exercise the dangerous key shape.
        const root = await fixture();
        await writeFile(join(root, '__proto__'), 'root-level prototype key\n');
        await git(root, ['add', '-A']);
        await git(root, ['commit', '-qm', 'add the prototype-key file']);
        const withProto = [...declared, '__proto__'];
        const check = { id: 'trivial', name: 'trivial', kind: 'test' as const, command: process.execPath, cwd: root, args: ['-e', 'process.exit(0)'] };
        const first = await runCommand('build', taskId, root, { seal: true, ownedPaths: withProto, checks: [check] });
        // A second seal over the same declaration, because the fixture's first seal did not know about this path.
        expect([true, false]).toContain(first.success);

        await writeFile(join(root, '__proto__'), 'root-level prototype key, moved\n');
        const current = await readCurrentTaskRevisionState(root, taskId);
        expect(current.kind).toBe('current');
        if (current.kind !== 'current') return;
        const revision = (await readTaskRevision(root, taskId, current.revision.id))!;
        const status = await revisionStatus(root, revision, taskId);

        expect(status.status).toBe('superseded');
        if (status.status !== 'superseded') return;
        const entry = status.differingPaths.find((candidate) => candidate.path === '__proto__');
        expect(entry, `differingPaths: ${JSON.stringify(status.differingPaths)}`).toBeDefined();
        // **Both sides of the payload, not just the naming.** An assertion that the path appears is satisfied by one map
        // keeping the key while the other drops it — the path shows up as newly appearing, with `recorded: null`, which is a
        // false statement about the seal (it did record this path). So the recorded side has to carry a digest.
        expect(typeof entry?.recorded, `recorded: ${String(entry?.recorded)}`).toBe('string');
        expect(entry?.recorded).toBe(revision.pathDigests?.['__proto__']);
        // **The observed side too.** With a plain object for that map the union still names the path — from the recorded side —
        // but the value it reads is the prototype object, so the payload carries `{}` where a digest belongs. The type is the
        // assertion that makes that map load-bearing rather than defensive.
        expect(typeof entry?.observed, `observed: ${String(entry?.observed)}`).toBe('string');

        // And the two derivations that produce those maps, asked directly, because the end-to-end verdict can be right while
        // one of them is blind: measured here — reverting the recorded map alone left this case green before the assertion
        // below existed, because the path still appeared on the observed side. Each map is asserted where it is built.
        //
        // The three maps are each load-bearing, and the third one measurably so: with a plain object for the observed side, the
        // union still names the path (from the recorded side) but the *observed* value is the object's prototype rather than a
        // digest — an illegal payload — which the type assertion below catches. (Two comments here have been corrected by
        // independent rounds: the first claimed the recorded side was not load-bearing, the second claimed a plain observed map
        // would report `observed: null`. Both were measurements I had not taken.)
        const { computeBothOwnedDigests, computeContentDigests } = await import('../../src/workflow/revision.js');
        const recordedSet = await computeBothOwnedDigests(root, withProto);
        expect(Object.keys(recordedSet.pathDigests), 'the seal records a root-level `__proto__` path').toContain('__proto__');
        const content = await computeContentDigests(root);
        expect(Object.keys(content), "the identity's content map holds it too").toContain('__proto__');
    }, 120_000);

    it('refuses a drift payload whose kind contradicts the comparison it carries', async () => {
        // **A label is not a constraint.** Round 1's finding was that a `declaration-moved` state was recorded as content
        // drift with an empty path list — the false statement this field exists to make impossible — and adding `kind` only
        // labelled it: an independent round measured the schema accepting `content-moved` + `differingPaths: []` and
        // `declaration-moved` with no sets at all. So the union is enforced with `oneOf`, and this case is the gate: each of
        // these payloads is a lie about the state it describes.
        const { validate } = await import('../../src/core/schema.js');
        const base = { taskId: 'schema-union', result: 'FAIL', diffHash: 'h', acceptance: [] };

        const accepted = { kind: 'content-moved', revisionId: 'revision-1', differingPaths: [{ path: 'src/a.ts', recorded: 'a', observed: 'b' }] };
        expect(() => validate('verify-result', { ...base, supersededComparison: accepted }), 'a true content-drift payload').not.toThrow();
        const declaration = { kind: 'declaration-moved', revisionId: 'revision-1', added: ['src/a.ts'], removed: [] };
        expect(() => validate('verify-result', { ...base, supersededComparison: declaration }), 'a declaration payload carries its sets').not.toThrow();

        const lies = [
            { kind: 'content-moved', revisionId: 'revision-1', differingPaths: [] },
            { kind: 'content-moved', revisionId: 'revision-1', differingPaths: [], added: [], removed: [] },
            { kind: 'declaration-moved', revisionId: 'revision-1' },
            { kind: 'declaration-moved', revisionId: 'revision-1', added: [], removed: [], differingPaths: [] },
            // Two equal sets are not a move. The content branch refuses an empty path list; the declaration branch refused an
            // empty *pair* of sets until an independent round measured it accepting exactly this payload.
            { kind: 'declaration-moved', revisionId: 'revision-1', added: [], removed: [] },
        ];
        for (const lie of lies) {
            expect(() => validate('verify-result', { ...base, supersededComparison: lie }), JSON.stringify(lie)).toThrow();
        }
    }, 30_000);
});
