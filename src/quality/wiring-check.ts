import { execFile } from 'node:child_process';
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

/**
 * The three mechanical checks, as one instrument.
 *
 * Every constant and every refusal in this file comes from a measurement recorded in
 * `docs/design/2026-09-21-adversarial-execution-control-optimization.md` §17–§19, not from taste:
 *
 * - **reference** — an exported symbol the production code never references. Measured: 24 such symbols in `src/`, each
 *   occurring exactly once, in its own declaration, plus 15 kept alive only by tests.
 * - **declared-member** — a member of an `export const X = [...] as const` list nothing consumes. The harness that found
 *   these used a regex whose `[^\]]*` spans newlines, so an apostrophe in prose inside a multi-line list was read as a
 *   string boundary; roughly 4 of its 11 rows survived. The parser here is a scan, because shipping the regex would ship
 *   a check that is wrong in the direction of noise.
 * - **mutation** — a refusal guard that can be disabled with the suite still green. Measured: 31 guards on one change's
 *   declared surface, 30 valid mutations, 1 discounted as a type collapse that reddened 16 files at once, **15 decorative**.
 *
 * Three states, not two. An instrument that exits "clean" when it could not run is the defect class this file exists to
 * detect, so `runWiringCheck` returns `exitCode: 2` and a non-empty `instrument` list rather than an empty finding set.
 */

export interface WiringFinding {
    check: 'reference' | 'declared-member' | 'mutation';
    /** Repository-relative. A finding without a location cannot be acted on, so this is never empty. */
    file: string;
    line: number;
    subject: string;
    detail: string;
}

/** Thrown when the check cannot do its job — a missing surface, an unreadable root. Never a finding. */
export class WiringInstrumentError extends Error {
    readonly problems: string[];

    constructor(problems: string[]) {
        super(problems.join('; '));
        this.name = 'WiringInstrumentError';
        this.problems = problems;
    }
}

const SKIP = new Set(['node_modules', '.git', 'dist', 'tmp', '.kata', 'coverage']);

async function walkFiles(directory: string, root: string, out: string[] = []): Promise<string[]> {
    let entries: string[];
    try {
        entries = await readdir(directory);
    } catch {
        return out;
    }
    for (const entry of entries) {
        if (SKIP.has(entry)) continue;
        const path = join(directory, entry);
        const info = await stat(path).catch(() => null);
        if (!info) continue;
        if (info.isDirectory()) await walkFiles(path, root, out);
        // Paths are reported relative to the *repository*, not to the directory searched — a path relative to the search
        // directory looks plausible and cannot be opened, which silently emptied every source file the first time this ran.
        else if (/\.(ts|tsx|mjs|cjs|js)$/.test(entry)) out.push(relative(root, path));
    }
    return out;
}

/** Every `.ts`/`.tsx` file under the given repository-relative directories, in a stable order. */
export async function filesUnder(root: string, directories: string[]): Promise<string[]> {
    const found: string[] = [];
    for (const directory of directories) {
        const absolute = join(root, directory);
        const info = await stat(absolute).catch(() => null);
        if (!info) continue;
        if (info.isFile()) {
            if (/\.(ts|tsx)$/.test(directory)) found.push(directory);
            continue;
        }
        const nested: string[] = [];
        await walkFiles(absolute, root, nested);
        found.push(...nested);
    }
    return [...new Set(found)].sort();
}


async function readSurface(root: string, surface: string[]): Promise<Map<string, string>> {
    const contents = new Map<string, string>();
    const missing: string[] = [];
    for (const path of surface) {
        const text = await readFile(join(root, path), 'utf8').catch(() => null);
        if (text === null) missing.push(path);
        else contents.set(path, text);
    }
    if (missing.length > 0) {
        throw new WiringInstrumentError(missing.map((path) => `the declared surface path does not exist: ${path}`));
    }
    return contents;
}

function lineOf(text: string, index: number): number {
    let line = 1;
    for (let i = 0; i < index && i < text.length; i++) if (text[i] === '\n') line++;
    return line;
}

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const occurrences = (haystack: string, pattern: RegExp): number => (haystack.match(pattern) ?? []).length;

