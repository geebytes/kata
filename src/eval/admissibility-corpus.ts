/**
 * The admissibility corpus: the referee every later phase of this change is judged by.
 *
 * `docs/verfify.md` states the objective as
 *
 *     minimise(tokens, latency)  subject to  criticalRecall >= baseline, falsePassRate <= baseline
 *
 * and a benchmark that does not exist cannot referee anything. So this is Phase 0: the corpus is built **before** the
 * behaviour changes, and each later phase must show recall and false-pass no worse than the baseline recorded here.
 *
 * Three classes, because each answers a question the other two cannot:
 *
 *  - **planted-defect** — a real defect from this repository's own history. Recall is only measurable against defects
 *    somebody actually shipped; the entries below are the ones four independent passes found, each with the reproduction
 *    that found it.
 *  - **clean-revision** — a correct change. Without these, false-pass is measurable but false-*positive* is not, and a
 *    verifier that reports a defect on everything would score perfectly on planted defects alone.
 *  - **guard-false-negative** — a *guard* that refused an honest report. This class exists because a corpus that only
 *    plants defects cannot see a guard harming accurate reporting: the guard is "working" from the defect side and
 *    destructive from the honest side. Four rounds of independent review on `review-record-integrity` produced more of
 *    these than of any other class.
 *
 * Deliberately not in the corpus: anything about *cost*. Cost is an outcome of the corpus, never an entry — an entry
 * that asserts a token count would make the referee a target instead of a measurement.
 */

/** What a case is for. A case declares its classes so a score can be read per class, not only in aggregate. */
export type CorpusKind = 'planted-defect' | 'clean-revision' | 'guard-false-negative';

/** The verdict a correct verifier must reach. The four states are §2.3 of the design; two of them are refusable. */
export type ExpectedVerdict = 'no_defect_found' | 'defects_found' | 'inconclusive' | 'budget_exhausted';

export interface CorpusCase {
    id: string;
    kinds: CorpusKind[];
    /** Why this case is in the corpus, in one sentence — so a reader never has to guess what it proves. */
    why: string;
    /** Which acceptance criterion of *this* change the case exercises; the corpus must cover all of them. */
    criterion: string;
    /**
     * How to reconstruct the revision under review.
     *
     * A description rather than a snapshot: the defects are real, so the honest way to hold them is the reproduction
     * that found them (the command, the fixture, the revision pair). A snapshot would rot the moment the code moves;
     * a reproduction can be re-run and re-falsified.
     */
    reproduction: string;
    expectedVerdict: ExpectedVerdict;
    /**
     * The finding ids a correct verifier reports, or `[]` when the revision is clean.
     *
     * Severity is deliberately absent: recall is measured over *whether* a critical defect is reported, and adding
     * severity here would make the score depend on a judgement call the corpus is meant to referee.
     */
    expectedFindings: string[];
    /** Set when the case is a defect, so scoring can weigh critical ones separately from the rest. */
    critical?: boolean;
}

export interface CorpusObservation {
    caseId: string;
    verdict: ExpectedVerdict;
    findingIds: string[];
}

export interface CorpusScore {
    /** Planted defects that a correct verifier must report, and how many this one did. */
    criticalRecall: number;
    /**
     * Cases where the verifier said `no_defect_found` on a revision that carried a critical defect.
     *
     * This is the metric `docs/verfify.md` calls the one to hold above all others: a verifier that misses a defect is
     * worse than one that reads too much, because the miss is invisible.
     */
    falsePassRate: number;
    /** Cases where the verifier reported a defect on a clean revision. */
    falsePositiveRate: number;
    /** Cases where the verifier reached no conclusion at all; countable, and never silently folded into "pass". */
    inconclusiveRate: number;
    cases: number;
}

/**
 * The corpus.
 *
 * Every `planted-defect` entry is a defect that shipped in this repository and was found by an independent pass, with
 * its reproduction. Every `guard-false-negative` entry is a guard that refused an honest report, likewise.
 */
