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
        const { coveredClasses } = await import('../../src/quality/class-coverage.js');
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
        expect(CLASS_COVERAGE.length).toBeGreaterThanOrEqual(5);
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
        const { coveredClasses } = await import('../../src/quality/class-coverage.js');
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
        // **The predicate, not a literal** (`wcc6-f3`): this passed `covered: true` for every class it listed, so the case held whatever the
        // table said. It asks the function that decides it now.
        const verdict = roundMayClose(open, coveredClasses());
        // **And one of these findings is no longer closable** (`cg8-f1`): `a-check-that-cannot-fail` records an uncovered defining
        // instance, so for the third route's purpose — "a new instance of that class fails in the declared covering check" — it is not
        // covered. A finding naming it therefore keeps the round open, which is the honest answer rather than the convenient one.
        expect(verdict.mayClose).toBe(false);
        expect(verdict.open.map((entry) => entry.classId)).toEqual(['a-check-that-cannot-fail']);
        // And the same findings minus that one do close, so the rule is about that class and not about the list.
        const withoutIt = open.filter((finding) => !finding.classInstances.includes('a-check-that-cannot-fail'));
        expect(roundMayClose(withoutIt, coveredClasses()).mayClose).toBe(true);
    });
});

/**
 * **A producer with a consumer: a negative result, recorded rather than faked.**
 *
 * `impact` and `classInstances` were added to the finding contract and read by nothing, so a repair author decided how large its
 * repair must be without knowing what else it would reach or where else the class appears — which is how eight repairs on this line
 * fixed one instance of a class with several.
 *
 * **A text check cannot catch that.** I wrote one, twice: the first asserted each named reader contains its field, and removing the
 * field from one reader left it green because another reader still mentioned it; the second asked whether *any* module reads the
 * field, which is true of a common word in a large source tree whatever the consumers do. Both were decorative, in the change whose
 * subject is decorative checks, and the honest response is to say so rather than keep a check that cannot fail.
 *
 * What catches it is the mutation: remove the field's use from `repair-briefing.ts` and `tests/unit/repair-briefing.test.ts` reddens,
 * with `expected undefined to be a string`-shaped failures on the fields the author needs. That is a behavioural check on one
 * consumer, and it is the strongest one available here.
 */
describe('F — a producer with a consumer (a negative result, recorded)', () => {
    it('keeps the behavioural check that can fail: the briefing is the consumer', async () => {
        // **Behaviour, not the presence of a word** (`wcc4-f2`). This case asserted `toContain('impact')` over two source files,
        // so deleting the rendering lines it was supposed to protect left it green — the ninth check on this line that could not
        // fail, inside the change whose own table declares such checks a covered class. The measurement below is the one that
        // reddens: a finding that carries the field is rendered with it, and one that does not is not.
        // `renderRepairBriefing` is the pure function that draws the fields, so the check calls it directly with a finding that
        // carries them and one that does not. The mutation that reddens is deleting the two `if (finding.impact) …` lines.
        const { renderRepairBriefing } = await import('../../src/quality/repair-briefing.js');
        const base = { classes: [], findings: [] as unknown[] } as Record<string, unknown>;
        const withFields = renderRepairBriefing({
            ...base,
            findings: [{ id: 'f-with', severity: 'major', message: 'm', path: 'src/a.ts', impact: 'the six fixtures', classInstances: ['one-concept-several-derivations'] }],
        } as never);
        expect(withFields).toContain('the six fixtures');
        expect(withFields).toContain('one-concept-several-derivations');
        const withoutFields = renderRepairBriefing({
            ...base,
            findings: [{ id: 'f-without', severity: 'major', message: 'm', path: 'src/a.ts' }],
        } as never);
        expect(withoutFields).not.toContain('the six fixtures');
    });
});

/**
 * **The hole in the termination condition, closed.** `roundMayClose` reads each open terminal finding's `classInstances`; one that
 * carries none contributes nothing, so a pass that recorded findings without that field would let the round close having covered
 * nothing for them. The field is required by the brief — and a requirement is only real where something fails without it.
 */
describe('G — a finding that names no class cannot close the round', () => {
    it('refuses to close and names the classless findings', async () => {
        const { roundMayClose } = await import('../../src/quality/finding-lifecycle.js');
        const verdict = roundMayClose(
            [{ id: 'classless-one', severity: 'major' }],
            [{ classId: 'one-concept-several-derivations', covered: true, coveredBy: ['tests/unit/class-invariants.test.ts'] }],
        );
        // Without this the verdict would be mayClose: true — the class table has nothing to say about a finding that names no class.
        expect(verdict.mayClose).toBe(false);
        expect(verdict.reason).toContain('classless-one');
        expect(verdict.classless.map((entry) => entry.id)).toEqual(['classless-one']);
    });

    it('does not refuse for a non-terminal finding, because those are dispositions rather than repairs', async () => {
        const { roundMayClose } = await import('../../src/quality/finding-lifecycle.js');
        const verdict = roundMayClose([{ id: 'minor-one', severity: 'minor' }], []);
        expect(verdict.mayClose).toBe(true);
        expect(verdict.classless).toEqual([]);
    });
});

/**
 * **One derivation of "is this class covered?"** — `wcc4-f1`, found by the fourth round of a sibling change.
 *
 * The resolver listed every class id in the table while the two producers asked `coveredClasses()`, so an entry with
 * `coveredBy: []` counted as covered in the resolver and uncovered in the producers. The falsifier is a class that names no check:
 * it must not be reported as covered by the predicate the consumers read, and adding it to `CLASS_COVERAGE` must not make the
 * resolver treat it as covered.
 */
describe('a class with no covering check is not covered', () => {
    it('is reported uncovered by the one predicate every consumer reads', async () => {
        const { coveredClasses, CLASS_COVERAGE } = await import('../../src/quality/class-coverage.js');
        const derived = coveredClasses();
        expect(derived.length).toBe(CLASS_COVERAGE.length);
        // **Coverage is "a check catches a new instance", not "a class names a check"** (`cg8-f1`): an entry that records an uncovered
        // defining instance is reported uncovered however many checks it names, because the third route closes a finding on this flag
        // while promising that a new instance would fail in the declared check.
        for (const entry of derived) {
            const source = CLASS_COVERAGE.find((candidate) => candidate.classId === entry.classId);
            expect(entry.covered).toBe(entry.coveredBy.length > 0 && !source?.uncoveredInstances);
        }
        // At least one entry records an uncovered instance today — that is the case this asserts, not a count of it.
        expect(derived.some((entry) => !entry.covered)).toBe(true);
    });
});
