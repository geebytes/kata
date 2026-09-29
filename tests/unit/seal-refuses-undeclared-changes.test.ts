import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { undeclaredChanges } from '../../src/quality/undeclared-changes.js';

/**
 * **The seal's confidence surface is `ownedPaths`; the working tree is what verify looks at. Nothing owned the gap.**
 *
 * Measured, twice in one change: a source file was edited without being declared. The seal said nothing (it reads only
 * the owned paths), `verify` reported `workspaceDrift` — one file name inside a twenty-field diagnostics object — and a
 * re-seal then refused with "the sealed revision's declared manifest is unchanged", because the declaration really had
 * not changed. Two stages each believed the other owned the difference.
 *
 * The rule is a set difference taken *before* the seal freezes anything: every changed path that is not declared and not
 * excluded is named. The three parsing traps are asserted here because each one was hit while diagnosing the original
 * incident: the two status characters are followed by a space and then the path, a rename reports both names, and an
 * untracked directory has to be expanded rather than read as one entry.
 */
let root: string;

function git(...args: string[]): void {
    execFileSync('git', args, { cwd: root, stdio: 'ignore', env: { ...process.env, LC_ALL: 'C' } });
}

async function repo(declared: string[], previousPathDigests?: string[]): Promise<string[]> {
    const result = await undeclaredChanges({ root, declaredPaths: declared, ...(previousPathDigests ? { previousPathDigests } : {}) });
    return result.paths.sort();
}

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'kata-undeclared-'));
    git('init', '-q');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'test');
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src', 'declared.ts'), 'export const declared = 1;\n');
    // The repository's own rules, which is where the exclusion comes from: this project ignores `.kata/` and `tmp/`, so
    // git never reports them and nothing has to hardcode a second list of paths-not-to-worry-about here.
    await writeFile(join(root, '.gitignore'), '.kata/\ntmp/\n');
    git('add', '-A');
    git('commit', '-qm', 'init');
});

afterEach(async () => {
    await rm(root, { recursive: true, force: true });
});

describe('a changed path outside the declared surface is named before the seal freezes anything', () => {
    it('sees nothing when the tree matches the declaration', async () => {
        expect(await repo(['src/declared.ts'])).toEqual([]);
    });

    it('names an edited file that was never declared, which is the incident this exists for', async () => {
        await writeFile(join(root, 'src', 'declared.ts'), 'export const declared = 2;\n');
        await writeFile(join(root, 'src', 'undeclared.ts'), 'export const undeclared = 1;\n');
        expect(await repo(['src/declared.ts'])).toEqual(['src/undeclared.ts']);
    });

    it('sees an added file, which is untracked rather than modified', async () => {
        await writeFile(join(root, 'src', 'fresh.ts'), 'export const fresh = 1;\n');
        expect(await repo(['src/declared.ts'])).toEqual(['src/fresh.ts']);
    });

    it('expands an untracked directory instead of reading it as one entry', async () => {
        await mkdir(join(root, 'src', 'newdir'), { recursive: true });
        await writeFile(join(root, 'src', 'newdir', 'a.ts'), 'export const a = 1;\n');
        await writeFile(join(root, 'src', 'newdir', 'b.ts'), 'export const b = 1;\n');
        expect(await repo(['src/declared.ts'])).toEqual(['src/newdir/a.ts', 'src/newdir/b.ts']);
    });

    it('contributes both names of a rename, because both are paths the change touched', async () => {
        await rename(join(root, 'src', 'declared.ts'), join(root, 'src', 'renamed.ts'));
        expect(await repo(['src/declared.ts'])).toEqual(['src/renamed.ts']);
    });

    it('reports every offending path rather than the first, so one repair closes them all', async () => {
        await writeFile(join(root, 'src', 'one.ts'), 'export const one = 1;\n');
        await writeFile(join(root, 'src', 'two.ts'), 'export const two = 1;\n');
        await writeFile(join(root, 'src', 'three.ts'), 'export const three = 1;\n');
        expect(await repo(['src/declared.ts'])).toEqual(['src/one.ts', 'src/three.ts', 'src/two.ts']);
    });

    it('leaves the artefacts and the scratch directory out, because they are not what the seal is about', async () => {
        await mkdir(join(root, '.kata', 'tasks', 'x'), { recursive: true });
        await writeFile(join(root, '.kata', 'tasks', 'x', 'task.json'), '{}\n');
        await mkdir(join(root, 'tmp'), { recursive: true });
        await writeFile(join(root, 'tmp', 'probe.ts'), 'export const probe = 1;\n');
        expect(await repo(['src/declared.ts'])).toEqual([]);
    });

    it('sees a committed change outside the declaration, which git status alone cannot report', async () => {
        // `git status` is clean here, and the file is still not declared: the previous revision's digests are the second
        // reading of the same question, and without them a committed undeclared path was invisible — which matters because
        // the declaration is where the risk classes come from.
        await writeFile(join(root, 'src', 'committed.ts'), 'export const committed = 1;\n');
        git('add', '-A');
        git('commit', '-qm', 'a change the declaration does not cover');
        expect(await repo(['src/declared.ts'])).toEqual([]);
        expect(await repo(['src/declared.ts'], ['src/declared.ts', 'src/committed.ts'])).toEqual(['src/committed.ts']);
    });

    it('compares against the declaration after the same normalization the declaration gets', async () => {
        await writeFile(join(root, 'src', 'declared.ts'), 'export const declared = 3;\n');
        // A declaration written with a leading `./` still covers the path git reports.
        expect(await repo(['./src/declared.ts'])).toEqual([]);
    });
});