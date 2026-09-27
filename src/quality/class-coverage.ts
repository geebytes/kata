/**
 * The classes this change's findings belong to, and the check that covers each.
 *
 * **Why a table rather than 17 dispositions.** Every round on this line produced findings about the previous round's repairs
 * (7, 6, 5, 5, 7), and the instances fell into four sentences:

 * | class | instances across the line |
 * |---|---|
 * | one concept derived in several places, one updated | `wcc2-f1`, `kgs3-f3`, `rba5-f1/f2/f3`, `cg-f1`, `rba7-f1/f2/f4` |
 * | a check reads a declaration while its message claims reality | `cg4-f2`, `rba5-f1/f2/f3`, the seal refusal, `rba7-f1/f4` |
 * | a check that cannot fail | eight decorative checks, caught by mutation rather than by reading |
 * | one decision, several entrances, one leaves no trace | five, the last being `matrix set --owned-paths` |
 * | **a required output with one unguaranteed channel** | **three of six dispatched rounds produced no record** |
 *
 * Disposing of seventeen findings one at a time reproduces the class — that is the measured history, seven rounds of it. Naming the
 * classes and covering each with a check that reddens when it returns is what makes the loop end, and it is also what
 * `roundMayClose` asks before a round may close.
 *
 * **The set is not closed at four, and the fifth was found by a round whose record was lost** — see
 * `docs/design/2026-09-24-the-fifth-class.md`. Four of the five are about how a mechanism is built; the fifth is about how a process
 * is scheduled, which is why reading code did not find it and three failed rounds did.
 *
 * Each entry names the check, so the claim is auditable rather than asserted. `tests/unit/class-invariants.test.ts` holds all four,
 * and each was verified to redden under a mutation that reintroduces its class.
 */
import type { ClassCoverage } from './finding-lifecycle.js';

export interface CoverageEntry {
    /** The sentence all its instances are: the class, not an instance. */
    readonly classId: string;
    /** What the class is, in one line, so a reader can recognise a new instance rather than look it up. */
    readonly means: string;
    /** The declared check that reddens when the class returns. */
    readonly coveredBy: readonly string[];
    /**
     * The names a round has given this class.
     *
     * **Why the table carries them rather than the matcher guessing.** A reviewer names the class and then says which instance it is —
     * "a definition with no consumer — the same class as a store-of-record whose figures nothing reads" — and the first pass on the round
     * protocol produced eleven findings with eleven different sentences for the six classes in this table. Guessing by word overlap would
     * decide membership by accident; recording the sentence here decides it by decision, and a reader can audit which sentence was ruled an
     * instance of which class. Every entry below was added by an author reading the sentence and choosing its class.
     */
    readonly alsoKnownAs?: readonly string[];
    /**
     * The instances of this class the named check does **not** catch, when it catches only some of them.
     *
     * It exists because `covered` was `coveredBy.length > 0` — *the class names a check*, not *a check that catches a new instance*
     * — and AC-1's third route closes a finding on that flag while promising "a new instance of that class fails in the declared
     * covering check rather than in a future round". For an entry whose own prose already recorded an uncovered defining instance,
     * that promise was false (`cg8-f1`). So a class with uncovered instances is not coverage for the route's purpose.
     */
    readonly uncoveredInstances?: string;
}