export function admissibilityCorpus(): CorpusCase[] {
    return [
        // ── planted-defect ────────────────────────────────────────────────────────────────────────────────────────
        {
            id: 'seal-refusal-mutates-the-task-it-refuses',
            kinds: ['planted-defect'],
            why: 'A refusing command wrote the state it refused, so the refusal was not atomic.',
            criterion: 'AC-2',
            reproduction: 'kata-cli build --seal --owned-path ../outside.ts on a task with existing ownedPaths; '
                + 'task.json used to gain the escaped path even though the seal returned success:false.',
            expectedVerdict: 'defects_found',
            expectedFindings: ['seal-persists-refused-owned-paths'],
            critical: true,
        },
        {
            id: 'change-record-empties-when-the-round-commits',
            kinds: ['planted-defect'],
            why: 'Deriving the change surface from `git status` made the record report "nothing changed" for a round '
                + 'that committed before sealing — empty is self-consistent with a clean tree, so it failed silently.',
            criterion: 'AC-2',
            reproduction: 'Commit the round, then `build --seal`; the record bound to that revision reported '
                + 'changedPaths [] while the revision held nine changed paths in its own pathDigests.',
            expectedVerdict: 'defects_found',
            expectedFindings: ['sealed-change-record-reports-zero-changed-paths'],
            critical: true,
        },
        {
            id: 'change-surface-anchored-on-the-declaration',
            kinds: ['planted-defect'],
            why: 'A change committed outside the declared owned set escaped both sources, because the digest table is '
                + 'computed over ownedPaths and the tree is clean once committed.',
            criterion: 'AC-2',
            reproduction: 'One commit touching .gitignore, docs/guide.md and src/a.ts, then seal with only src/a.ts '
                + 'owned; the record reported src/a.ts and changedOutsideOwnership [].',
            expectedVerdict: 'defects_found',
            expectedFindings: ['change-record-omits-committed-unowned-paths'],
            critical: true,
        },
        {
            id: 'recorded-scope-disagrees-with-the-issued-brief',
            kinds: ['planted-defect'],
            why: 'Re-deriving the scope at record time let the record contradict the brief Kata had just issued, and '
                + 'the gate then refused the pass against its own brief.',
            criterion: 'AC-3',
            reproduction: 'Issue a delta brief, record with that exact briefSha256, read the stored scope: it held '
                + 'changedPaths [] where the brief declared a path, and the gate answered `delta_stale`.',
            expectedVerdict: 'defects_found',
            expectedFindings: ['recorded-delta-scope-empties-when-the-brief-used-a-default-base'],
            critical: true,
        },
        {
            id: 'auto-selected-delta-round-records-as-full',
            kinds: ['planted-defect'],
            why: 'A batch-derived delta round recorded as `full`, so the coverage check never ran on exactly the rounds '
                + 'the delta machinery selects by itself.',
            criterion: 'AC-3',
            reproduction: 'Close a repair batch, take the default brief, record a pass, read its scope: `{kind: full}` '
                + 'while the issued copy carried the delta block.',
            expectedVerdict: 'defects_found',
            expectedFindings: ['batch-derived-delta-brief-records-as-full-so-the-gate-never-checks-its-coverage'],
            critical: true,
        },
        {
            id: 'inconclusive-verdict-passes-the-node',
            kinds: ['planted-defect'],
            why: 'The gate never read `verdict`, so a reviewer stating "I did not reach a conclusion" satisfied a strict '
                + 'node — the judgment foundation had no representation for "not concluded".',
            criterion: 'AC-1',
            reproduction: 'Record a pass with verdict `inconclusive`, an empty findings list and one attempt; the gate '
                + 'answered satisfied:true.',
            expectedVerdict: 'defects_found',
            expectedFindings: ['inconclusive-verdict-is-not-a-conclusion'],
            critical: true,
        },
        {
            id: 'scope-apply-writes-a-schema-invalid-task',
            kinds: ['planted-defect'],
            why: 'A write path trusted its input while every read path validated it, and the resulting task could not be '
                + 'repaired from the CLI at all.',
            criterion: 'AC-2',
            reproduction: 'Remove the last owned path through recorded scope changes and apply; every task-reading '
                + 'command failed with a schema error, including the one that would have added a path back.',
            expectedVerdict: 'defects_found',
            expectedFindings: ['scope-apply-can-write-a-schema-invalid-task'],
            critical: true,
        },

        // ── clean-revision ────────────────────────────────────────────────────────────────────────────────────────
        {
            id: 'clean-revision-reports-nothing',
            kinds: ['clean-revision'],
            why: 'Without a clean case, false-positive rate is unmeasurable and a verifier that reports a defect on '
                + 'everything scores perfectly on planted defects alone.',
            criterion: 'AC-1',
            reproduction: 'A revision whose sealed checks all pass, whose claims hold, and whose surface is fully '
                + 'covered by the verified criteria.',
            expectedVerdict: 'no_defect_found',
            expectedFindings: [],
        },
        {
            id: 'clean-revision-with-a-deferred-minor',
            kinds: ['clean-revision'],
            why: 'A decided finding is not an open defect: reporting it again is a false positive even though it is a '
                + 'real observation.',
            criterion: 'AC-6',
            reproduction: 'A revision carrying one `minor` finding already dispositioned `deferred`, with everything '
                + 'else passing.',
            expectedVerdict: 'no_defect_found',
            expectedFindings: [],
        },

        // ── guard-false-negative ──────────────────────────────────────────────────────────────────────────────────
        {
            id: 'guard-refuses-a-declared-test-citation',
            kinds: ['guard-false-negative'],
            why: 'The anti-counterexample guard refused a test the task declares, hashes and the brief names — punishing '
                + 'an accurate citation and rewarding vague prose.',
            criterion: 'AC-4',
            reproduction: 'A/B the same verdict through the CLI: describing the test in prose passed the gate; the '
                + 'literal path string was refused with `undeclared_test_path`.',
            expectedVerdict: 'no_defect_found',
            expectedFindings: [],
        },
        {
            id: 'guard-refuses-a-refuted-with-no-observation',
            kinds: ['guard-false-negative'],
            why: 'A guard that requires a readable observation must accept every honest way of discharging a hypothesis, '
                + 'or it pushes reviewers toward vagueness to get past the gate.',
            criterion: 'AC-6',
            reproduction: 'Record a hypothesis discharged by a source citation at the sealed revision; it must be '
                + 'admissible, and only a citation that does not resolve must be refused.',
            expectedVerdict: 'no_defect_found',
            expectedFindings: [],
        },
        {
            id: 'guard-penalises-an-honest-inconclusive',
            kinds: ['guard-false-negative'],
            why: 'If reporting `inconclusive` is never as good as reporting nothing, the corpus itself teaches reviewers '
                + 'to under-report — which is the class this change exists to end.',
            criterion: 'AC-1',
            reproduction: 'Record a pass that states `inconclusive` with the uncovered criteria named; it must be '
                + 'refused as incomplete rather than accepted, and the refusal must name what was not covered.',
            expectedVerdict: 'no_defect_found',
            expectedFindings: [],
        },

        // ── budget and limits ─────────────────────────────────────────────────────────────────────────────────────
        {
            id: 'budget-exhaustion-is-reported-not-silent',
            kinds: ['planted-defect'],
            why: 'A truncated pass used to terminate as "satisfied with zero findings"; a limit hit must be a reported, '
                + 'refusable state instead of a silent pass.',
            criterion: 'AC-1',
            reproduction: 'A pass whose executor hits the tool or wall limit with hypotheses still open; the verdict '
                + 'must be `budget_exhausted` and the unexamined set named.',
            expectedVerdict: 'budget_exhausted',
            expectedFindings: ['budget-exhausted-with-open-hypotheses'],
            critical: true,
        },
    ];
}