// ── Check A ─────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface ReferenceCheckOptions {
    root: string;
    /** Repository-relative files whose exported symbols are examined. */
    surface: string[];
    /** Where production references are looked for. Defaults to `src`. */
    search?: string[];
    /** Where test references are looked for, reported separately. */
    testGlobs?: string[];
}

const EXPORT_PATTERNS = [/^export\s+(?:async\s+)?function\s+([A-Za-z0-9_$]+)/gm, /^export\s+const\s+([A-Za-z0-9_$]+)\s*=\s*(?:async\s*)?\(/gm];

/**
 * An exported symbol the production code never references.
 *
 * An occurrence count is deliberately *not* a proof of use — a name can appear in a comment or a string. What it does
 * prove is the opposite, and that is the direction this check needs: a symbol that appears **only** in its own
 * declaration has no consumer, whatever the reference would have been.
 */
export async function findUnreferencedExports(options: ReferenceCheckOptions): Promise<WiringFinding[]> {
    const surface = await readSurface(options.root, options.surface);
    // f1, measured: this defaulted to `['src']` while the finding said "no reference **anywhere in the repository**".
    // That is false twice over — a hand-written consumer outside `src` was invisible, and the wording claimed a search
    // that never happened. The surface is now the repository's production roots, and the finding names it.
    const searchDirs = options.search ?? ['src', 'scripts', 'host', 'evals'];
    const productionFiles = await filesUnder(options.root, searchDirs);
    const production = new Map<string, string>();
    for (const path of productionFiles) {
        const text = await readFile(join(options.root, path), 'utf8').catch(() => '');
        production.set(path, text);
    }
    // Defaulted rather than optional: without it every test-only export is reported as "no reference anywhere", which is
    // false. The measured 24 and the measured 15 are different classes and the report says which is which.
    const testGlobs = options.testGlobs ?? ['tests'];
    const testText = (await Promise.all((await filesUnder(options.root, testGlobs)).map((path) => readFile(join(options.root, path), 'utf8').catch(() => '')))).join('\n');

    const findings: WiringFinding[] = [];
    for (const [file, text] of surface) {
        for (const pattern of EXPORT_PATTERNS) {
            pattern.lastIndex = 0;
            let match: RegExpExecArray | null;
            while ((match = pattern.exec(text))) {
                const name = match[1]!;
                // The `g` flag is load-bearing: without it `String.match` returns only the first hit, so a symbol used
                // *within its own declaring file* counted as one occurrence — indistinguishable from a declaration with no
                // consumer. Measured effect of getting this wrong: 148 findings instead of 24, including
                // `runWiringCheck`, `issueAdversarialBrief` and every other symbol called in the file that exports it.
                const word = new RegExp(`\\b${escapeRegExp(name)}\\b`, 'g');
                let references = 0;
                for (const [path, source] of production) references += occurrences(source, word);
                // Subtract the one in its own declaration; a symbol that appears exactly once is referenced by nothing.
                if (references - 1 > 0) continue;
                const testReferences = testText ? occurrences(testText, word) : 0;
                findings.push({
                    check: 'reference',
                    file,
                    line: lineOf(text, match.index),
                    subject: name,
                    detail: testReferences > 0
                        ? `no reference in ${searchDirs.join(', ')}; kept alive only by tests (${testReferences} occurrences in tests)`
                        // The claim is bounded by what was searched. A bundled consumer cannot be seen by name at
                        // all — `scripts/wiring-check.mjs` calls this file's entry point as `module.n` after
                        // minification — so a symbol that is an entry point still lands here, and the wording must not
                        // pretend otherwise.
                        : `no reference in ${searchDirs.join(', ')}`,
                });
            }
        }
    }
    return findings;
}

// ── Check B ─────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface DeclaredMemberOptions {
    root: string;
    surface: string[];
}

interface DeclaredList {
    file: string;
    line: number;
    name: string;
    members: Array<{ value: string; line: number }>;
}

