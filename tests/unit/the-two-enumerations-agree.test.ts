import { execFileSync } from 'node:child_process';
import { link, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runLedgerCommand } from '../../src/cli/ledger.js';
import { readLedger } from '../../src/store/ledger.js';
import { isIgnoredRepositoryPath, listRepositoryFiles, normalizeDeclaredPaths } from '../../src/core/repository-identity.js';
import { hashContent } from '../../src/core/hash.js';
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
/**
 * The tree both enumerations are asked about, and a **sample** of the kinds — not the authority, which is the generator below.
 *
 * Rounds 5 and 6 measured the same failure four times: a compile-valid one-sided filter keyed on an extension, a name shape
 * or a size left every declared selector green, because the fixture did not happen to carry that kind. Adding one kind per
 * round does not converge — a filter keyed on a kind nobody thought of still passes, and a comparison that only asks the
 * other derivation moves *with* the filter when it is applied inside the shared traversal. So the kinds are a table and the
 * answer is written here for a sample of kinds. Round 7 showed what a list cannot do: it is finite, so a filter keyed on a kind
 * the list omits escapes every assertion in this file. `CONTENT` remains because it names the shapes worth reading in a
 * failure message — the oracle that has to hold is `generatedTree`, which writes the tree and returns its own names.
 */
const CONTENT = [
    'src/pkg/mod.ts', // the ordinary case
    'src/pkg/worker.mts', // a kind the rounds kept reaching for: the guard's own mark is what catches a filter on it
    'src/pkg/nested/deep.ts', // a nested directory
    'src/pkg/data.json', // an extension a filter can key on …
    'src/pkg/README.md',
    'src/pkg/helper.py',
    'src/pkg/notes.txt',
    'src/pkg/Cargo.toml', // … a multi-dot name …
    'src/pkg/LICENSE', // … and a name with no extension at all
    'src/pkg/.env.example', // a dotfile the ignore table does not name
    'src/pkg/ünïcode.txt', // a non-ASCII name
    'src/pkg/a file with spaces.ts', // spaces
    'src/pkg/Upper.TS', // a case variant of a carried extension
    'src/pkg/empty.ts', // an empty file
    'src/pkg/nested/kept/kept.md', // a nested directory that is not ignored
    'src/pkg/big.bin', // larger than the tree-hash budget
    'src/pkg/exactly-budget.bin', // exactly at it, not above
    'src/pkg/mod-hardlink.ts', // a second name for a file that is already content
    'src/pkg/a/b/c/d/e/f/g/h/i/deep.ts', // deeper than any cap the ledger's own walk had
];
/** Larger than the tree-hash budget, so a cap applied on one side only changes that side's set. */
const OVERSIZED = 'src/pkg/big.bin';
/** Exactly at the budget: an off-by-one in a cap is invisible one byte above it. */
const AT_BUDGET = 'src/pkg/exactly-budget.bin';
/** Ten levels down: the ledger's own walk stopped at eight, and the identity walk has no cap. */
const DEEP = 'src/pkg/a/b/c/d/e/f/g/h/i/deep.ts';
/** A hard link: one inode, two names — a filter that keys on inode loses one of them. */
const HARDLINK = 'src/pkg/mod-hardlink.ts';
/** Excluded by the repository's git declaration — `.gitignore` and `.git/info/exclude` — not by the built-in table. */
const DECLARED_IGNORED = [
    'src/pkg/build/out.js',
    'src/pkg/scratch.local.json',
    'src/pkg/nested/build/nested-out.ts',
    'src/pkg/excluded-by-info-exclude.ts',
];
/** Paths a declaration names directly and the seal answers with a sentinel rather than a file. */
const SENTINEL_DECLARED = ['src/pkg/pipe', 'src/pkg/broken-link'];
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
    for (const path of [...CONTENT, ...NOT_CONTENT, ...DECLARED_IGNORED, ...SENTINEL_DECLARED]) {
        await mkdir(dirname(join(root, path)), { recursive: true });
        if (path === HARDLINK) continue; // created as a link below, so both names share one inode
        if (path === OVERSIZED) await writeFile(join(root, path), 'x'.repeat(3_000_000));
        else if (path === AT_BUDGET) await writeFile(join(root, path), 'x'.repeat(2_000_000));
        else if (path === 'src/pkg/empty.ts') await writeFile(join(root, path), '');
        else if (path === 'src/pkg/pipe') execFileSync('mkfifo', [join(root, path)]);
        else if (path === 'src/pkg/broken-link') await symlink('missing-target', join(root, path));
        else await writeFile(join(root, path), `content of ${path}\n`);
    }
    // One inode, two names. A filter keyed on the inode keeps one of them and loses the other.
    await link(join(root, 'src/pkg/mod.ts'), join(root, HARDLINK));
    // **The filter the predicate does not have.** The identity walk reads what the repository itself declares ignored; a
    // second walk that only asked the predicate recorded these as content, which is how the reported defect survived the
    // first repair (measured: editing only the git-ignored file moved the frozen subject).
    execFileSync('git', ['init', '-q', '.'], { cwd: root });
    await writeFile(join(root, '.gitignore'), 'build/\nscratch.local.json\n', 'utf8');
    // The second place the repository declares something ignored. A guard that only knows `.gitignore` answers for a subset.
    await writeFile(join(root, '.git', 'info', 'exclude'), 'excluded-by-info-exclude.ts\n', 'utf8');
    await writeTaskRecord(root, { id: changeId, phase: 'implement', ownedPaths: ['src/pkg'] });
});

