/**
 * **The machinery that decides whether a change is certified — declared, so a change that edits it cannot certify itself.**
 *
 * The hazard this exists for: a corrective action C may itself modify the modules that judge C. Every gate would then be
 * reading a rule the candidate wrote, and C's own PASS would be the only evidence that the rule is sound — the shape this
 * repository refuses at every other layer ("the reviewed party must not certify itself"). The design's clause is exact:
 * *"C 若修改了 Kata 的认证器或 reviewer 入口，须以独立于候选的执行/审查来源核验候选实际构建产物及其 revision；尚无可信评价器或
 * 受认可的启动链时，C 的批准资格是 `undetermined`"*. No trustworthy evaluator or accepted launch chain exists today, so the
 * qualification is `undetermined` and the operator's real roads are named by the refusal.
 *
 * **Why a list and not the task's own `instruments[]`.** The repository already has that vocabulary
 * (`src/quality/code-surface.ts`), and it is the wrong source here for a measured reason: `instruments[]` is *declared by
 * the task*, and **no task in this repository declares it** (0 of 30+), so a rule built on it would be vacuously false for
 * every change — a gate that does not gate. It is also self-reported, and the change that edits the certifier is exactly the
 * change with an incentive not to report it.
 *
 * **Why a list and not a derived import closure.** Deriving "what the certification path reads" is the drift-proof answer
 * (`src/quality/import-graph.ts` exists for that kind of question), and it is the upgrade path once the root set can itself
 * be derived. Until then a derived closure needs a hand-written root set anyway, so the root set is written down here where
 * it can be read, reviewed and tested — rather than inferred at a call site where nobody sees it.
 *
 * **The list is itself under test** (`tests/unit/a-certifier-cannot-certify-itself.test.ts`): every entry must name a path
 * that exists, every entry must say why it is on the list, and a change that owns an entry must come out `undetermined`.
 * A list nobody checks is the drift this file would otherwise become.
 *
 * The same list, with the same reasons, is written out in
 * `docs/architecture-reviews/kata-review-loop-project-assessment.md` §24, so a reviewer reading the design can see what the
 * gate covers without reading this file — and a disagreement between the two is a defect in whichever one moved.
 */
export interface CertificationMachineryEntry {
    /**
     * A file, or a directory when it ends in `/` (then every path under it is on the surface).
     *
     * Directories are used where the whole subtree decides one question — `src/kernel/` is the evidence kernel — and files
     * where a single module is the decision.
     */
    path: string;
    /** One line, specific enough that a reader can tell whether the entry still belongs. */
    why: string;
}

export const CERTIFICATION_MACHINERY: readonly CertificationMachineryEntry[] = [
    {
        path: 'src/quality/review-ladder.ts',
        why: 'decides which findings block approval, and whether a repair chain is terminal',
    },
    {
        path: 'src/workflow/distill-gates.ts',
        why: 'decides whether an approved review and a judge pass clear the change',
    },
    {
        path: 'src/quality/obligation-check.ts',
        why: 'decides whether a closure contract a round wrote is satisfied',
    },
    {
        path: 'src/quality/acceptance-matrix.ts',
        why: 'decides which evidence a seal requires, and whether a decision may stand in for it',
    },
    {
        path: 'src/quality/change-record.ts',
        why: 'assembles the record every gate reads',
    },
    {
        path: 'src/workflow/verdict-binding.ts',
        why: 'decides whether a verdict still speaks for the content it judged',
    },
    {
        path: 'src/workflow/review-preflight.ts',
        why: 'decides whether a brief may be dispatched to a reviewer at all',
    },
    {
        path: 'src/store/review-request.ts',
        why: 'builds the brief the round answers, including the reading sets it is bound to',
    },
    {
        path: 'src/store/verdict.ts',
        why: 'the single derivation of whether a claim is supported',
    },
    {
        path: 'src/kernel/',
        why: 'the evidence kernel: claim evaluation and the quorum arithmetic certification rests on',
    },
    {
        path: 'src/adapters/phase-guidance.ts',
        why: 'generates the review skill text, so it writes the reviewer protocol',
    },
    {
        // **The source, not the rendered file.** The reviewer's agent definition is generated from this module into each
        // platform's agent directory by `kata-cli update`, so this is where an edit to the reviewer entry actually lands —
        // and naming the rendered path instead would put a platform name in this file, which the repository measures
        // (`tests/unit/platform-coupling-is-measured.test.ts` caught exactly that while this list was being written).
        path: 'src/adapters/manifest.ts',
        why: 'the source of the reviewer entry: the agent spec and the body a dispatched round is told it is',
    },
];

/** Whether `path` is on the certification surface, and under which entry. */
export function certificationMachineryFor(path: string): CertificationMachineryEntry | undefined {
    const normalized = path.replace(/^\.\//, '');
    return CERTIFICATION_MACHINERY.find((entry) => (entry.path.endsWith('/')
        ? normalized.startsWith(entry.path) || normalized === entry.path.replace(/\/$/, '')
        : normalized === entry.path));
}

/**
 * The certification-surface entries a set of changed paths falls under, in list order.
 *
 * Returned as entries rather than as a boolean so a refusal can name *what* was touched and *why it counts*: "this change
 * edits the machinery that decides whether it is certified" is only actionable with the module names and their reasons.
 */
export function certificationSurfaceFor(paths: readonly string[]): CertificationMachineryEntry[] {
    const matched = new Map<string, CertificationMachineryEntry>();
    for (const path of paths) {
        const entry = certificationMachineryFor(path);
        if (entry) matched.set(entry.path, entry);
    }
    return CERTIFICATION_MACHINERY.filter((entry) => matched.has(entry.path));
}
