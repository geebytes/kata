import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * **A test must not read the repository's own governed store.**
 *
 * This class bit twice in one change, from both directions. The first version of a case read an absolute path inside a
 * leftover linked worktree, so it passed only while that stale checkout was on disk. The fix was to read the record from
 * `process.cwd()` — which is the workspace when the suite runs on its own and the seal's *isolated snapshot* when it runs
 * inside a seal. `.kata/` is gitignored, so the snapshot does not carry it:
 *
 *     FAIL tests/unit/eval-metrics.test.ts   exitCode: 1
 *     Error: Cannot read task artefact /tmp/kata-seal-execution-bTBuro/.kata/tasks/.../task.json: ENOENT
 *
 * Same suite, green outside the seal and red inside it — the one place a check has to be green. So: no test reads
 * `.kata/tasks/**` from the repository it lives in. A test builds its own workspace (`mkdtemp`) or reads a fixture it
 * carries, and the repository's own store is read by the CLI's cases only through a temp root.
 *
 * The check is worth having because the failure is invisible where the author looks: the data really is there, the numbers
 * really are right, and only the seal disagrees.
 */
const TESTS = new URL('../', import.meta.url).pathname;

async function testFiles(dir: string): Promise<string[]> {
    const out: string[] = [];
    for (const entry of await readdir(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) out.push(...(await testFiles(full)));
        else if (entry.name.endsWith('.ts')) out.push(full);
    }
    return out;
}

/**
 * The repository root, as the source of governed state rather than as a source tree. Reading the *source* from the
 * repository is legitimate and several checks do it (`kernel is pure`, `generated assets are current`): those read `src/`,
 * which the snapshot carries. What the snapshot does not carry is `.kata/`.
 */
