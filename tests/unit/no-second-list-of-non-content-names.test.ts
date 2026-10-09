import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveWorkspaceRootForTask } from '../../src/core/layout.js';
import {
    ignoredDirectoryNames,
    ignoredHeavyPaths,
    isNonSourceDirectory,
    isLocalMachineryDirectory,
} from '../../src/core/repository-identity.js';
import { filesUnder } from '../../src/quality/wiring-check.js';

/**
 * **AC-10 — no surface keeps its own list of names that are never content.**
 *
 * "What is content" is answered by one policy (`src/core/repository-identity.ts`). Two other modules kept their own answer:
 * `src/core/layout.ts` carried `SKIP_DIRS` for the descendant-task scan and `src/quality/wiring-check.ts` carried `SKIP`
 * for its walk and its scratch copy. The lists disagreed with the policy and with each other — and one of the disagreements
 * was a live defect rather than a tidiness problem: `SKIP_DIRS` held `.kata`, which is exactly where the descendant roots it
 * was looking for live (`.kata/worktrees/<id>`), so the scan could never find one.
 *
 * The fix is a derivation, not another list: the policy module exports what a *source walk* refuses to descend into, built
 * from `ignoredDirectoryNames` itself, so a name added to the policy is honoured everywhere at once. The guard below reads
 * that policy at runtime — a hand-copied snapshot of it would pass while the copy drifted.
 */
const roots: string[] = [];

afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tempRoot(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'kata-non-content-'));
    roots.push(root);
    return root;
}

describe('the policy is the only enumeration of what is not content', () => {
    it('has no second list anywhere under src, judged against the policy itself', async () => {
        const policyModule = await readFile(join(process.cwd(), 'src', 'core', 'repository-identity.ts'), 'utf8');
        // Every name the policy calls never-content, taken from the policy rather than written out here: adding a name to
        // it makes this guard stricter with no edit, which is the property a snapshot cannot have.
        const policyNames = new Set(ignoredDirectoryNames);
        for (const name of ignoredHeavyPaths) policyNames.add(name);

        const offenders: Array<{ file: string; names: string[] }> = [];
        const walk = async (directory: string): Promise<void> => {
            for (const entry of await readdir(directory, { withFileTypes: true })) {
                const path = join(directory, entry.name);
                if (entry.isDirectory()) {
                    if (isNonSourceDirectory(entry.name) || isLocalMachineryDirectory(entry.name)) continue;
                    await walk(path);
                    continue;
                }
                if (!/\.ts$/.test(entry.name)) continue;
                const relativePath = relative(process.cwd(), path);
                if (relativePath === join('src', 'core', 'repository-identity.ts')) continue;
                const source = await readFile(path, 'utf8');
                // **A skip list that calls itself a skip list, holding two or more of the policy's own names, is a second
                // answer to the policy's question.** The identifier is the only signal available for "this literal decides
                // what to skip" — a heuristic, and the limit is stated rather than hidden: a skip list written under an
                // unrelated name (`const NAMES = [...]`) escapes this scan, which is why the two cases below assert the
                // *effect* (no walk descends into a policy name) as well as the shape.
                const NAMES_A_SKIP_LIST = /skip|ignor|exclud|non.?source|never.?content/i;
                for (const literal of source.matchAll(/\[[^\]\n]*\]|new (?:Set|Map)\(\[[^\]\n]*\]\)/g)) {
                    const declared = source.slice(Math.max(0, (literal.index ?? 0) - 120), literal.index);
                    const identifier = [...declared.matchAll(/(?:const|let|var)\s+([A-Za-z0-9_$]+)[^;]*$/g)].at(-1)?.[1] ?? '';
                    if (!NAMES_A_SKIP_LIST.test(identifier)) continue;
                    const names = [...policyNames].filter((name) => new RegExp(`['"\`]${name.replace('.', '\\.')}['"\`]`).test(literal[0]));
                    if (names.length >= 2) offenders.push({ file: relativePath, names });
                }
            }
        };
        await walk(join(process.cwd(), 'src'));

        // **Every entry is a real name.** A module cycle made this list hold `undefined` while every behavioural check still
        // passed — `[].includes(undefined)` is simply false — so the guard states the property the cycle broke as well as the
        // one it was written for.
        expect([...policyNames].every((name) => typeof name === 'string' && name.length > 0)).toBe(true);
        expect(offenders).toEqual([]);
        // And the policy itself still holds the enumeration, so the guard above is not vacuous: it is comparing against a
        // list that exists.
        expect(policyNames.size).toBeGreaterThan(5);
        expect(policyModule).toContain('ignoredDirectoryNames');
    });

    it('honours a policy name in every walk, and keeps the machinery out of a copy', async () => {
        // A name the policy calls never-content is refused by the walk predicate…
        for (const name of ignoredDirectoryNames) expect(isNonSourceDirectory(name), `${name} is policy-ignored`).toBe(true);
        // …and the trees that only hold this machine's own state are named for what they are: a copy must not carry them,
        // but a scan for records must still descend into them.
        expect(isLocalMachineryDirectory('.kata')).toBe(true);
        expect(isNonSourceDirectory('.kata')).toBe(false);
    });
});

