import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runLedgerCommand } from '../../src/cli/ledger.js';
import { readLedger } from '../../src/store/ledger.js';
import { isIgnoredRepositoryPath, listRepositoryFiles, normalizeDeclaredPaths } from '../../src/core/repository-identity.js';
import { computePathDigests } from '../../src/workflow/revision.js';
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

    it('canonicalises the declaration the way the seal does, so a non-canonical one records the same paths', async () => {
        // **The third round's first major.** The ledger rebuilt its keys by slicing the raw declaration, so `./src/pkg`
        // recorded `./src/pkg/d.ts` and — when a name shared a prefix with the declaration — `./src/pkg/sted/deep.ts` for
        // `src/pkg/nested/deep.ts`, collapsing distinct files onto one key. Measured consequence: editing a source file left
        // the frozen subject byte-identical. `computePathDigests` is the seal's own expansion, so this asks the two
        // derivations that must agree — the revision's and the subject's — rather than a third opinion.
        await writeTaskRecord(root, { id: changeId, phase: 'implement', ownedPaths: ['./src/pkg'] });

        const sealed = await computePathDigests(root, ['./src/pkg']);
        expect((await ledger(['freeze'])).ok).toBe(true);
        const recorded = Object.keys((await readLedger(root, changeId)).subject?.pathDigests ?? {}).sort();

        expect(recorded).toEqual(Object.keys(sealed).sort());
        expect(recorded.filter((path) => path.startsWith('./'))).toEqual([]);
    });

    it('canonicalises and refuses in the shared derivation itself, where both consumers read it', async () => {
        // **Round 3's third major, answered at the root.** The first version of this falsifier replaced a line of
        // `normalizeDeclaredPaths` with something that did not parse, so it reddened every test in the file for a reason
        // that had nothing to do with canonicalisation — and the legal equivalent it should have been stayed green, because
        // the property looked structural from the freeze side. It is not structural here: the shared derivation is a
        // function with a contract, and this asks it directly.
        expect(() => normalizeDeclaredPaths(root, ['..'])).toThrow(/inside the repository/);
        expect(() => normalizeDeclaredPaths(root, ['/etc/passwd'])).toThrow(/inside the repository/);
        expect(normalizeDeclaredPaths(root, ['./src/pkg', 'src/pkg/'])).toEqual(['src/pkg']);
    });

    it('refuses a declaration that resolves outside the repository, as the seal does', async () => {
        // Measured: `..` was accepted and the walk went outside the repository (`../oob.txt` recorded), while
        // `normalizeOwnedPaths` refuses it for the revision.
        await writeTaskRecord(root, { id: changeId, phase: 'implement', ownedPaths: ['..'] });

        const result = await ledger(['freeze']);

        expect(result.ok).toBe(false);
        expect(String(result.error)).toContain('must be inside the repository');
    });

    it('records what the seal records for a never-content root, and says what was declared', async () => {
        // **Round 3's first major, resolved the other way round.** Refusing a git-ignored directory *root* put the ledger and
        // the seal at odds for that input: the seal records what the operator declared (owned-path hashing has no filter or
        // cap), the ledger refused it, and the guard could not see the disagreement. The filter is for what a declaration
        // *silently* pulls in; a declaration is the operator's own statement. So the expansion matches the seal and the
        // declaration is *reported*, which is how the operator learns that build output they named will move the subject.
        await mkdir(join(root, 'src', 'pkg', 'build'), { recursive: true });
        await writeFile(join(root, 'src', 'pkg', 'build', 'out.js'), 'built\n');
        await writeTaskRecord(root, { id: changeId, phase: 'implement', ownedPaths: ['src/pkg/build'] });

        const sealed = await computePathDigests(root, ['src/pkg/build']);
        const result = await ledger(['freeze']);
        const recorded = Object.keys((await readLedger(root, changeId)).subject?.pathDigests ?? {}).sort();

        expect(result.ok).toBe(true);
        expect(recorded).toEqual(Object.keys(sealed).sort());
        expect(recorded).toEqual(['src/pkg/build/out.js']);
    });

    it('refuses a declaration that is neither a file nor a directory, instead of hanging on it', async () => {
        // **Round 3's second major.** The freeze stat-ed first and branched itself, so a FIFO never reached the function that
        // classifies it and fell through to `readFile`, which blocks on a pipe that has no writer: `ledger freeze` hung with
        // no refusal at all. One call now answers every declaration, so this is a named refusal like any other unreadable
        // one — and the seal's own answer for the same input is a sentinel, which is the difference the design states.
        execFileSync('mkfifo', [join(root, 'src', 'pkg', 'pipe')]);
        await writeTaskRecord(root, { id: changeId, phase: 'implement', ownedPaths: ['src/pkg/pipe'] });

        const result = await ledger(['freeze']);

        expect(result.ok).toBe(false);
        expect(String(result.error)).toContain('cannot be read');
        expect(String(result.error)).toContain('src/pkg/pipe');
    });

    it('canonicalises a declaration before looking for it, as the seal does', async () => {
        // Measured: a backslash declaration (`src\\pkg`) was reported unreadable, because the raw spelling was stat-ed before
        // the canonicalisation the seal applies first — so a declaration the seal accepts was refused here.
        await writeTaskRecord(root, { id: changeId, phase: 'implement', ownedPaths: ['src\\pkg'] });

        const result = await ledger(['freeze']);
        const recorded = Object.keys((await readLedger(root, changeId)).subject?.pathDigests ?? {}).sort();

        expect(result.ok).toBe(true);
        expect(recorded).toEqual((await listRepositoryFiles(root, { under: 'src/pkg' })).sort());
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
