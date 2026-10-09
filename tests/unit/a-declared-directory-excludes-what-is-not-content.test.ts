import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runLedgerCommand } from '../../src/cli/ledger.js';
import { readLedger } from '../../src/store/ledger.js';
import { writeTaskRecord } from '../helpers/task-fixture.js';

/**
 * **Declaring a directory declares the source in it.**
 *
 * Reported from a checkout where the review phase could not be entered at all: `ownedPaths` named a test directory, the
 * freeze expanded it with a walk that skipped only `.git` and `node_modules`, so `__pycache__/*.pyc` entered
 * `subject.pathDigests` — and `verify` runs the acceptance commands, so running the suite rewrote those `.pyc` files and
 * `ledger run` refused with "the frozen subject describes content that has moved". The documented order (`verify` then
 * `review`, with `ledger run` between them) therefore could not produce a request.
 */
const changeId = 'declared-directory';
let root = '';
let previousExitCode: number | string | null | undefined;
const chunks: string[] = [];

async function ledger(argv: string[]): Promise<Record<string, unknown>> {
    chunks.length = 0;
    process.exitCode = 0;
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
        chunks.push(String(chunk));
        return true;
    });
    try {
        await runLedgerCommand(argv, { root, changeId });
    } finally {
        spy.mockRestore();
    }
    const text = chunks.join('');
    const start = text.indexOf('{');
    return start < 0 ? {} : (JSON.parse(text.slice(start)) as Record<string, unknown>);
}

const digests = async (): Promise<string[]> => Object.keys((await readLedger(root, changeId)).subject?.pathDigests ?? {}).sort();