describe('a policy name is honoured by every walk at once', () => {
    it('descends into none of the policy trees, whatever name was added to it', async () => {
        const root = await tempRoot();
        for (const name of ignoredDirectoryNames) {
            await mkdir(join(root, name), { recursive: true });
            await writeFile(join(root, name, 'inside.ts'), 'export const inside = true;\n');
        }
        await writeFile(join(root, 'kept.ts'), 'export const kept = true;\n');

        const found = await filesUnder(root, ['.']);

        // The whole policy, taken from the policy: this case is why the list here is never written out by hand — a name
        // added to `ignoredDirectoryNames` makes this case stricter with no edit, and a walk that had its own answer would
        // fail on the new name alone.
        expect(found).toEqual(['kept.ts']);
        expect(isNonSourceDirectory(ignoredDirectoryNames[0] as string)).toBe(true);
    });
});

describe('the descendant scan reaches the tree it is looking for', () => {
    it('finds a nested worktree whose records live under .kata/worktrees', async () => {
        const root = await tempRoot();
        const taskId = 'nested-task';
        // The shape a linked worktree has in this repository: the worktree root is under `.kata/worktrees/`, and it holds
        // the task's records under its own `.kata/tasks/<id>`.
        const worktree = join(root, '.kata', 'worktrees', 'wt');
        await mkdir(join(worktree, '.kata', 'tasks', taskId), { recursive: true });
        await writeFile(join(worktree, '.kata', 'tasks', taskId, 'task.json'), `${JSON.stringify({ id: taskId, ownedPaths: ['x.ts'] })}\n`);
        await writeFile(join(root, '.kata', 'tasks-placeholder'), 'x\n');

        // Started from the primary checkout, with no ancestor holding the task, the single descendant wins. `SKIP_DIRS`
        // carried `.kata`, so this scan could not descend into the one directory its answer lives in and the call threw
        // "No Kata workspace owns task" — a refusal whose remedy could not be executed.
        expect(resolveWorkspaceRootForTask(taskId, root)).toBe(worktree);
    });

    it('still refuses when two descendants hold the task, because nothing says which was meant', async () => {
        const root = await tempRoot();
        const taskId = 'twice-owned';
        for (const name of ['one', 'two']) {
            const worktree = join(root, '.kata', 'worktrees', name);
            await mkdir(join(worktree, '.kata', 'tasks', taskId), { recursive: true });
            await writeFile(join(worktree, '.kata', 'tasks', taskId, 'task.json'), `${JSON.stringify({ id: taskId, ownedPaths: ['x.ts'] })}\n`);
        }

        expect(() => resolveWorkspaceRootForTask(taskId, root)).toThrow(/Multiple descendant worktrees own task/);
    });
});

describe('the source walk reads source and nothing else', () => {
    it('skips the policy trees and descends into the record tree', async () => {
        const root = await tempRoot();
        await mkdir(join(root, 'dist'), { recursive: true });
        await writeFile(join(root, 'dist', 'bundled.ts'), 'export const inDist = true;\n');
        await mkdir(join(root, '__pycache__'), { recursive: true });
        await writeFile(join(root, '__pycache__', 'cached.ts'), 'export const cached = true;\n');
        await mkdir(join(root, '.kata', 'tasks', 'x'), { recursive: true });
        await writeFile(join(root, '.kata', 'tasks', 'x', 'record.ts'), 'export const recorded = true;\n');
        await writeFile(join(root, 'kept.ts'), 'export const kept = true;\n');

        const found = await filesUnder(root, ['.']);

        // The policy's names are skipped; the record tree is not, because identity counts it as content and a walk that
        // silently disagreed with identity was the defect this replaces.
        expect(found).toContain('kept.ts');
        expect(found).toContain(join('.kata', 'tasks', 'x', 'record.ts'));
        expect(found.some((path) => path.startsWith('dist'))).toBe(false);
        expect(found.some((path) => path.startsWith('__pycache__'))).toBe(false);
    });
});
