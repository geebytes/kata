import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runLedgerCommand } from '../../src/cli/ledger.js';
import { readLedger } from '../../src/store/ledger.js';
import { isIgnoredRepositoryPath, listRepositoryFiles } from '../../src/core/repository-identity.js';
import { writeTaskRecord } from '../helpers/task-fixture.js';

/**
 * **One fact, two enumerations — and a guard that compares the two, not one of them with a predicate.**
 *
 * The first version of this guard asked `isIgnoredRepositoryPath` and the freeze about the same tree. An independent round
 * measured what that missed: the predicate is only *one* of the identity walk's filters — the walk also consults the
 * repository's own git declaration, has no depth cap, and speaks in repository coordinates — so the ledger and the identity
 * walk could drift (a git-ignored file recorded as content; a file ten levels deep invisible) while this guard stayed green.
 * Its title named the two enumerations; its body never called the second one.
 *
 * It calls it now: `listRepositoryFiles(root, { under })` is what the ledger's expansion must equal, path for path. The
 * precondition assertions are part of the guard, not decoration — they keep the fixture from silently stopping to exercise
 * the rule.
 */
const changeId = 'two-enumerations';
let root = '';
let previousExitCode: number | string | null | undefined;
const chunks: string[] = [];

/** The tree both enumerations are asked about: two real files, and one path per name the identity table excludes. */
const REAL = ['src/pkg/mod.ts', 'src/pkg/nested/deep.ts'];
/** Ten levels down: the ledger's own walk stopped at eight, and the identity walk has no cap. */
const DEEP = 'src/pkg/a/b/c/d/e/f/g/h/i/deep.ts';
/** Excluded by the repository's git declaration, not by the built-in table. */
const DECLARED_IGNORED = ['src/pkg/build/out.js', 'src/pkg/scratch.local.json'];
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
    for (const path of [...REAL, ...NOT_CONTENT, ...DECLARED_IGNORED, DEEP]) {
        await mkdir(dirname(join(root, path)), { recursive: true });
        await writeFile(join(root, path), `content of ${path}\n`);
    }
    // **The filter the predicate does not have.** The identity walk reads what the repository itself declares ignored; a
    // second walk that only asked the predicate recorded these as content, which is how the reported defect survived the
    // first repair (measured: editing only the git-ignored file moved the frozen subject).
    execFileSync('git', ['init', '-q', '.'], { cwd: root });
    await writeFile(join(root, '.gitignore'), 'build/\nscratch.local.json\n', 'utf8');
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

    it('records exactly what the identity walk returns, under a declared directory', async () => {
        // The two enumerations, side by side. `listRepositoryFiles` is the identity's own walk — the same one the revision
        // manifest uses — so this fails the moment the ledger's expansion answers differently, for any reason at all.
        const identity = (await listRepositoryFiles(root, { under: 'src/pkg' })).sort();

        // Preconditions, so a fixture that stopped exercising the rule cannot make this pass: the walk sees the deep file
        // and does not see the git-ignored ones.
        expect(identity).toContain(DEEP);
        for (const path of DECLARED_IGNORED) expect(identity, path).not.toContain(path);
        expect(identity).toContain('src/pkg/mod.ts');

        expect((await ledger(['freeze'])).ok).toBe(true);
        const recorded = Object.keys((await readLedger(root, changeId)).subject?.pathDigests ?? {}).sort();

        expect(recorded).toEqual(identity);
    });

    it('keys a declaration with a trailing slash in the same coordinates the walk uses', async () => {
        // Measured: `src/pkg/` recorded `src/pkg//mod.ts`, a path no other surface would ever produce, because the key was
        // built from the raw declaration while the walk was handed the normalised one.
        await writeTaskRecord(root, { id: changeId, phase: 'implement', ownedPaths: ['src/pkg/'] });

        expect((await ledger(['freeze'])).ok).toBe(true);
        const recorded = Object.keys((await readLedger(root, changeId)).subject?.pathDigests ?? {}).sort();

        expect(recorded).toEqual((await listRepositoryFiles(root, { under: 'src/pkg' })).sort());
        expect(recorded.filter((path) => path.includes('//'))).toEqual([]);
    });
});