export const CLASS_COVERAGE: readonly CoverageEntry[] = [
    {
        classId: 'one-concept-several-derivations',
        means: 'a concept is re-derived at each call site, so one site is updated and the others keep the old answer',
        // **The second entry `cg8-f1` named and its repair left** (`cg9-f1`): the check greps for one predicate's identifiers, so a
        // re-derivation of the same concept under other names is green — and that re-derivation is this class's own `means`.
        coveredBy: ['tests/unit/class-invariants.test.ts'],
        alsoKnownAs: [
            'one vocabulary written twice',
            'a hand-written enumeration guarding against unstated conditions',
            'a hand-written guard duplicating a bundled schema with a single field pinned by a test',
            'the `minimum`/`enum`/`additionalProperties` rules that Ajv enforces and the guard never consults',
            'a rule kept in two places with one copy checked',
            'an invariant whose enumeration cannot see a sibling channel',
        ],
    },
    {
        classId: 'declaration-claiming-reality',
        means: 'a check reads a declaration (an owned-path set, a manifest, a task field) while its message claims to have read reality',
        coveredBy: ['tests/unit/class-invariants.test.ts'],
        alsoKnownAs: [
            'a store-of-record written from caller-supplied identity',
            'the doc-versus-code class',
            'a status derived from the caller rather than from the artefact',
            '`fresh_context` remains the self-report the contract was written to replace',
        ],

        // **And the citation guard was its live instance, and was the one that got away from it** (`docs/design/2026-09-25-the-citation-guard-cannot-be-answered.md`):
        // it inferred whether a pass wrote a test from the state of the world — file existence, content, mtime, revision digest — and every
        // one of those moves for reasons unrelated to the pass, so four successive predicates each refused honest records in a different
        // direction. **The replacement is a check of a different kind**: the record declares the tests it read and wrote and the guard
        // refuses only a citation no declaration names, which is decidable and consults no world state. It is the one instance of this
        // class on this line that was removed rather than repaired, and it took four failed repairs to see that the class was not the
        // guard's shape but *what it was reading*.
    },
    {
        classId: 'a-check-that-cannot-fail',
        // **The means matches what the covering check can see** (`wcc5-f3`). This read 'an assertion is green whichever
        // implementation runs … **including** checking a value the defect also produces', and the check covers only the first half: it
        // finds constant assertions (`expect(true).toBe(true)`). The second half — an assertion that checks a value the defect also
        // produces — is the class's defining instance and nothing detects it, so listing it here claimed coverage the check does not
        // have. It is recorded as the uncovered form rather than deleted, because it is the form that matters most.
        means: 'an assertion is green whichever implementation runs, so it demonstrates nothing — a constant assertion, which the '
            + 'covering check finds. **Its defining instance is not covered: an assertion that checks a value the defect also '
            + 'produces.** No check detects that today, so a repair may satisfy this class with a weaker property and the round would '
            + 'close on it.',
        uncoveredInstances: 'an assertion that checks a value the defect also produces',
        coveredBy: ['tests/unit/class-invariants.test.ts'],
        alsoKnownAs: [
            "an enumeration of one platform's tool names used as a general predicate",
            'a refutation predicate gated on a capability the node does not require',
            'a guard whose exit status is 0 refuses nothing',
            'a refusal reported in a result object that no caller is obliged to read',
        ],
    },
    {
        classId: 'one-decision-several-entrances',
        means: 'one decision has two entrances and only one records it, so the decision happens and the trace does not',
        coveredBy: ['tests/unit/class-invariants.test.ts'],
    },
    {
        classId: 'a-part-checked-as-the-whole',
        // **The seventh, and the one this round's own sentences named without a table entry.** Five of the eleven findings are one shape: a
        // guard inspects one member of a concept and is read as having inspected the concept. `identity checked, content not` (the register
        // compared a receipt's id and not its figures), `a criterion wider than its check` (a criterion promising a rule the selector never
        // asserts), `an absence assertion that names one field` (a guard behind a concept), `one binding checked` (the packet's brief hash,
        // while the budget and the capability set beside it were trusted), and the bundled-schema guards walking registered-to-file but never
        // file-to-registered. The covering check asks the whole: B requires a refusal not to claim what the code did not read, and G1 walks
        // every schema file in both directions.
        means: 'a guard inspects one field, member or direction of a concept and is read as a verdict on the concept',
        // **G3 is the clause that asks this entry's live instance** (`rpr7-f2`): the second pass found the class covered on paper while
        // `adversarial execute` registered every run without the receipt the admission rule compares — `identity checked, content not`, in the
        // change whose fix for it was inert. G3 asserts both halves in the source, so the instance reddens the check rather than the round.
        // The second citation was `tests/unit/execute-streams-the-round.test.ts`, deleted with the round-shaped route it
        // tested. The class is covered by the invariants file, which is where its instances are enumerated — and a check
        // that names a file nobody can open is the "criterion wider than its check" class this entry describes.
        coveredBy: ['tests/unit/class-invariants.test.ts'],
        alsoKnownAs: [
            'an absence assertion that names one field of a concept',
            'a criterion wider than its check',
            'identity checked, content not',
            'one binding checked',
            'the bundled-schema invariant asserted only as',
        ],

    },
    {
        classId: 'a-definition-with-no-consumer',
        // **The sixth, and the first this line did not already have.** The first independent pass on the round protocol reported eleven
        // findings; five of them are this one sentence. The protocol's schema was bundled by nothing and registered with nothing, so the
        // "bundled schema" a criterion promised did not ship. `elapsedMs` was computed, passed into the runner and read nowhere, so the
        // wall clock stayed the host's word while the branch claimed kata measured it. `receipt_unwatched` was a refusal outside the union
        // the brief renders from, so no brief could state the condition a pass was refused by. And in every one of those cases the guard
        // beside the declaration passed, because it asked whether the declaration was **well formed** rather than whether anything read it.
        means: 'a declaration is written and nothing reads it — a schema nothing bundles or registers, a field nothing consults, a refusal '
            + 'outside the vocabulary that renders it — so the mechanism exists on paper while the behaviour it promises does not',
        coveredBy: ['tests/unit/class-invariants.test.ts'],
        alsoKnownAs: [
            'a definition with no consumer',
            'a declared rule with a dead parameter',
            'a store-of-record whose figures nothing reads',
            'a refusal reason outside the vocabulary the brief renders from',
            'a count in prose that nothing derives',
        ],
    },
    {
        classId: 'output-with-one-unguaranteed-channel',
        // **The fifth, and the one that answered "is the set closed" with a no.** It is not any of the four: not one concept
        // derived twice, not a declaration read as reality, not a check that cannot fail, not a decision with two entrances. It is
        // a **required output whose only channel is the process reaching its natural end** — and it is measured: three of six
        // dispatched review rounds produced no record, each ending with the same sentence ("I already know the answer; let me
        // confirm it"), and one of them had found a route the design never enumerated, which survived only because a human read
        // four megabytes of transcript.
        means: 'a required output has exactly one channel and that channel is not guaranteed, so a process that ends early produces nothing',
        // The cited fixture was `tests/unit/record-salvage.test.ts`, deleted with `record-salvage.ts` — the module existed to
        // recover a record a pass never emitted, which the ledger's incremental writes make structurally unnecessary. The
        // class is still covered, by the case that asserts the replacement: nothing is recovered because nothing is lost.
        coveredBy: ['tests/unit/ledger-records-each-fact-as-it-arrives.test.ts'],
    },
];