/**
 * Parse `export const NAME = [ ... ] as const` by scanning, not by regex.
 *
 * The scan tracks string state, comment state and bracket depth, which is what makes a multi-line list containing an
 * apostrophe in prose parse correctly — the exact input the measurement harness got wrong.
 */
export function parseDeclaredLists(file: string, text: string): DeclaredList[] {
    const lists: DeclaredList[] = [];
    const header = /export\s+const\s+([A-Za-z0-9_$]+)\s*(?::[^=]+)?=\s*\[/g;
    let match: RegExpExecArray | null;
    while ((match = header.exec(text))) {
        const name = match[1]!;
        const openIndex = match.index + match[0].length - 1;
        const members: Array<{ value: string; line: number }> = [];
        let depth = 0;
        // Brace depth matters: without it, a property value inside an *object* element of the array counts as a member of
        // the list. That produced `platformDefinitions -> 'Gemini CLI'` and similar — labels that are consumed by
        // iteration and never looked up by name — which is noise, not a finding.
        let braceDepth = 0;
        let index = openIndex;
        let stringQuote: string | null = null;
        let inLineComment = false;
        let inBlockComment = false;
        let current = '';
        let currentStart = -1;
        let closed = false;

        for (; index < text.length; index++) {
            const char = text[index]!;
            const next = text[index + 1];

            if (inLineComment) {
                if (char === '\n') inLineComment = false;
                continue;
            }
            if (inBlockComment) {
                if (char === '*' && next === '/') {
                    inBlockComment = false;
                    index++;
                }
                continue;
            }
            if (stringQuote) {
                if (char === '\\') {
                    current += text[index + 1] ?? '';
                    index++;
                    continue;
                }
                if (char === stringQuote) {
                    if (stringQuote === "'" && depth === 1 && braceDepth === 0) {
                        members.push({ value: current, line: lineOf(text, currentStart) });
                    }
                    stringQuote = null;
                    current = '';
                } else {
                    current += char;
                }
                continue;
            }
            if (char === '/' && next === '/') {
                inLineComment = true;
                index++;
                continue;
            }
            if (char === '/' && next === '*') {
                inBlockComment = true;
                index++;
                continue;
            }
            if (char === "'" || char === '"' || char === '`') {
                stringQuote = char;
                current = '';
                currentStart = index;
                continue;
            }
            if (char === '{') braceDepth++;
            if (char === '}') braceDepth--;
            if (char === '[') depth++;
            if (char === ']') {
                depth--;
                if (depth === 0) {
                    closed = true;
                    break;
                }
            }
        }
        if (!closed) continue;
        // Only `as const` lists are declarations of a closed set; an ordinary array literal is not.
        if (!/^\s*as\s+const/.test(text.slice(index + 1, index + 20))) continue;
        lists.push({ file, line: lineOf(text, match.index), name, members });
    }
    return lists;
}

/** A declared member nothing consumes. */
export async function findUnconsumedDeclaredMembers(options: DeclaredMemberOptions): Promise<WiringFinding[]> {
    const surface = await readSurface(options.root, options.surface);
    const searchDirs = options.surface.length > 0 ? [...new Set(options.surface.map((path) => path.split('/')[0]!))] : ['src'];
    const scope = await filesUnder(options.root, searchDirs);
    const sources = new Map<string, string>();
    for (const path of scope) {
        const text = await readFile(join(options.root, path), 'utf8').catch(() => '');
        sources.set(path, text);
    }

    const findings: WiringFinding[] = [];
    for (const [file, text] of surface) {
        for (const list of parseDeclaredLists(file, text)) {
            for (const member of list.members) {
                const quoted = new RegExp(`['"\`]${escapeRegExp(member.value)}['"\`]`, 'g');
                let references = 0;
                for (const source of sources.values()) references += occurrences(source, quoted);
                // Subtract the one occurrence inside the declaration itself.
                if (references - 1 > 0) continue;
                // f6, measured: a member consumed as part of its **list** has no quoted occurrence of its own.
                // `developmentModes.includes(mode)`, `[...unmeasuredMetrics]` and `parsed[field]` all consume
                // members without ever naming one, so a quoted-literal count reported them as consumed nowhere.
                // The changelog already states the rule — labels consumed by iteration are not findings — and the
                // code contradicted it.
                const listWord = new RegExp(`\\b${escapeRegExp(list.name)}\\b`, 'g');
                let listReferences = 0;
                for (const source of sources.values()) listReferences += occurrences(source, listWord);
                // One occurrence is the declaration itself; anything more means the list is used somewhere.
                if (listReferences - 1 > 0) continue;
                findings.push({
                    check: 'declared-member',
                    file,
                    line: member.line,
                    subject: member.value,
                    detail: `declared in ${list.name} and consumed nowhere`,
                });
            }
        }
    }
    return findings;
}

// ── Check C ─────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface RefusalGuard {
    file: string;
    line: number;
    condition: string;
    /** The exact source line, used as the mutation anchor so an unapplied mutation is detectable. */
    text: string;
}