/**
 * Score a verifier's observations against the corpus.
 *
 * The three rates are kept separate on purpose. Folding `inconclusive` into either pass or fail would hide the one
 * state this change exists to make visible, and folding false-positive into false-pass would let a verifier trade one
 * for the other.
 */
export function scoreCorpus(corpus: CorpusCase[], observations: CorpusObservation[]): CorpusScore {
    const byId = new Map(observations.map((observation) => [observation.caseId, observation]));
    const criticalCases = corpus.filter((entry) => entry.critical === true);
    const cleanCases = corpus.filter((entry) => entry.kinds.includes('clean-revision'));
    const reported = (observation: CorpusObservation | undefined, expected: string[]): boolean =>
        Boolean(observation) && expected.every((id) => observation!.findingIds.includes(id));

    const caught = criticalCases.filter((entry) => reported(byId.get(entry.id), entry.expectedFindings)).length;
    // A false pass is a *critical* defect answered with "nothing wrong" — strictly narrower than "not caught", because
    // an honest `inconclusive` is not a false pass: it declines to certify.
    const falsePasses = criticalCases.filter((entry) => byId.get(entry.id)?.verdict === 'no_defect_found').length;
    const falsePositives = cleanCases.filter((entry) => byId.get(entry.id)?.verdict === 'defects_found').length;
    const inconclusive = observations.filter((observation) => observation.verdict === 'inconclusive').length;

    return {
        criticalRecall: criticalCases.length === 0 ? 1 : caught / criticalCases.length,
        falsePassRate: criticalCases.length === 0 ? 0 : falsePasses / criticalCases.length,
        falsePositiveRate: cleanCases.length === 0 ? 0 : falsePositives / cleanCases.length,
        inconclusiveRate: observations.length === 0 ? 0 : inconclusive / observations.length,
        cases: corpus.length,
    };
}