afterEach(async () => {
    process.exitCode = previousExitCode;
    await rm(root, { recursive: true, force: true });
    vi.restoreAllMocks();
});


/**
 * **The kinds are generated, not enumerated.** `CONTENT` above is a readable *sample*: a list of names is always finite, so a
 * filter keyed on a kind nobody listed walks through every assertion in this file. Round 7 said exactly that after defeating
 * the list with `.rs`, a name-length test, `.yaml`, and a reversed sort. What closes it is not a longer list but an oracle the
 * code cannot move with: this generator writes the files and returns their names, so the expected set comes from the test's
 * own act of writing rather than from any derivation under test. Seeds are fixed — `Math.random` is not used — so a failure
 * reports the same tree every run.
 */
function mulberry32(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/** Kinds a filter can key on. Each dimension is drawn per file, so their combination is what the generator covers. */
const STEMS = ['plain', 'mod', 'x', 'short', 'very-long-name-deliberately-over-thirty-characters-wide', 'a file with spaces', 'ünïcode', 'ÜPPER', 'digits123', 'dash-name', 'dot.name', 'under_score'];
const EXTENSIONS = [
    'ts', 'json', 'md', 'txt', 'py', 'rs', 'yaml', 'yml', 'go', 'rb', 'sh', 'css', 'map', 'lock', 'mjs', 'cjs', 'vue', 'svg',
    'proto', '', 'TS', 'DATA', 'tar.gz', 'd.ts',
    // **The kinds a filter is most tempting on.** Round 8 defeated this generator with `.pyc` — the very case this change
    // exists for — because it was not among the extensions drawn. A list cannot be completed (that is the finding), so these
    // are witnesses for the readable failure message; the property itself is enforced structurally by
    // `the-recorded-digests-are-the-seals-map.test.ts`, which fails on a filter of any kind.
    'pyc', 'exe', 'o', 'obj', 'class', 'log', 'min.js', '.hidden', 'mts', 'pyi',
];

function generatedTree(seed: number, root: string): string[] {
    const random = mulberry32(seed);
    const pick = <T,>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!;
    const written: string[] = [];
    const count = 24;
    for (let index = 0; index < count; index += 1) {
        const depth = 1 + Math.floor(random() * 12);
        const segments = [`gen`, `s${seed}`];
        for (let level = 1; level < depth; level += 1) segments.push(random() < 0.1 ? 'looks.like.ts' : `d${level}`);
        const stem = pick(STEMS);
        const extension = pick(EXTENSIONS);
        const dotfile = random() < 0.15 ? '.' : '';
        const name = `${dotfile}${stem}${extension === '' ? '' : `.${extension}`}`;
        const path = [...segments, `${index}-${name}`].join('/');
        written.push(path);
    }
    // The boundary shapes are generated too, because a size cap is a kind like any other.
    written.push(`gen/s${seed}/empty${seed}.ts`, `gen/s${seed}/at-budget${seed}.bin`);
    return written;
}

describe('the two enumerations agree on what is content', () => {
    it('the fixture exercises the rule: the identity table rejects every path that is not content', () => {
        for (const path of NOT_CONTENT) expect(isIgnoredRepositoryPath(path), path).toBe(true);
        for (const path of CONTENT) expect(isIgnoredRepositoryPath(path), path).toBe(false);
    });

    it('records exactly what the seal records, under a declared directory', async () => {
        // **The reference is the seal, not the walk.** The first version compared the ledger with
        // `listRepositoryFiles(root, { under })` — the same function the ledger calls, with default options — so a mutation
        // in *how the ledger calls it* was invisible. Measured by an independent round: adding
        // `maxFileBytes: maxTreeHashFileBytes` to the ledger's call left this file 19/19 green, while a declared directory
        // holding a 3 MB file recorded a set the seal does not — and editing that file left the frozen subject
        // byte-identical. `computePathDigests` is the derivation that must agree, and it is not a proxy for anything.
        const sealed = await computePathDigests(root, ['src/pkg']);

        expect((await ledger(['freeze'])).ok).toBe(true);
        const recorded = Object.keys((await readLedger(root, changeId)).subject?.pathDigests ?? {}).sort();

        expect(recorded).toEqual(Object.keys(sealed).sort());
        // **The expectation is written down, and it is asserted first.** Round 6's three majors were one-sided filters that
        // moved both sides of the comparison above — the seal and the ledger — or that the fixture's kinds did not exercise.
        // An assertion that only asks the other derivation cannot see a filter applied *inside* the shared traversal, and a
        // fixture that only carries some kinds cannot see a filter keyed on the others. `CONTENT` is the answer, so a filter
        // on either side, or in the traversal, fails here rather than in production.
        expect(recorded).toEqual([...CONTENT].sort());
        // The oversized file is what makes the call-shape mutation visible: without it, a budget applied on one side only
        // cannot change either set.
        expect(recorded).toContain(OVERSIZED);
    });

    it('sees a path deeper than the walk a declared directory used to have, asked directly', async () => {
        // **Why this is its own case.** A depth cap inside the walk moves *both* sides of every comparison — the seal reads
        // the same function — so no equality assertion can catch it; what catches it is asking the shared derivation
        // directly, which is what this does. E4 reddens here, by assertion, in a case whose title is about depth.
        const walked = await listRepositoryFiles(root, { under: 'src/pkg' });

        expect(walked).toContain(DEEP);
        expect(DEEP.split('/').length).toBeGreaterThan(11);
    });

    it('covers every declaration, not only the first', async () => {
        // Every other case in this file declares one path, so a mutation that expands only the first declaration stayed
        // green (measured in a scratch copy: 9/9 pass). A subject that covers one of several declared paths is this
        // change's defect in its plainest form — the others can be edited without moving the subject.
        await mkdir(join(root, 'src', 'other'), { recursive: true });
        await writeFile(join(root, 'src', 'other', 'thing.ts'), 'export const thing = 1;\n');
        // A second extension in the second declaration, so a per-extension filter cannot hide behind a single-extension fixture.
        await writeFile(join(root, 'src', 'other', 'data.json'), '{ "thing": 1 }\n');
        await writeTaskRecord(root, { id: changeId, phase: 'implement', ownedPaths: ['src/pkg', 'src/other'] });

        const sealed = await computePathDigests(root, ['src/pkg', 'src/other']);
        expect((await ledger(['freeze'])).ok).toBe(true);
        const recorded = Object.keys((await readLedger(root, changeId)).subject?.pathDigests ?? {}).sort();

        expect(recorded).toEqual(Object.keys(sealed).sort());
        expect(recorded).toContain('src/other/thing.ts');
        expect(recorded).toContain('src/other/data.json');
    });

    it('records a plainly declared file whatever its extension', async () => {
        // **Round 5's two majors.** Both were compile-valid mutations that filtered `.json` — one on the ledger's side of the
        // comparison, one on the seal's — and both stayed green, because every fixture declared either a directory or a file
        // inside an ignored one, and the only `.json` was git-ignored. A per-extension filter is the same defect in a smaller
        // shape: a declared source file stops being content, so editing it leaves the frozen subject byte-identical. Asking
        // both derivations for a plainly declared file of each kind is what makes that mutation fail.
        await writeTaskRecord(root, { id: changeId, phase: 'implement', ownedPaths: ['src/pkg/data.json', 'src/pkg/helper.py'] });

        const sealed = await computePathDigests(root, ['src/pkg/data.json', 'src/pkg/helper.py']);
        expect((await ledger(['freeze'])).ok).toBe(true);
        const recorded = Object.keys((await readLedger(root, changeId)).subject?.pathDigests ?? {}).sort();

        expect(recorded).toEqual(Object.keys(sealed).sort());
        expect(recorded).toEqual(['src/pkg/data.json', 'src/pkg/helper.py']);
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

    it('refuses a declared path the seal would sentinel, and says which, instead of recording the sentinel', async () => {
        // **Round 3's second major, with round 6's second major named beside it.** The freeze used to stat first and branch
        // itself, so a FIFO never reached the function that classifies it and fell through to `readFile`, which blocks on a
        // pipe with no writer: `ledger freeze` hung with no refusal at all. It refuses by name now.
        //
        // **This is the one place where the ledger deliberately does not record what the seal records**, so C2 says so
        // instead of claiming agreement for every shape: the seal answers a declared FIFO or broken symlink with
        // `[unsupported]` / `[missing]`, and this is the shape where a sentinel is worse than a refusal — a sentinel in a
        // *declaration* cannot be told from a file that was deleted after it, so the operator is told to fix the declaration
        // rather than being allowed to freeze on top of it. The case asserts both halves, so neither can move alone.
        await writeTaskRecord(root, { id: changeId, phase: 'implement', ownedPaths: ['src/pkg/pipe', 'src/pkg/broken-link'] });

        const sealed = await computePathDigests(root, ['src/pkg/pipe', 'src/pkg/broken-link']);
        const result = await ledger(['freeze']);

        // **The sentinel *values*, not only the keys.** Round 9 measured that this asserted the key set alone, so a seal that
        // recorded a hash for a FIFO or a dangling symlink — or an empty string — would pass a case whose title is about the
        // sentinel. The two values are what make the difference between "the seal records the path" and "the seal records it
        // as not-readable", which is the whole content of this deliberate difference.
        expect(Object.keys(sealed).sort()).toEqual([...SENTINEL_DECLARED].sort());
        // The seal records the *digest of its sentinel string* (`src/workflow/revision.ts:485,488`), not the string itself —
        // measured by probing the seal directly, which is how the first version of this assertion was caught being wrong.
        expect(sealed['src/pkg/pipe']).toBe(hashContent('[unsupported]'));
        expect(sealed['src/pkg/broken-link']).toBe(hashContent('[missing]'));
        expect(result.ok).toBe(false);
        for (const path of SENTINEL_DECLARED) expect(String(result.error), path).toContain(path);
        expect(String(result.error)).toContain('cannot be read');
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

    it('records every kind the tree holds, because the expectation is what the test wrote and not what the code derives', async () => {
        // The oracle is the generator's own list. Nothing here asks `listRepositoryFiles`, `computePathDigests` or
        // `declaredContentPaths` what should be there — a filter inside either side of the comparison can move those answers,
        // and it cannot move the list of files this test just wrote. `Object.keys` is used deliberately: it is insertion
        // order, so a reversal of the walk's sort — invisible to a `.sort()`ed comparison — fails here.
        for (const seed of [1, 2, 3, 4, 5, 6]) {
            const declared = `gen/s${seed}`;
            const expected = generatedTree(seed, root);
            for (const path of expected) {
                await mkdir(dirname(join(root, path)), { recursive: true });
                if (path.includes('/empty')) await writeFile(join(root, path), '');
                else if (path.includes('/at-budget')) await writeFile(join(root, path), 'x'.repeat(2_000_000));
                else await writeFile(join(root, path), `content ${seed} of ${path}\n`);
            }
            await writeTaskRecord(root, { id: changeId, phase: 'implement', ownedPaths: [declared] });

            expect((await ledger(['freeze', '--paths', declared])).ok, `seed ${seed}`).toBe(true);
            const recorded = Object.keys((await readLedger(root, changeId)).subject?.pathDigests ?? {});

            expect(recorded.length, `seed ${seed}`).toBe(expected.length);
            for (const path of expected) expect(recorded, `seed ${seed}`).toContain(path);
            expect(recorded, `seed ${seed}`).toEqual([...expected].sort((left, right) => left.localeCompare(right)));
        }
    });

    it('is unmoved by a filter keyed on a kind the sample list never named', async () => {
        // Round 7's mutation, as a guard: a one-sided delete keyed on `.rs` after the seal's call left every selector green,
        // because `CONTENT` carried no `.rs`. Here `.rs` is one of the extensions the generator draws, so the recorded set
        // loses a file the test wrote and the case fails without anything having to be enumerated in advance.
        const declared = 'gen/s7';
        const expected: string[] = [];
        for (let index = 0; index < 8; index += 1) {
            const path = `${declared}/${index}.${index % 2 === 0 ? 'rs' : 'ts'}`;
            await mkdir(dirname(join(root, path)), { recursive: true });
            await writeFile(join(root, path), `content ${index}\n`);
            expected.push(path);
        }
        await writeTaskRecord(root, { id: changeId, phase: 'implement', ownedPaths: [declared] });

        expect((await ledger(['freeze', '--paths', declared])).ok).toBe(true);
        const recorded = Object.keys((await readLedger(root, changeId)).subject?.pathDigests ?? {});

        expect(recorded).toEqual([...expected].sort((left, right) => left.localeCompare(right)));
    });
});
