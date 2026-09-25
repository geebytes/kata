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
export interface CoverageEntry {
    /** The sentence all its instances are: the class, not an instance. */
    readonly classId: string;
    /** What the class is, in one line, so a reader can recognise a new instance rather than look it up. */
    readonly means: string;
    /** The declared check that reddens when the class returns. */
    readonly coveredBy: readonly string[];
}

export const CLASS_COVERAGE: readonly CoverageEntry[] = [
    {
        classId: 'one-concept-several-derivations',
        means: 'a concept is re-derived at each call site, so one site is updated and the others keep the old answer',
        coveredBy: ['tests/unit/class-invariants.test.ts'],
    },
    {
        classId: 'declaration-claiming-reality',
        means: 'a check reads a declaration (an owned-path set, a manifest, a task field) while its message claims to have read reality',
        coveredBy: ['tests/unit/class-invariants.test.ts'],
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
        coveredBy: ['tests/unit/class-invariants.test.ts'],
    },
    {
        classId: 'one-decision-several-entrances',
        means: 'one decision has two entrances and only one records it, so the decision happens and the trace does not',
        coveredBy: ['tests/unit/class-invariants.test.ts'],
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
        coveredBy: ['tests/unit/record-salvage.test.ts'],
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
    // finding names, and a consumer that wants one answer asks `classesOf()`.
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
export function coveredClasses(): Array<{ classId: string; covered: boolean; coveredBy: readonly string[] }> {
    return CLASS_COVERAGE.map((entry) => ({
        classId: entry.classId,
        covered: entry.coveredBy.length > 0,
        coveredBy: entry.coveredBy,
    }));
}
