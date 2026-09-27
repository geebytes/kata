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