const READS_TASK_STATE = [
    /readTask\(\s*process\.cwd\(\)/,
    /readLedger\(\s*process\.cwd\(\)/,
    /readCurrentState\(\s*process\.cwd\(\)/,
    /readProbes?\(\s*process\.cwd\(\)/,
    /readVerdictHistory\(\s*process\.cwd\(\)/,
    /readCurrentTaskRevision\(\s*process\.cwd\(\)/,
    // A literal path into the live store, which is the same read written out.
    /join\(\s*process\.cwd\(\),\s*['"`]\.kata\//,
];

/**
 * **A fixture may not fabricate the revision identity the seal is supposed to produce.**
 *
 * This class bit three times in one change, in three drafts of the same case, and each draft asserted a different wrong
 * thing: a hand-written `current-revision.json`, an id discovered by sealing first (which moves the pointer away), and a
 * reuse granted by a pointer-only gate that re-opened the defect the whole change exists to remove. What they have in
 * common is that the fixture *decided the identity itself*, so the case measured the fixture's arithmetic — and "the test
 * is wrong" and "the implementation is wrong" are indistinguishable until one of them changes.
 *
 * **The first version of this guard was green while a live instance of the class sat in the directory it scanned**
 * (`tests/unit/repair-entry.test.ts` seeds `current-revision.json` through a local `writeJson` helper with a template path).
 * It required a closing quote straight after the filename, and only recognised three write helpers. It also carried no
 * proof of its own reach — the failure mode of every pattern list. So it now:
 *
 *   • matches the **bare filename**, wherever it appears on the line (template paths, `relative` arguments, constants);
 *   • accepts **any write call**, not three spellings of one, because the helper a case routes through is its own choice
 *     (`writeJson`, `seedRevision`, `persist`) and the write it performs is still a write;
 *   • looks for the seeded record in a **window around the write**, front and back, because the record is usually
 *     assembled a statement or two above;
 *   • and asserts its own reach with **control cases**: one fabricated identity it must flag, one staged defect it must
 *     not. A guard that matches nothing proves nothing.
 *
 * **The rule distinguishes a staged defect from a fabricated identity**, and the two are not the same act: a truncated
 * `{}` is how the unreadable-state cases are built (no command produces a corrupt artefact), while a record with an `id`
 * and a `manifestHash` in it is a case answering a question the engine owns. So the guard matches the *absence of
 * authority*, not the act of writing.
 */
const REVISION_ARTEFACT = /current-revision\.json|currentRevisionPath\s*\(/;
/** The markers of a *revision record*: an id in the revision namespace, or a manifest/hash field being set. */
const REVISION_ISH = /revision-[a-z0-9]|manifestHash\s*[:=]|pathDigests\s*[:=]|contentDigests\s*[:=]/;
/** The calls that produce a revision identity: a write whose payload comes from one of these is the engine's, not a fixture's. */
const ENGINE_PRODUCES = /createTaskRevisionIfChanged|currentRevisionIdentity|readCurrentTaskRevision|readTaskRevision|sealRevision/;
/** A write to the artefact, spelled any way. */
const WRITE_CALL = /write|seed|persist|save|create/i;

/** Comments blanked, names intact — the view in which the artefact **is named**, which string-blanking would erase. */
function withoutComments(text: string): string {
    return text
        .replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, ' '))
        .replace(/^[ \t]*\/\/.*$/gm, (line) => ' '.repeat(line.length));
}

/**
 * The `n`th argument of the call that names the artefact, as text — read by balance, not by a regex that stops at the
 * first comma.
 *
 * **A line is not a statement, and that was the blocking finding.** The previous version required the artefact's name and a
 * write call on the *same line*, so a live hand-written revision record laid out over three lines
 * (`review-artefact-read-state.test.ts`: path on one line, payload on the next) was invisible — measured: the guard
 * reported nothing for a file containing an instance of exactly the class it exists for, while the same record written on
 * one line was reported. A payload can be a multi-line object literal, so the span is found by parenthesis balance.
 */
function argumentAfterPath(statement: string): string | null {
    const path = /current-revision\.json['"`]|currentRevisionPath\s*\([^)]*\)/.exec(statement);
    if (!path) return null;
    // Walk forward from the path to the separator that ends it, then to the separator that ends the argument after it.
    // Depth starts at zero *outside* the call that produced the path, so the comma after a nested `join(…)` or
    // `currentRevisionPath(…)` counts — which is what makes one rule cover both spellings, including a payload on its own
    // line.
    let depth = 0;
    let argumentStart = -1;
    for (let index = path.index + path[0].length; index < statement.length; index += 1) {
        const char = statement[index] ?? '';
        if (char === '(' || char === '{' || char === '[') depth += 1;
        else if (char === ')' || char === '}' || char === ']') depth -= 1;
        else if (char === ',' && depth <= 0) {
            if (argumentStart === -1) argumentStart = index + 1;
            else return statement.slice(argumentStart, index).trim();
        }
    }
    if (argumentStart === -1) return null;
    return statement.slice(argumentStart).replace(/\)\s*;?\s*$/, '').trim();
}

/**
 * One pass of the guard's own rule over a source text, so its reach can be asserted rather than assumed.
 *
 * The rule, in three lines: find a statement that writes the revision artefact; ignore it when the identity comes from an
 * engine call; report it when **the payload it writes** is a revision record. Comments are blanked before the rule looks,
 * and only the payload is classified — so neither a sentence nor a neighbouring string can whitelist a fabricated record
 * (measured: `const note = 'the corrupt fixture';` used to do exactly that). A payload literal that *looks* like JSON and
 * does not parse is the one thing allowed through: a corrupt artefact is what a fixture cannot obtain from a command.
 */
function closureDrivenWriteOffenders(text: string, file: string): string[] {
    const lines = withoutComments(text).split('\n');
    const offenders: string[] = [];
    for (const [index, line] of lines.entries()) {
        if (!REVISION_ARTEFACT.test(line)) continue;
        // The statement: from the previous statement boundary through the line that closes this call.
        const from = (() => {
            for (let cursor = index - 1; cursor >= 0 && index - cursor <= 16; cursor -= 1) {
                if (/;\s*$/.test(lines[cursor] ?? '') || /\{\s*$/.test(lines[cursor] ?? '')) return cursor + 1;
            }
            return Math.max(0, index - 4);
        })();
        let depth = 0;
        let to = index;
        for (let cursor = index; cursor < Math.min(lines.length, index + 24); cursor += 1) {
            const current = lines[cursor] ?? '';
            depth += (current.match(/\(/g) ?? []).length - (current.match(/\)/g) ?? []).length;
            to = cursor;
            if (depth <= 0 && /;\s*$/.test(current)) break;
        }
        // The statement, plus the window in which its payload may have been *assembled* — above it, or on the line after
        // it, which is how these fixtures are usually written (`const revision = {…}` under the write that uses it).
        const window = lines.slice(Math.max(0, from - 4), Math.min(lines.length, to + 12)).join('\n');
        const statement = lines.slice(from, to + 1).join('\n');
        // **The write test belongs to the statement, not to the line that happens to name the artefact.** Measured: the
        // live instance this round found has the name inside a `join(…)` on one line and `await writeFile(` on the line
        // above it, so a per-line test reported nothing for a file that fabricates an identity — the third time this rule
        // was narrowed by its own spelling.
        if (!WRITE_CALL.test(statement)) continue;
        if (ENGINE_PRODUCES.test(statement)) continue;
        let payload = argumentAfterPath(statement);
        if (payload === null || payload === '') continue;
        // An identifier payload: what it was assigned is what gets written, and the assignment may sit outside the
        // statement itself. Without this, one spelling of the same fixture (the record declared on the next line) was
        // invisible while the other (declared in the same call) was caught.
        if (/^[A-Za-z_$][\w$]*$/.test(payload)) {
            const assigned = new RegExp(`(?:const|let|var)\\s+${payload}\\s*=\\s*([\\s\\S]*?);`).exec(window);
            if (assigned?.[1]) payload = assigned[1];
        }
        // A staged defect: a brace- or bracket-initial literal that does not parse. Plain junk (`'not json'`) is not a
        // record either and is not reported, because nothing about it claims an identity.
        const literal = /^['"`]([\s\S]*)['"`]$/.exec(payload)?.[1];
        if (literal !== undefined && /^[{[]/.test(literal.trim())) {
            try {
                JSON.parse(literal);
            } catch {
                continue;
            }
        }
        if (!REVISION_ISH.test(payload)) continue;
        offenders.push(`${file}:${index + 1}`);
    }
    return offenders;
}

describe('a fixture does not fabricate the revision identity', () => {
    it('finds no test that seeds a well-formed revision record', async () => {
        const offenders: string[] = [];
        for (const file of await testFiles(TESTS)) {
            if (file.endsWith('tests-do-not-read-the-live-task-store.test.ts')) continue;
            offenders.push(...closureDrivenWriteOffenders(await readFile(file, 'utf8'), file.replace(TESTS, 'tests/')));
        }
        expect(
            offenders,
            'a case that writes the revision identity measures its own arithmetic: drive the seal instead, or stage only a '
            + 'deliberately malformed record for a reader to refuse',
        ).toEqual([]);
    });

    /**
     * **The guard's reach, asserted rather than assumed.** Each sample is a real form this suite contains or could
     * contain; the first three must be flagged and the last two must not.
     */
    it('flags the forms it exists for and clears the ones it must not', () => {
        const samples: Array<[string, string, boolean]> = [
            ['template path through a local helper', "await writeJson(root, `.kata/tasks/${taskId}/current-revision.json`, revision);\nconst revision = { id: 'revision-superseded', manifestHash: 'a'.repeat(64) };", true],
            ['bare join path', "await writeFile(join(root, '.kata', 'tasks', taskId, 'current-revision.json'), record, 'utf8');\nconst record = { id: 'revision-abc', manifestHash: 'b'.repeat(64) };", true],
            ['a record seeded through a local helper', "await writeJson(root, `.kata/tasks/${taskId}/current-revision.json`, seedRevision);\nconst seedRevision = { id: 'revision-xyz', manifestHash: 'c'.repeat(64) };", true],
            ['staged defect for a reader', "await writeFile(join(root, '.kata', 'tasks', taskId, 'current-revision.json'), '{}');", false],
            ['a read, not a write', "const revisionPath = join(root, '.kata', 'tasks', taskId, 'current-revision.json');\nexpect((await readCurrentTaskRevisionState(root, taskId)).kind).toBe('absent');", false],
            // **The form the guard itself missed**, found by an adversarial pass: the path helper names the file without
            // writing its name as a literal. It is the shape this suite already used once while the guard reported nothing.
            ['the path helper instead of a literal', "await writeFile(currentRevisionPath(root, 'delta-task'), record, 'utf8');\nconst record = { id: 'revision-from-helper', manifestHash: 'd'.repeat(64) };", true],
            ['a malformed payload that is not {}', "await writeFile(join(root, '.kata', 'tasks', taskId, 'current-revision.json'), 'not json\\n');", false],
            // **A truncated payload is staged on purpose**, and it is recognised by asking whether the literal parses —
            // not by a keyword. `review-approval-refuses-open-findings.test.ts` writes exactly this shape.
            ['a truncated JSON payload', "await writeFile(join(root, '.kata', 'tasks', changeId, 'current-revision.json'), '{\"id\": \"rev-1\", \"manif');", false],
            // **The defect this rule was rebuilt for.** A comment about corruption used to whitelist a fabricated record,
            // because the staged-defect test ran over prose: the window is read as code now, so this must be flagged.
            // **The form an independent review measured as invisible, and the one that sat live in this suite**: the
            // artefact named inside a `join(…)`, the write on the line above it, the payload on the line below.
            ['the record laid out over three lines', "await writeFile(\n    join(root, '.kata', 'tasks', taskId, 'current-revision.json'),\n    `${JSON.stringify({ id: 'revision-laid-out', manifestHash: 'f'.repeat(64) })}\\n`,\n);", true],
            // A *string* that names a corruption must not whitelist code, which is the second half of the same finding.
            ['a string about corruption in the same statement', "const note = 'this fixture is the corrupt one';\nawait writeFile(join(root, '.kata', 'tasks', taskId, 'current-revision.json'), `${JSON.stringify({ id: 'revision-seeded', manifestHash: 'g'.repeat(64) })}`, 'utf8');", true],
            // An identity the engine produces is nobody's fixture: the same write, with the payload from the seal.
            ['an identity the engine produced', "const sealed = await createTaskRevisionIfChanged({ root, taskId, ownedPaths: ['src/a.ts'], checkIds: [] });\nawait writeFile(join(root, '.kata', 'tasks', taskId, 'current-revision.json'), JSON.stringify(sealed.revision), 'utf8');", false],
            ['a comment about corruption beside a real record', "// this file is deliberately corrupt in the other case\nawait writeFile(join(root, '.kata', 'tasks', taskId, 'current-revision.json'), record, 'utf8');\nconst record = { id: 'revision-seeded', manifestHash: 'e'.repeat(64) };", true],
        ];

        for (const [name, source, shouldFlag] of samples) {
            const flagged = closureDrivenWriteOffenders(source, name).length > 0;
            expect([name, flagged]).toEqual([name, shouldFlag]);
        }
    });

    /**
     * **The guard's blind spots, asserted as negatives rather than left to be discovered.**
     *
     * Each of these fabricates an identity and this rule does not see it. They are written down because a guard whose
     * limits are unstated reads as a guard with none — the mistake this suite made twice, including the earlier version
     * that claimed "any write call" while recognising three spellings. What the rule covers is a record written near its
     * own path; what it cannot cover is a record assembled somewhere else entirely.
     */
    it('names the shapes it cannot see, so its reach is stated rather than assumed', () => {
        const unseen: Array<[string, string]> = [
            ['the record assembled in another module', "import { seedRevision } from './helpers/seed.js';\nawait writeFile(currentRevisionPath(root, taskId), seedRevision(), 'utf8');"],
            ['the path computed at runtime', "const file = ['current-revision', 'json'].join('.');\nawait writeFile(join(root, file), { id: 'revision-x', manifestHash: 'y' }, 'utf8');"],
            ['the identity field named something else', "await writeFile(join(root, '.kata', 'tasks', taskId, 'current-revision.json'), { revision: 'abc', frozen: 'def' }, 'utf8');"],
            ['a factory that writes on its own', "await seedFrozenRevision(root, taskId, { id: 'revision-abc', manifestHash: 'z' });"],
        ];
        for (const [name, source] of unseen) {
            // The assertion is the *absence* of a report: these are the limits, kept honest by being written down.
            expect([name, closureDrivenWriteOffenders(source, name).length > 0]).toEqual([name, false]);
        }
    });
});

describe('a test does not read the live task store', () => {
    it('finds no test that reads governed state from the repository it lives in', async () => {
        const offenders: string[] = [];
        for (const file of await testFiles(TESTS)) {
            // **Excluding this file, because its own examples are text rather than reads.** The second case below holds one
            // sample line per pattern, and every one of them matches — which is the point of it — so the scan would report
            // itself and nothing else. The exclusion is by exact filename, so a copied pattern elsewhere is still caught.
            if (file.endsWith('tests-do-not-read-the-live-task-store.test.ts')) continue;
            const text = await readFile(file, 'utf8');
            for (const [index, line] of text.split('\n').entries()) {
                if (READS_TASK_STATE.some((pattern) => pattern.test(line))) {
                    offenders.push(`${file.replace(TESTS, 'tests/')}:${index + 1}`);
                }
            }
        }
        expect(
            offenders,
            'a test must build its own workspace: `.kata/` is gitignored, so the seal snapshot does not carry it and the '
            + 'read succeeds where the author looks and fails where it matters',
        ).toEqual([]);
    });

    it('is a check that can fail, because a pattern list that matches nothing proves nothing', async () => {
        // Every pattern in the list must match its own example — otherwise a typo quietly turns the check into a comment,
        // which is the `a check that can only pass` class this repository records.
        const examples = [
            'const t = await readTask(process.cwd(), "x");',
            'const l = await readLedger(process.cwd(), "x");',
            'const s = await readCurrentState(process.cwd(), "x");',
            'const p = await readProbes(process.cwd(), "x");',
            'const h = await readVerdictHistory(process.cwd(), "x");',
            'const r = await readCurrentTaskRevision(process.cwd(), "x");',
            "await readFile(join(process.cwd(), '.kata/tasks/x/task.json'), 'utf8');",
        ];
        for (const [index, example] of examples.entries()) {
            expect(READS_TASK_STATE[index]!.test(example), `pattern ${index} does not match its own example`).toBe(true);
        }
    });
});
