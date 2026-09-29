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
const FABRICATED_IDENTITY = /['"`]revision-[a-z0-9]|\bid:\s*['"`]|\bid:\s*[a-zA-Z]|manifestHash\s*[:=]/;
/**
 * A staged defect: the artefact is deliberately unreadable, which no command can produce and which a reader must refuse.
 *
 * It is not only `{}`. The unreadable-state cases stage whatever a truncated or corrupted artefact looks like — `'{}'`,
 * `'not json\\n'`, a bare string — and the guard has to allow the whole class, because a corrupt artefact is exactly what
 * a fixture cannot obtain any other way. What it must not allow is a *well-formed* record, which is what the identity
 * check below rejects.
 */
const STAGED_DEFECT = /(['"`]\{\}['"`]|\{\}\s*\n|JSON\.stringify\(\{\}\)|not json|not-json|malformed|corrupt)/i;

/**
 * Every comment blanked, so the rule reads the *write* and not the prose around it.
 *
 * **The newlines are kept, and that is not cosmetic.** Deleting a block comment removes the line breaks inside it, so the
 * returned text is shorter than the source and every index into it points at a different line than the caller thinks —
 * measured while writing this: the window for a busy call was assembled from a region eighteen lines away, which is why a
 * truncated payload sitting on the write itself was not found. Blanking preserves the numbering the caller relies on.
 */
function codeOnly(text: string): string {
    return text
        .replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, ''))
        .split('\n')
        .map((line) => (line.trim().startsWith('//') ? '' : line))
        .join('\n');
}

/** True when the window carries a string literal that looks like JSON and does not parse — a deliberately corrupt artefact. */
function windowHasTruncatedJson(window: string): boolean {
    for (const match of window.matchAll(/'((?:\\.|[^'\\])*)'/g)) {
        const literal = (match[1] ?? '').replace(/\\n/g, '\n').replace(/\\"/g, '"');
        if (!/^[{[]/.test(literal.trim())) continue;
        try {
            JSON.parse(literal);
        } catch {
            return true;
        }
    }
    return false;
}

/**
 * One pass of the guard's own rule over a source text, so its reach can be asserted rather than assumed.
 *
 * **The window is read as code, not as prose.** This is the fix the guard needed and did not have: `STAGED_DEFECT` was
 * tested against a fourteen-line window that included comments, and these files are full of comments saying `malformed`,
 * `corrupt` and `not json` — so a fixture that fabricated an identity was whitelisted by a *sentence* about corruption
 * somewhere near it. Measured: a fabricated record beside a comment naming a malformed one passed. The rule now strips
 * comments first, so only code can whitelist code.
 */
function closureDrivenWriteOffenders(text: string, file: string): string[] {
    const lines = text.split('\n');
    const code = codeOnly(text).split('\n');
    const offenders: string[] = [];
    for (const [index, line] of lines.entries()) {
        if (!REVISION_ARTEFACT.test(line)) continue;
        // A line that is entirely a comment cannot write anything.
        const trimmed = line.trim();
        if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')) continue;
        // A *write*, spelled any way: the artefact has to be produced by this line or by a call it makes.
        if (!/write|seed|persist|save|create/i.test(line)) continue;
        const window = code.slice(Math.max(0, index - 14), index + 4).join('\n');
        if (!FABRICATED_IDENTITY.test(window)) continue;
        if (STAGED_DEFECT.test(window)) continue;
        // **A truncated payload is a staged defect, and it is recognised by parsing rather than by a keyword.** The cases
        // that build an unreadable artefact write a literal that *looks* like JSON and is cut off — measured:
        // `'{"id": "rev-1", "manif'` in `review-approval-refuses-open-findings.test.ts`, which the keyword list could not
        // name and which the identity pattern therefore reported as a fabricated record. The rule reads the payload: a
        // brace- or bracket-initial string literal that `JSON.parse` refuses is a deliberate corruption, not an identity.
        if (windowHasTruncatedJson(window)) continue;
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
