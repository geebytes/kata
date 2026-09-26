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

        // **And the same question under other names**, which is this entry's recorded `uncoveredInstances` and the reason a round could not
        // close on it: matching one identifier misses a re-derivation that spells the concept differently. So the check asks the behaviour —
        // *who compares a finding id against a ledger entry* — and requires that only the module that owns the ledger does it. A file that
        // reads a reddening or an absence to decide something must ask the predicate; comparing the id itself is the derivation.
        const derivers = sources
            .filter((file) => file !== definition)
            // The receiver's name is not the question — naming the receiver was the first version of this clause, and a file comparing
            // `entry.findingId` slipped through it. *Any* comparison against a finding id outside the predicate's owner is the derivation.
            .filter((file) => /\.findingId\s*===|===\s*\w+\.findingId\b/.test(read(file)))
            .filter((file) => !read(file).includes('hasFalsifierDisposition') && !read(file).includes('hasReddening'));
        expect(derivers, `files comparing a finding id to a ledger entry without asking the predicate: ${derivers.join(', ')}`).toEqual([]);
    });

    /**
     * **B: a check reads a declaration and its message claims reality.**
     *
     * Six instances, the last of which was inside the fix for the fifth: `revisionStatus` compares two *declarations* while a
     * refusal prints *"the sealed revision still matches the workspace"*. The check is that no refusal message names the workspace
     * unless the code that produces it hashed content.
     */
    it('B — no refusal claims the workspace unless the code read content', () => {
        // **Comments are kept, and the reason is this check's own history** (`cg10-f1`): an earlier version stripped comments so a
        // file that legitimately *quotes* the withdrawn sentence would not be flagged — and the sentence this class is about **is a
        // comment**, because that is where a sentence about what a check did lives. So stripping comments removed the claim and left
        // the check passing vacuously: `claims` was empty, the loop never ran, and the check that exists to catch *a declaration read
        // as reality* was itself a declaration read as reality — the third instance of its own class, and the second inside its own
        // repair.
        //
        // A quote and a claim are told apart by the second conjunct instead: a file that **states** the workspace matches while reading no
        // content is the instance, and a file that names the sentence as *withdrawn* is not claiming it — a decidable difference in the
        // text, unlike "is this comment quoted or live".
        const claims = sources.filter((file) => /matches the workspace|the workspace\b[^.]{0,40}(unchanged|matches)/i.test(read(file)));
        const offenders: string[] = [];
        for (const file of claims) {
            const source = read(file);
            const namesWorkspace = /still matches the workspace/i.test(source);
            const readsContent = /computeContentDigests|contentDigests|computeManifestHash|pathDigests/.test(source);
            // **An exemption is a named list, not a vocabulary** (`cg10-f1`): my first version guessed whether a mention was a *quote* from
            // words like "withdrawn" or "used to" — and `repair-entry.ts`, the very instance this check exists for, contains them, so the
            // exemption swallowed the finding. A text check cannot tell a quoted claim from a live one, so the files allowed to mention the
            // sentence without reading content are enumerated by path, and a new one is a decision rather than a guess.
            const EXEMPT = [
                // Explains what it stopped printing, and prints the two states instead. Its message composes the refusal from
                // `revisionStatus`, which hashes content — the claim lives in this comment, not in a live string.
                'src/workflow/repair-entry.ts',
            ];
            if (namesWorkspace && !readsContent && !EXEMPT.some((allowed) => file.endsWith(allowed))) offenders.push(file);
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
describe('G — a definition with no consumer', () => {
    /**
     * **The class the first independent pass on the round protocol found, and the first one this line did not already have.**
     *
     * Five of that pass's eleven findings were one sentence: *a declaration is written and nothing reads it.* The protocol's schema was
     * bundled by nothing and registered with nothing, so the "bundled schema" a criterion promised did not ship; `elapsedMs` was computed,
     * passed into the runner and never read, so the wall clock stayed the host's word; `receipt_unwatched` was a refusal outside the union
     * the brief renders from, so no brief could state it. In each case the mechanism existed on paper while the behaviour it promised did
     * not — and in each case the guard beside it passed, because the guard asked whether the declaration was well formed.
     *
     * The two clauses below are the class's two halves: **a definition that does not ship**, and **a field nothing consults**.
     */
    it('G1 — every schema in the repository ships and is registered, asked file by file', () => {
        // The direction no guard walked: `every-bundled-schema-has-an-id` asserts registered-name → file and file → `$id`, so a schema
        // that is in neither list passes both. This walks the directory and requires each file to be imported as an asset **and** named in
        // the registration table — the two halves that make it a definition something can read.
        const dir = join(ROOT, 'schemas');
        const registry = read(join(ROOT, 'src/core/schema.ts'));
        const unshipped: string[] = [];
        for (const file of readdirSync(dir).filter((name) => name.endsWith('.schema.json'))) {
            if (!registry.includes(`kata-asset:schemas/${file}`)) unshipped.push(`${file}: not imported as an asset, so it does not ship`);
        }
        expect(unshipped, 'a schema nothing bundles is a definition no consumer can reach').toEqual([]);

        // And it is reachable by name, which is what `validate('<name>')` looks up. The check follows the binding rather than a spelling:
        // each import binds a variable to a file, and each registry entry binds a lookup name to that variable. Comparing `$id` to the
        // registry key instead — the first version of this clause — reported 21 schemas because the two are different vocabularies
        // (URLs, `kata/x.schema.json`, bare names), which is a check measuring the wrong pair rather than a repository defect.
        const unregistered: string[] = [];
        for (const file of readdirSync(dir).filter((name) => name.endsWith('.schema.json'))) {
            const bound = registry.match(new RegExp(`import\\s+(\\w+)\\s+from\\s+'kata-asset:schemas/${file.replace('.', '\\.')}'`));
            if (!bound) {
                unregistered.push(`${file}: no import binds a variable to it`);
                continue;
            }
            const variable = bound[1]!;
            // Both spellings the table uses: `'name': schema` and `name: schema`. Requiring the quoted form — the second version of this
            // clause — reported five registered schemas as unregistered, which is a check that measures the punctuation rather than the fact.
            if (!new RegExp(`(?:['"][^'"]+['"]|\\w+)\\s*:\\s*${variable}\\b`).test(registry)) {
                unregistered.push(`${file}: imported as \`${variable}\` but no registration entry names it, so \`validate\` cannot reach it`);
            }
        }
        expect(unregistered, 'a schema no entry registers is a definition `validate` cannot reach').toEqual([]);
    });

    it("G3 — the register's content comparison is wired in production, not only in fixtures", () => {
        // **`a-part-checked-as-the-whole`'s live instance, and why the entry could not simply claim coverage** (`rpr7-f2`): the comparison
        // existed in `runIsCertified` and the CLI never passed the artefact it compares, so every production run registered an identity and
        // the content check was unreachable. Two source questions, both of which that defect answers wrongly: the admission function reads the
        // artefact, and the call that registers a run passes one.
        const registry = read(join(ROOT, 'src/quality/round-registry.ts'));
        expect(registry, 'the admission rule does not read the recorded receipt, so it cannot compare content')
            .toMatch(/run\.receipt\s*&&\s*!sameReceipt/);
        const ops = read(join(ROOT, 'src/cli/ops.ts'));
        expect(ops, 'the CLI registers a run without the receipt it wrote, so the comparison above is dead code')
            .toMatch(/recordRoundRun\(root, change, \{[\s\S]{0,1200}?receipt: outcome\.receipt/);
    });

    it('G2 — every field the round runner declares is read by the round runner', () => {
        // `elapsedMs` was the instance: declared on the input, computed by the caller, passed in, and consulted nowhere — so the timeout
        // branch asked the child's exit code instead and AC-3's "derived from the stream, not from the host" was false for that branch.
        // A declared field nothing reads is the same sentence one level down, and it is mechanically findable.
        const runner = read(join(ROOT, 'src/quality/round-runner.ts'));
        const declaration = runner.slice(runner.indexOf('export interface RoundRunnerInput'), runner.indexOf('export interface RoundExecuted'));
        const body = runner.slice(runner.indexOf('export function decideRound'));
        const fields = [...declaration.matchAll(/^\s{4}(\w+)\??:/gm)].map((match) => match[1]!);
        expect(fields.length, 'the interface is read, not silently empty').toBeGreaterThan(3);
        const unread = fields.filter((field) => !new RegExp(`\\b${field}\\b`).test(body));
        expect(unread, 'a field the runner declares and never reads is a knob nothing turns').toEqual([]);
    });
});

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
        // **And the finding naming an uncovered class is not closable** (`cg8-f1`, `cg9-f1`): one entry records an uncovered defining
        // instance — `a-check-that-cannot-fail`, whose covering check finds constant assertions while its defining instance is *an assertion
        // that checks a value the defect also produces*, which no reading of the source can find. For the third route's purpose — "a new
        // instance of that class fails in the declared covering check" — that class is not coverage, so a finding naming it keeps the round
        // open. That is the honest answer rather than the convenient one.
        //
        // It was two entries until check A gained the clause its own `uncoveredInstances` named: the same question under other identifiers,
        // which a re-derivation named `entry.findingId === id` now reddens. A class stops being partially covered when the check it names
        // starts asking the behaviour rather than one spelling of it.
        expect(verdict.mayClose).toBe(false);
        expect(verdict.open.map((entry) => entry.classId)).toEqual(['a-check-that-cannot-fail']);
        // And the findings that do not name it close, so the rule is about that class and not about the list.
        const withoutThem = open.filter((finding) => !finding.classInstances.includes('a-check-that-cannot-fail'));
        expect(roundMayClose(withoutThem, coveredClasses()).mayClose).toBe(true);
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
        //
        // **This asserts the consequence of that rule, not the expression that implements it** (`rba-r17-f3`, found by an independent
        // pass): the case used to assert `entry.covered === (entry.coveredBy.length > 0 && !source?.uncoveredInstances)` — character for
        // character what `coveredClasses()` computes over the same two fields — so a mutation that changed both in step stayed green, and
        // the case pinned that the implementation equals itself. What each branch below reads is the table's own content, so dropping the
        // `uncoveredInstances` conjunct reddens on the entry whose instance it drops.
        for (const entry of derived) {
            const source = CLASS_COVERAGE.find((candidate) => candidate.classId === entry.classId);
            const namesACheck = entry.coveredBy.length > 0;
            const recordsAnUncoveredInstance = (source?.uncoveredInstances?.length ?? 0) > 0;
            if (!namesACheck) {
                expect(entry.covered, `${entry.classId} names no check, so nothing can catch a new instance`).toBe(false);
            } else if (recordsAnUncoveredInstance) {
                expect(entry.covered, `${entry.classId} names a check and records an uncovered instance, so it is reported uncovered`).toBe(false);
            } else {
                expect(entry.covered, `${entry.classId} names a check and records no uncovered instance, so it is reported covered`).toBe(true);
            }
        }
        // At least one entry records an uncovered instance today — that is the case this asserts, not a count of it.
        expect(derived.some((entry) => !entry.covered)).toBe(true);
    });
});