const REFUSAL = /satisfied:\s*false|ok:\s*false|reason:\s*'|throw new /;

/** Every `if (...) {` whose body contains a refusal, on the declared surface. */
export async function discoverRefusalGuards(options: { root: string; surface: string[] }): Promise<RefusalGuard[]> {
    const surface = await readSurface(options.root, options.surface);
    const guards: RefusalGuard[] = [];
    for (const [file, text] of surface) {
        const lines = text.split('\n');
        for (let index = 0; index < lines.length; index++) {
            const line = lines[index]!;
            const match = /^(\s*)if \((.+)\) \{$/.exec(line);
            if (!match) continue;
            const indent = match[1]!.length;
            let body = '';
            for (let next = index + 1; next < Math.min(lines.length, index + 45); next++) {
                const candidate = lines[next]!;
                const lead = candidate.length - candidate.trimStart().length;
                if (candidate.trim() && lead <= indent) break;
                body += `${candidate}\n`;
            }
            if (!REFUSAL.test(body)) continue;
            guards.push({ file, line: index + 1, condition: match[2]!, text: line });
        }
    }
    return guards;
}

export interface MutationApplication {
    status: 'applied' | 'unapplied';
    reason?: string;
}

/**
 * Disable one guard inside the scratch copy.
 *
 * `unapplied` is a first-class outcome: the 2026-09-22 run's first attempt used a guessed identifier, the module threw,
 * every importer went red, and the result read as a detected defect. A mutation whose anchor is gone must be reported as
 * unapplied and counted on neither side.
 */
export async function applyMutation(copyRoot: string, guard: RefusalGuard): Promise<MutationApplication> {
    const path = join(copyRoot, guard.file);
    const text = await readFile(path, 'utf8').catch(() => null);
    if (text === null) return { status: 'unapplied', reason: `${guard.file} is not present in the scratch copy` };
    if (!text.includes(guard.text)) {
        // Either the anchor never existed or an earlier mutation in the same file already moved it.
        return { status: 'unapplied', reason: `the guard anchor is no longer present: ${guard.text.trim()}` };
    }
    const disabled = guard.text.replace(/if \(.+\) \{$/, 'if (false) {');
    if (disabled === guard.text) return { status: 'unapplied', reason: `the guard line is not a disabling shape: ${guard.text.trim()}` };
    await writeFile(path, text.replace(guard.text, disabled), 'utf8');
    return { status: 'applied' };
}

export interface MutationCheckOptions {
    root: string;
    /** Where the disposable copy is made. Never the caller's tree. */
    scratch: string;
    surface: string[];
    /** What runs after each mutation, relative to the scratch copy. */
    testCommand: { command: string; args: string[] };
    /** Above this many failing files a mutation is a type/compile collapse, discounted rather than counted. */
    collapseThreshold?: number;
    maxMutations?: number;
    onProgress?: (line: string) => void;
}

export interface MutationResult {
    guard: RefusalGuard;
    status: 'decorative' | 'noticed' | 'collapse' | 'unapplied';
    failingFiles: number;
    note?: string;
}

const FAIL_LINE = /^\s*FAIL\s+(\S+)/gm;

export function countFailingFiles(output: string): number {
    return new Set([...output.matchAll(FAIL_LINE)].map((match) => match[1])).size;
}

async function copyForScratch(root: string, scratch: string): Promise<void> {
    await rm(scratch, { recursive: true, force: true });
    await mkdir(scratch, { recursive: true });
    const scratchFromRoot = relative(root, scratch);
    for (const entry of await readdir(root)) {
        if (SKIP.has(entry)) continue;
        // The scratch directory may live inside the tree being copied — `tmp/` is skipped already, but a caller may point
        // it anywhere, and copying a directory into itself fails with EINVAL rather than doing something surprising.
        if (scratchFromRoot === entry || scratchFromRoot.startsWith(`${entry}/`) || scratchFromRoot.startsWith(`${entry}\\`)) continue;
        await cp(join(root, entry), join(scratch, entry), { recursive: true, force: true });
    }
}

const runCommand = (command: string, args: string[], cwd: string): Promise<{ code: number; output: string }> =>
    new Promise((resolve) => {
        execFile(command, args, { cwd, maxBuffer: 1 << 28 }, (error, stdout, stderr) => {
            const code = error && typeof (error as { code?: number }).code === 'number' ? (error as { code: number }).code : error ? 1 : 0;
            resolve({ code, output: `${stdout ?? ''}${stderr ?? ''}` });
        });
    });

/**
 * The guards a full run does not notice — the prospective form of the third check.
 *
 * The caller's tree is never written to: every mutation happens in `scratch`, and each mutation restores the file from
 * the caller's tree first so the mutations cannot accumulate.
 */
export async function findDecorativeGuards(options: MutationCheckOptions): Promise<MutationResult[]> {
    const surface = await readSurface(options.root, options.surface);
    const guards = (await discoverRefusalGuards({ root: options.root, surface: options.surface })).slice(0, options.maxMutations ?? Number.POSITIVE_INFINITY);
    const collapseThreshold = options.collapseThreshold ?? 5;

    await copyForScratch(options.root, options.scratch);

    const results: MutationResult[] = [];
    for (const guard of guards) {
        // Restore from the caller's tree so each mutation is measured on a clean copy.
        const pristine = surface.get(guard.file);
        if (pristine === undefined) {
            results.push({ guard, status: 'unapplied', failingFiles: 0, note: 'the guard file is not on the declared surface' });
            continue;
        }
        await writeFile(join(options.scratch, guard.file), pristine, 'utf8');

        const application = await applyMutation(options.scratch, guard);
        if (application.status === 'unapplied') {
            results.push({ guard, status: 'unapplied', failingFiles: 0, note: application.reason });
            options.onProgress?.(`unapplied  ${guard.file}:${guard.line}  ${guard.condition}`);
            continue;
        }

        const { code, output } = await runCommand(options.testCommand.command, options.testCommand.args, options.scratch);
        const failingFiles = countFailingFiles(output) || (code !== 0 ? 1 : 0);
        const status: MutationResult['status'] = failingFiles > collapseThreshold ? 'collapse' : code !== 0 ? 'noticed' : 'decorative';
        results.push({ guard, status, failingFiles });
        options.onProgress?.(`${status.padEnd(10)} ${guard.file}:${guard.line}  ${guard.condition}`);
    }

    await rm(options.scratch, { recursive: true, force: true });
    return results;
}

// ── the command ─────────────────────────────────────────────────────────────────────────────────────────────────────

export interface WiringCheckOptions {
    root: string;
    surface: string[];
    checks?: Array<WiringFinding['check']>;
    reference?: Omit<ReferenceCheckOptions, 'root' | 'surface'>;
    mutation?: Omit<MutationCheckOptions, 'root' | 'surface'>;
    onProgress?: (line: string) => void;
}

export interface WiringCheckRun {
    findings: WiringFinding[];
    /** Non-empty when the instrument could not do its job. Never a pass. */
    instrument: string[];
    exitCode: 0 | 1 | 2;
}

export async function runWiringCheck(options: WiringCheckOptions): Promise<WiringCheckRun> {
    const checks = options.checks ?? ['reference', 'declared-member'];
    const findings: WiringFinding[] = [];
    const instrument: string[] = [];
    const attempt = async (run: () => Promise<void>) => {
        try {
            await run();
        } catch (error) {
            if (error instanceof WiringInstrumentError) instrument.push(...error.problems);
            else instrument.push(error instanceof Error ? error.message : String(error));
        }
    };

    if (checks.includes('reference')) {
        await attempt(async () => {
            findings.push(...(await findUnreferencedExports({ root: options.root, surface: options.surface, ...options.reference })));
        });
    }
    if (checks.includes('declared-member')) {
        await attempt(async () => {
            findings.push(...(await findUnconsumedDeclaredMembers({ root: options.root, surface: options.surface })));
        });
    }
    if (checks.includes('mutation')) {
        await attempt(async () => {
            if (!options.mutation) throw new WiringInstrumentError(['the mutation check needs a scratch directory and a test command']);
            const results = await findDecorativeGuards({ root: options.root, surface: options.surface, ...options.mutation });
            for (const result of results) {
                if (result.status === 'decorative') {
                    findings.push({
                        check: 'mutation',
                        file: result.guard.file,
                        line: result.guard.line,
                        subject: result.guard.condition,
                        detail: 'the guard can be disabled with the run still green, so no test exercises this refusal',
                    });
                } else if (result.status === 'unapplied') {
                    instrument.push(`unapplied mutation at ${result.guard.file}:${result.guard.line} — ${result.note ?? 'anchor missing'}`);
                }
            }
        });
    }

    const exitCode: WiringCheckRun['exitCode'] = instrument.length > 0 ? 2 : findings.length > 0 ? 1 : 0;
    return { findings, instrument, exitCode };
}

export interface WiringCommandOptions {
    root?: string;
    surface?: string[];
    checks?: Array<WiringFinding['check']>;
    mutation?: { scratch: string; command: string; args: string[]; collapseThreshold?: number };
    print?: (line: string) => void;
}

/**
 * The command surface. Returns the exit code so a caller — a script, CI — can gate on it without parsing output.
 *
 * Three states: `0` clean, `1` findings, `2` the instrument could not run. A caller that treats a non-zero code as failure
 * is right either way; a caller that treats `2` as "the code is bad" is wrong about why, which is why the two are distinct.
 */
export async function runWiringCheckCommand(options: WiringCommandOptions): Promise<number> {
    const print = options.print ?? ((line: string) => process.stdout.write(`${line}\n`));
    const root = options.root ?? process.cwd();
    const surface = options.surface ?? [];
    // Default surface is `src` alone. Test files legitimately contain code as data — this repository's own
    // `wiring-check-reference.test.ts` holds a fixture declaration in a string literal — and parsing those produces
    // findings about a fixture. Including tests is opt-in, via `--surface`.
    const declared = surface.length > 0 ? surface : await filesUnder(root, ['src']);
    const checks = options.checks ?? ['reference', 'declared-member'];

    const run = await runWiringCheck({
        root,
        surface: declared,
        checks,
        ...(options.mutation
            ? {
                mutation: {
                    scratch: options.mutation.scratch,
                    testCommand: { command: options.mutation.command, args: options.mutation.args },
                    ...(options.mutation.collapseThreshold ? { collapseThreshold: options.mutation.collapseThreshold } : {}),
                    onProgress: print,
                },
            }
            : {}),
        onProgress: print,
    });

    for (const finding of run.findings) print(`${finding.check}  ${finding.file}:${finding.line}  ${finding.subject}  — ${finding.detail}`);
    for (const problem of run.instrument) print(`instrument  ${problem}`);
    print(
        run.exitCode === 0
            ? `clean: ${declared.length} declared path(s), nothing unreferenced and nothing unconsumed`
            : run.exitCode === 1
                ? `findings: ${run.findings.length}`
                : `the check could not run: ${run.instrument.length} problem(s) — this is not a pass`,
    );
    return run.exitCode;
}