/**
 * Which class each finding is an instance of, read from **both** stores a finding can live in.
 *
 * A finding is recorded into `review.json` by the review flow and into the adversarial record by a pass, so a lookup that reads one
 * store answers for half of them — measured: this change's seven unanswered obligations all carried review-recorded ids while
 * `readTrackedFindings` reads the adversarial store, so every one of them looked classless and the class table could not answer any.
 * Reading both is not a workaround; it is the second store's existence being acknowledged in the one place that has to consult it.
 */
export async function classesOfFindings(root: string, taskId: string): Promise<Record<string, string[]>> {
    const { readTrackedFindings } = await import('./finding-disposition.js');
    const { readFile } = await import('node:fs/promises');
    const { reviewPath } = await import('../core/layout.js');
    // **One derivation of "the class a finding is an instance of"** (`kgsr7-f4`): this kept only the first, while `roundMayClose`
    // reads every id in `classInstances`. So a finding whose second class had no covering check kept its round open while the
    // closure rule — reading the first — saw it as covered, or the reverse. The two consumers now read the same fact: the set the
    // finding names, and **every consumer now asks whether any of them is covered** — there is no `classesOf()` helper and the comment that named one was wrong (`kgsr8-f4`).
    const classOf: Record<string, string[]> = {};
    // See `repair-briefing.ts`: a swallow here would answer "no classes" for a schema-invalid record (`rba12-f4`).
    for (const tracked of await readTrackedFindings(root, taskId)) {
        if (tracked.classInstances?.length) classOf[tracked.id] = [...tracked.classInstances];
    }
    const reviewFile = reviewPath(root, taskId);
    const review = await readFile(reviewFile, 'utf8').then((raw) => JSON.parse(raw) as { findings?: Array<{ id?: string; classInstances?: string[] }> }).catch(() => null);
    for (const finding of review?.findings ?? []) {
        if (finding.id && finding.classInstances?.length) classOf[finding.id] = [...finding.classInstances];
    }
    return classOf;
}

/**
 * The coverage the class table actually implies — **derived, not supplied by the caller**.
 *
 * `ClassCoverage.covered` was a field on the predicate's input type and `CoverageEntry` has no such field, so both production call
 * sites wrote the literal `true` for every entry (`rba8-f2`): the uncovered branch of `classesNeedingCoverage` was unreachable from
 * production, and the round-closure verdict was a constant. That is the class table's second entry in its own machinery — a
 * predicate reading a declaration (`covered`) while claiming to have read whether a check exists.
 *
 * A class is covered when it names a check; that is what this returns, so no caller can invent the answer.
 */
export function coveredClasses(): ClassCoverage[] {
    return CLASS_COVERAGE.map((entry) => ({
        classId: entry.classId,
        // **Coverage is "a check catches a new instance", not "a class names a check"** (`cg8-f1`). An entry that records an uncovered
        // defining instance does not answer the third route's promise, so it is reported uncovered however many checks it names.
        // **`covered` is a hand-typed marker, and that is stated rather than dressed up** (`cg10-f1`): a check cannot be asked whether
        // it would catch an instance it has never seen, so this flag reads a marker a human set, and the marker is honest only because the
        // check it names was measured. What makes it evidence rather than declaration is that the check can redden: check B reads the
        // source *including comments* and flagged the one entry whose covering check was vacuous — which is how `declaration-claiming-reality`
        // was found to be covered by a loop that never ran. So the entry stays `covered`, and the sentence that says a new instance would
        // fail there is a claim about a measured check, not about the word in this table.
        covered: entry.coveredBy.length > 0 && !entry.uncoveredInstances,
        coveredBy: entry.coveredBy,
        // **Every declared field survives this mapping.** Adding `alsoKnownAs` to the table while this projection stayed field-by-field is
        // the fourth time on this line that a transfer dropped a declared field — `impact`, `attemptsWithheld`, `reproduction`, and now a
        // class's synonyms — and the first three each cost a round. The type above is the guard: it is `ClassCoverage`, so a field this
        // mapping forgets is a compile error rather than a silent absence. The `coveredClasses` case in `class-invariants` asserts the same
        // thing at runtime, because a type can be widened back.
        ...(entry.alsoKnownAs ? { alsoKnownAs: entry.alsoKnownAs } : {}),
    }));
}
