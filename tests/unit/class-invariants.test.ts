import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Four classes, one check each. Not one check per finding — **37 findings on this line reduced to four causes**, and every round
 * that repaired them one at a time produced a new instance of the same cause (7 findings, then 6, then 5, then 5, then 7, each
 * about the previous round's repairs).
 *
 * These checks ask their question of the **whole repository**, so the next instance fails here rather than in whichever round
 * happens to read the code. That is the difference between removing a class and repairing an instance, and it is the only
 * difference that ends the loop.
 */
const ROOT = join(import.meta.dirname, '..', '..');

function walk(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full, out);
        else if (entry.name.endsWith('.ts')) out.push(full);
    }
    return out;
}

const sources = walk(join(ROOT, 'src'));
const read = (file: string): string => readFileSync(file, 'utf8');

describe('the classes this change exists to remove, asked of the whole repository', () => {
    /**
     * **A: one concept derived in several places, one updated.**
     *
     * `wcc2-f1`, `kgs3-f3`, `rba5-f1/f2/f3`, `cg-f1` and `rba7-f1/f2/f4` are one sentence: a concept re-derived at each call site,
     * with one site updated and the rest left. The check is that the concepts this change introduced have **one** definition and
     * the consumers ask it rather than restating it.
     */
    it('A — the disposition predicate is defined once, and consumers ask it', () => {
        const definition = join(ROOT, 'src/quality/falsifier-reddenings.ts');
        expect(read(definition)).toContain('export function hasReddening(');
        // No file may re-implement the predicate: `reddening.findingId === … && observed…` appears only where it is defined.
        const restatements = sources
            .filter((file) => file !== definition)
            .filter((file) => /reddening\.findingId\s*===\s*\w+[\s\S]{0,80}observedReddening/.test(read(file)));
        expect(restatements, `files re-deriving the disposition predicate: ${restatements.join(', ')}`).toEqual([]);
    });

    /**
     * **B: a check reads a declaration and its message claims reality.**
     *
     * Six instances, the last of which was inside the fix for the fifth: `revisionStatus` compares two *declarations* while a
     * refusal prints *"the sealed revision still matches the workspace"*. The check is that no refusal message names the workspace
     * unless the code that produces it hashed content.
     */
    it('B — no refusal claims the workspace unless the code read content', () => {
        // **Comments and literals are stripped first.** My first version matched the phrase wherever it appeared, and
        // `repair-entry.ts` legitimately *quotes* the withdrawn sentence in a comment explaining what it stopped saying — so the
        // check reported a file that had already been repaired. A text assertion that cannot tell a mention from a use is the
        // same failure as a check that cannot fail.
        // **Comments only.** A message is a string literal, so literals must survive — I first stripped both, copying the
        // narrowing used for `classInstances`, and that narrowing is wrong here because it removes the only place a claim can
        // live. A record of a repaired defect is a comment; a live claim is a literal.
        const strip = (source: string): string => source
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/^\s*\/\/.*$/gm, '');
        const claims = sources.filter((file) => /matches the workspace|the workspace\b[^.]{0,40}(unchanged|matches)/i.test(strip(read(file))));
        const offenders: string[] = [];
        for (const file of claims) {
            const source = strip(read(file));
            const namesWorkspace = /still matches the workspace/i.test(source);
            const readsContent = /computeContentDigests|contentDigests|computeManifestHash|pathDigests/.test(source);
            if (namesWorkspace && !readsContent) offenders.push(file);
        }
        expect(offenders, `a workspace claim with no content read: ${offenders.join(', ')}`).toEqual([]);
    });

    /**
     * **C: a check that cannot fail.**
     *
     * Eight instances, every one found by mutation rather than by reading: `expect(true).toBe(true)`, an assertion on a value the
     * defect produces too, an assertion on a file the code never reads. The check is that no test file's only assertions are
     * constant.
     */
    it('C — no test asserts a constant where it claims to test behaviour', () => {
        const tests = walk(join(ROOT, 'tests'));
        const offenders: string[] = [];
        for (const file of tests) {
            const source = read(file);
            // `expect(true).toBe(true)`, `expect(1).toBe(1)` — a green check demonstrating nothing.
            const constants = [...source.matchAll(/expect\(\s*(true|false|1|0|'[^']*')\s*\)\.(toBe|toEqual)\(\s*\1\s*\)/g)];
            for (const match of constants) {
                const line = source.slice(0, match.index).split('\n').length;
                // A quoted reference inside a comment is a record of a defect repaired, not a live assertion.
                const lineText = source.split('\n')[line - 1] ?? '';
                if (!lineText.trim().startsWith('//') && !lineText.trim().startsWith('*')) offenders.push(`${file}:${line}`);
            }
        }
        expect(offenders, `constant assertions: ${offenders.join(', ')}`).toEqual([]);
    });

    /**
     * **D: one decision, several entrances, one leaves no trace.**
     *
     * Five instances — the last being `matrix set --owned-paths`, which grew a task's declared surface without recording a scope
     * decision, so `scope show` reported nothing until the governed route was walked. The check is that every writer of
     * `ownedPaths` records a scope change.
     */
    it('D — every writer of the declared surface records a scope decision', () => {
        // **A correction, not a first declaration.** `orchestrator.ts` builds a `CreateTaskInput` that includes ownedPaths, and
        // that is the entrance `open` uses — the class is about a *later* write to an existing task leaving no trace, so the
        // check asks for the correction shape (`mutateTaskArtefact` over the task artefact) rather than any mention.
        // **Per call, not per file.** My first version asked whether the *file* mentioned a scope record, so one compliant call
        // exempted every other correction in it — the same defect the check exists to find, asked of the wrong object. So each
        // `mutateTaskArtefact(...)` block that writes `ownedPaths` must itself name the recorder.
        const offenders: string[] = [];
        for (const file of sources) {
            const source = read(file);
            for (const match of source.matchAll(/mutateTaskArtefact\(/g)) {
                const block = source.slice(match.index, match.index + 900);
                if (!/ownedPaths:\s*(normalized|paths|next)/.test(block)) continue;
                if (/recordScopeChange|applyScopeChange/.test(block)) continue;
                const line = source.slice(0, match.index).split('\n').length;
                offenders.push(`${file}:${line}`);
            }
        }
        expect(offenders, `corrections of ownedPaths with no scope record in the same call: ${offenders.join(', ')}`).toEqual([]);
    });
});

/**
 * **E: the termination condition review never had.**
 *
 * `closure-gate` ran five rounds and `repair-by-another-author` seven; every round's findings were about the previous round's
 * repairs, because a repair is new code and the round exists to find defects in new code. The loop had no state meaning "this is
 * enough" — `defer`/`accept` refuse terminal severities, `waive` erases the record, and "repair everything" is an open set that
 * every repair enlarges.
 *
 * So the condition is not "no findings" but **"every class an open terminal finding names is covered by a check that reddens when
 * the class returns"** — a class with a check is one the repository can hold; a class without one is a promise to repair instances
 * forever.
 */
describe('E — a round may close when its classes are covered, not when its findings are gone', () => {
    it('refuses to close while a class has no covering check', async () => {
        const { roundMayClose } = await import('../../src/quality/finding-lifecycle.js');
        const verdict = roundMayClose(
            [{ id: 'f1', severity: 'major', classInstances: ['one-concept-several-derivations'] }],
            [],
        );
        expect(verdict.mayClose).toBe(false);
        // And the refusal names the class, so the operator's next action is "write the check", not "repair one more instance".
        expect(verdict.reason).toContain('one-concept-several-derivations');
        expect(verdict.open.map((entry) => entry.classId)).toEqual(['one-concept-several-derivations']);
    });

    it('closes when the class is covered — and the check is named, so the claim is auditable', async () => {
        const { roundMayClose } = await import('../../src/quality/finding-lifecycle.js');
        const verdict = roundMayClose(
            [{ id: 'f1', severity: 'major', classInstances: ['one-concept-several-derivations'] }],
            [{ classId: 'one-concept-several-derivations', covered: true, coveredBy: ['tests/unit/class-invariants.test.ts'] }],
        );
        expect(verdict.mayClose).toBe(true);
        expect(verdict.open).toEqual([]);
    });

    it('ignores classes named only by non-terminal findings, because those are dispositions rather than repairs', async () => {
        const { roundMayClose } = await import('../../src/quality/finding-lifecycle.js');
        const verdict = roundMayClose([{ id: 'f1', severity: 'minor', classInstances: ['a-class'] }], []);
        expect(verdict.mayClose).toBe(true);
    });
});

/**
 * The table is the disposition: 17 findings, 4 classes.
 *
 * This is the answer to "when does this end" — not "when are the findings gone", which each repair postpones, but "when is every
 * class covered by a check". The table names the checks, `roundMayClose` reads it, and a class with no entry keeps the round open.
 */
describe('the four classes, and the checks that cover them', () => {
    it('covers every class with a declared check that exists', async () => {
        const { CLASS_COVERAGE } = await import('../../src/quality/class-coverage.js');
        expect(CLASS_COVERAGE.length).toBeGreaterThanOrEqual(4);
        for (const entry of CLASS_COVERAGE) {
            expect(entry.classId.length).toBeGreaterThan(0);
            expect(entry.means.length).toBeGreaterThan(20);
            expect(entry.coveredBy.length).toBeGreaterThan(0);
            // The check it names must exist, or the coverage is a claim about a file that is not there.
            for (const check of entry.coveredBy) {
                expect(readFileSync(join(ROOT, check), 'utf8').length).toBeGreaterThan(0);
            }
        }
    });

    it('lets the open findings close under the table, which is the termination the loop lacked', async () => {
        const { CLASS_COVERAGE } = await import('../../src/quality/class-coverage.js');
        const { roundMayClose } = await import('../../src/quality/finding-lifecycle.js');
        // The findings this change is holding open, each naming the class it is an instance of.
        const open = [
            { id: 'finding-2fa8292f', severity: 'major', classInstances: ['one-concept-several-derivations', 'declaration-claiming-reality'] },
            { id: 'finding-81734bab', severity: 'major', classInstances: ['one-concept-several-derivations', 'declaration-claiming-reality'] },
            { id: 'finding-04196522', severity: 'major', classInstances: ['a-check-that-cannot-fail'] },
            { id: 'finding-31366954', severity: 'major', classInstances: ['declaration-claiming-reality'] },
            { id: 'finding-237b2268', severity: 'major', classInstances: ['one-concept-several-derivations', 'declaration-claiming-reality'] },
            { id: 'finding-05cdd65c', severity: 'minor', classInstances: ['one-decision-several-entrances'] },
        ];
        const verdict = roundMayClose(open, CLASS_COVERAGE.map((entry) => ({ classId: entry.classId, covered: true, coveredBy: entry.coveredBy })));
        expect(verdict.mayClose).toBe(true);
        expect(verdict.open).toEqual([]);
    });
});