beforeEach(async () => {
    previousExitCode = process.exitCode;
    root = await mkdtemp(join(tmpdir(), 'kata-declared-directory-'));
    await mkdir(join(root, '.kata', 'tasks', changeId), { recursive: true });
    await mkdir(join(root, 'src', 'pkg', '__pycache__'), { recursive: true });
    await mkdir(join(root, 'src', 'pkg', 'build'), { recursive: true });
    await mkdir(join(root, 'src', 'pkg', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'), { recursive: true });
    await mkdir(join(root, 'src', 'pkg', '.pytest_cache', 'v'), { recursive: true });
    await mkdir(join(root, 'src', 'pkg', 'dist'), { recursive: true });
    await writeFile(join(root, 'src', 'pkg', 'mod.ts'), 'export const holds = true;\n');
    await writeFile(join(root, 'src', 'pkg', '__pycache__', 'mod.cpython-312.pyc'), 'cache-a');
    await writeFile(join(root, 'src', 'pkg', '.pytest_cache', 'v', 'lastfailed'), '{}');
    await writeFile(join(root, 'src', 'pkg', 'dist', 'bundle.js'), 'built');
    await writeFile(join(root, 'src', 'pkg', 'build', 'out.js'), 'built and git-ignored\n');
    await writeFile(join(root, 'src', 'pkg', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'deep.ts'), 'export const deep = true;\n');
    execFileSync('git', ['init', '-q', '.'], { cwd: root });
    await writeFile(join(root, '.gitignore'), 'build/\n', 'utf8');
    await writeTaskRecord(root, { id: changeId, phase: 'implement', ownedPaths: ['src/pkg'] });
});

afterEach(async () => {
    process.exitCode = previousExitCode;
    await rm(root, { recursive: true, force: true });
    vi.restoreAllMocks();
});

describe('a declared directory excludes what is not content', () => {
    it('records the source under it and no build or cache path', async () => {
        const result = await ledger(['freeze']);
        expect(result.ok).toBe(true);

        const recorded = await digests();
        expect(recorded).toContain('src/pkg/mod.ts');
        // Every name the identity walk already excludes, in one assertion per family, so a fix that drops one of them
        // fails here rather than in the next checkout that declares a test directory.
        expect(recorded.filter((path) => path.includes('__pycache__'))).toEqual([]);
        expect(recorded.filter((path) => path.includes('.pytest_cache'))).toEqual([]);
        expect(recorded.filter((path) => path.includes('/dist/'))).toEqual([]);
        // The fixture's own source files and nothing else: the git-ignored build output and the ten-levels-deep file are
        // the other two cases in this file, so what this case pins is the exclusion, not the inventory.
        expect(recorded).toContain('src/pkg/mod.ts');
        expect(recorded.filter((path) => !path.endsWith('.ts'))).toEqual([]);
    });

    it('is unmoved by a test run that rewrites a cache, and still moved by a source edit', async () => {
        // The half that made the report's workflow impossible, and the control that keeps the exclusion from being a
        // blanket "ignore anything under a directory".
        await ledger(['freeze']);
        const before = (await readLedger(root, changeId)).subject?.revision ?? '';

        await writeFile(join(root, 'src', 'pkg', '__pycache__', 'mod.cpython-312.pyc'), 'cache-b-different');
        await ledger(['freeze']);
        expect((await readLedger(root, changeId)).subject?.revision).toBe(before);

        await writeFile(join(root, 'src', 'pkg', 'mod.ts'), 'export const holds = false;\n');
        await ledger(['freeze']);
        expect((await readLedger(root, changeId)).subject?.revision).not.toBe(before);
    });

    it('is unmoved by a git-ignored file the repository declares, and moved by a file ten levels deep', async () => {
        // **The two filters the predicate alone does not have.** An independent round measured both against the first
        // version of this repair: a git-ignored path under the declared directory was recorded as content (so editing it
        // moved the subject — the reported defect, in another form), and a source file past depth eight was invisible (so
        // editing real code moved nothing). The identity walk has neither blind spot, and the expansion is now that walk.
        await ledger(['freeze']);
        const before = (await readLedger(root, changeId)).subject?.revision ?? '';

        await writeFile(join(root, 'src', 'pkg', 'build', 'out.js'), 'rebuilt, still git-ignored\n');
        await ledger(['freeze']);
        expect((await readLedger(root, changeId)).subject?.revision).toBe(before);

        await writeFile(join(root, 'src', 'pkg', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'deep.ts'), 'export const deep = false;\n');
        await ledger(['freeze']);
        expect((await readLedger(root, changeId)).subject?.revision).not.toBe(before);
    });

    it('says the declaration covered nothing instead of failing on the record schema', async () => {
        // Measured: declaring `dist` expanded to no paths and the operator was told `$.pathDigests must NOT have fewer than
        // 1 properties` — a message about the record, naming nothing about the declaration that produced it.
        await writeTaskRecord(root, { id: changeId, phase: 'implement', ownedPaths: ['src/pkg/dist'] });

        const result = await ledger(['freeze']);

        expect(result.ok).toBe(false);
        expect(String(result.error)).toContain('the declaration covers no files');
        expect(String(result.error)).toContain('src/pkg/dist');
    });

    it('says a directory that holds nothing holds nothing', async () => {
        // The other way a declaration covers no content: the directory exists and is not ignored, and simply has no files.
        // Measured before this guard existed: the freeze wrote a subject with no paths and the operator was told
        // `$.pathDigests must NOT have fewer than 1 properties` — a message about the record, naming nothing about the
        // declaration that produced it.
        await mkdir(join(root, 'src', 'pkg', 'empty'), { recursive: true });
        await writeTaskRecord(root, { id: changeId, phase: 'implement', ownedPaths: ['src/pkg/empty'] });

        const result = await ledger(['freeze']);

        expect(result.ok).toBe(false);
        expect(String(result.error)).toContain('the declaration covers no files');
        expect(String(result.error)).toContain('src/pkg/empty');
    });

    it('still records a file that is declared explicitly, even under a build directory', async () => {
        // The boundary of the rule: the predicate applies to directory *expansion*. Declaring a file is a statement about
        // that file, and a deliverable under `dist/` is still declarable.
        await writeTaskRecord(root, { id: changeId, phase: 'implement', ownedPaths: ['src/pkg/dist/bundle.js'] });

        const result = await ledger(['freeze']);

        expect(result.ok).toBe(true);
        expect(await digests()).toEqual(['src/pkg/dist/bundle.js']);
    });
});
