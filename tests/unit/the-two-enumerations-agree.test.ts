import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runLedgerCommand } from '../../src/cli/ledger.js';
import { readLedger } from '../../src/store/ledger.js';
import { isIgnoredRepositoryPath } from '../../src/core/repository-identity.js';
import { writeTaskRecord } from '../helpers/task-fixture.js';

/**
 * **One fact, two consumers — and a guard that fails if they drift apart.**
 *
 * The defect was not that the ledger's walk had a wrong list; it was that it had a list at all. The identity walk already
 * answered "is this path content?" through `isIgnoredRepositoryPath`, and the declared-directory expansion answered it
 * again with two string comparisons, so the two disagreed about caches, build output and tool state. This file asks both
 * sides the same question over one tree: every path the predicate rejects must be absent from the frozen subject, and
 * every path it accepts must be present.
 *
 * The precondition assertions are part of the guard, not decoration: if a name stops being in the identity's table, the
 * fixture would silently stop exercising the rule and this file would pass for the wrong reason.
 */
const changeId = 'two-enumerations';
let root = '';
let previousExitCode: number | string | null | undefined;
const chunks: string[] = [];

/** The tree both enumerations are asked about: two real files, and one path per name the identity table excludes. */
const REAL = ['src/pkg/mod.ts', 'src/pkg/nested/deep.ts'];
const NOT_CONTENT = [
    'src/pkg/__pycache__/mod.cpython-312.pyc',
    'src/pkg/.pytest_cache/v/lastfailed',
    'src/pkg/.mypy_cache/3.12/x.json',
    'src/pkg/.ruff_cache/0.1/x',
    'src/pkg/.coverage',
    'src/pkg/dist/bundle.js',
    'src/pkg/node_modules/pkg/index.js',
    'src/pkg/.git/config',
    'src/pkg/.codex/session.json',
];

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

beforeEach(async () => {
    previousExitCode = process.exitCode;
    root = await mkdtemp(join(tmpdir(), 'kata-two-enumerations-'));
    await mkdir(join(root, '.kata', 'tasks', changeId), { recursive: true });
    for (const path of [...REAL, ...NOT_CONTENT]) {
        await mkdir(dirname(join(root, path)), { recursive: true });
        await writeFile(join(root, path), `content of ${path}\n`);
    }
    await writeTaskRecord(root, { id: changeId, phase: 'implement', ownedPaths: ['src/pkg'] });
});

afterEach(async () => {
    process.exitCode = previousExitCode;
    await rm(root, { recursive: true, force: true });
    vi.restoreAllMocks();
});

describe('the two enumerations agree on what is content', () => {
    it('the fixture exercises the rule: the identity table rejects every path that is not content', () => {
        for (const path of NOT_CONTENT) expect(isIgnoredRepositoryPath(path), path).toBe(true);
        for (const path of REAL) expect(isIgnoredRepositoryPath(path), path).toBe(false);
    });

    it('records exactly the paths the identity table accepts, under a declared directory', async () => {
        expect((await ledger(['freeze'])).ok).toBe(true);

        const recorded = Object.keys((await readLedger(root, changeId)).subject?.pathDigests ?? {}).sort();

        expect(recorded).toEqual([...REAL].sort());
    });
});
