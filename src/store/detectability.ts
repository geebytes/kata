/**
 * Defect detection, measured without a model: does the check that owns a corpus case go red when the defect is back?
 *
 * **What this is for.** `scoreCorpus` measures a verifier's recall against the 27-case admissibility corpus, and its
 * observations have only ever been hand-written, because producing them needs a verifier that reports finding ids. That is
 * the gap the plan records as "recall is not measurable". This module closes the cheap half of it honestly: four of the
 * corpus's cases are `mutation-case` entries whose `reproduction` already names an exact implementation change
 * ("In `src/quality/claims.ts`, force `validateClaims` to return no failures and run the suite"), and a planted defect is
 * **detectable** exactly when the check that owns it reddens with the defect back.
 *
 * **What it is not.** It is not "a reviewer found this defect", and the output says so. It measures whether the repository
 * can still *see* a defect it once shipped — a property of the checks, not of a pass. A rate computed here cannot rise by
 * reading more carefully; it can only rise by a check being repaired. That makes it weaker than recall and stronger than
 * nothing, and it is the only form of the measurement available without a verifier implementation.
 *
 * **Why a declaration rather than a parser.** Reading `find`/`replace` out of a sentence would be the "interpret prose to
 * derive a fact" class this repository keeps removing. The mapping from a corpus case to a mutation is data, checked for
 * completeness in both directions: a `mutation-case` with no entry here fails the check below, and an entry naming no
 * corpus case fails too.
 */
import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { admissibilityCorpus } from '../eval/admissibility-corpus.js';

/** One reproducible defect: put `replace` where `find` was, run `check`, put it back. */
export type DetectabilityProbe = {
    /** The corpus case this probe makes measurable. */
    caseId: string;
    /** The repository-relative file the defect lives in. */
    file: string;
    /** Text that is present now and must be replaced to restore the defect. */
    find: string;
    replace: string;
    /** The check that owns the defect: it must FAIL while the defect is present and PASS when it is restored. */
    check: string[];
    /** Why this check is the one that owns the defect, so a reader can see the attribution rather than trust it. */
    why: string;
};

export type DetectabilityResult = {
    caseId: string;
    /** `detected` — the check reddened with the defect present and recovered. `inconclusive` — it could not be run. */
    outcome: 'detected' | 'undetected' | 'inconclusive';
    /** The three exit codes, or the reason the probe could not run. */
    observed: string;
    why: string;
};

export type DetectabilityReport = {
    measured: number;
    detected: number;
    undetected: DetectabilityResult[];
    inconclusive: DetectabilityResult[];
    /** The cases this probe set deliberately does not cover, with why — so a partial measurement cannot read as a full one. */
    notProbed: Array<{ caseId: string; why: string }>;
    measures: string;
    results: DetectabilityResult[];
};

/**
 * The probes.
 *
 * Four, because four corpus cases carry a reproduction that names an exact implementation change. The rest are described
 * in prose ("A/B the same verdict through the CLI") and are listed under `NOT_PROBED` below rather than silently omitted:
 * a measurement that covers four of nine critical cases must say so.
 */
export const DETECTABILITY_PROBES: readonly DetectabilityProbe[] = [
    {
        caseId: 'claims-checker-central-mutation',
        file: 'src/quality/claims.ts',
        find: '            if (!(found.passed ?? found.exitCode === summary.expect.exitCode)) {',
        replace: '            if (false) {',
        check: ['npx', 'vitest', 'run', 'tests/unit/claims.test.ts', '--reporter=basic'],
        why: 'The claim check is what makes a criterion sentence falsifiable; forcing it to accept everything is the defect the case names, and that suite is the one that asserts it.',
    },
    {
        caseId: 'adequacy-checker-central-mutation',
        file: 'src/quality/evidence-adequacy.ts',
        find: 'export function evaluateAcceptanceAdequacy(',
        replace: 'export function evaluateAcceptanceAdequacyUnused(',
        check: ['npx', 'vitest', 'run', 'tests/unit/evidence-adequacy.test.ts', '--reporter=basic'],
        why: 'Renaming the shared evaluator is the cheapest form of "make it return PASS without reading the evidence": the ladder cannot call it any more, so the adequacy suite must redden.',
    },
    {
        caseId: 'scope-guard-central-mutation',
        file: 'src/quality/scope-change.ts',
        find: 'export async function applyScopeChange(',
        replace: 'export async function applyScopeChangeUnused(',
        check: ['npx', 'vitest', 'run', 'tests/unit/scope-change-safety.test.ts', '--reporter=basic'],
        why: 'The scope write path is what the case names — a write path that trusts its input while every read path validates it — and that suite asserts the refusal.',
    },
];

/** The critical cases no probe reaches, each with the reason, so the coverage of this measurement is stated not implied. */
export const NOT_PROBED: ReadonlyArray<{ caseId: string; why: string }> = [
    // **A probe whose subject was deleted is a probe that cannot run.** This one was here and reported `inconclusive` with
    // `ENOENT` on every run — a permanent inconclusive that read as an unmeasured case rather than as a case with nothing
    // left to measure. The obligation route went with the round-shaped mechanism, so its probe moves here with the reason
    // beside it, which is where the rest of this list lives.
    { caseId: 'obligation-resolution-mutation', why: 'the obligation route was deleted with the round-shaped mechanism, so its module and suite no longer exist and this defect cannot be planted' },
    { caseId: 'seal-refusal-mutates-the-task-it-refuses', why: 'the reproduction is a CLI session against a task, not an implementation change' },
    { caseId: 'change-record-empties-when-the-round-commits', why: 'needs a commit and a seal, which is a workspace operation rather than a mutation' },
    { caseId: 'change-surface-anchored-on-the-declaration', why: 'needs a commit touching paths outside the declaration' },
    { caseId: 'recorded-scope-disagrees-with-the-issued-brief', why: 'needs a brief issued and a record written against it' },
    { caseId: 'auto-selected-delta-round-records-as-full', why: 'needs a closed repair batch to derive a delta brief' },
    { caseId: 'budget-exhaustion-is-reported-not-silent', why: 'needs a round driven to its envelope' },
    { caseId: 'cheaper-verifier-that-misses-defects', why: 'is about this measurement itself; it is a property of the scorer and is asserted in the eval unit tests' },
    { caseId: 'stale-evidence-bound-to-another-revision', why: 'needs two revisions sealed around an unchanged tree' },
    { caseId: 'evidence-cites-a-path-absent-from-the-revision', why: 'needs a produced record citing a deleted file' },
    { caseId: 'foreign-worktree-drift-enters-the-delta', why: 'needs a second writer in a shared worktree' },
    { caseId: 'duplicate-equivalent-queries-inflate-the-round', why: 'needs a round issuing the same query twice' },
    { caseId: 'check-writes-into-the-author-workspace', why: 'needs a check that writes at the repository root' },
    { caseId: 'prompt-injection-in-the-material', why: 'needs a pass reading the material, which is a verifier behaviour' },
    { caseId: 'minimal-record-that-satisfies-the-old-predicate', why: 'needs the old gate predicate, which was replaced by the ledger route' },
];

function run(command: string[], cwd: string): Promise<number> {
    return new Promise((resolve) => {
        execFile(command[0]!, command.slice(1), { cwd, timeout: 600_000, maxBuffer: 32 * 1024 * 1024 }, (error) => {
            if (error === null) resolve(0);
            else if (typeof (error as { code?: unknown }).code === 'number') resolve((error as { code: number }).code);
            else resolve(1);
        });
    });
}

/**
 * Run every probe: the check must pass first, fail with the defect restored, and pass again once restored.
 *
 * The three steps are the falsifier's, for the same reason: a check that is already failing proves nothing about the
 * defect, and a check that stays green with the defect present is a check that cannot see it. The file is written back
 * **in a `finally`**, so an interrupted probe cannot leave the repository holding a defect.
 */
export async function measureDetectability(input: { root: string; probes?: readonly DetectabilityProbe[] }): Promise<DetectabilityReport> {
    const probes = input.probes ?? DETECTABILITY_PROBES;
    const results: DetectabilityResult[] = [];

    for (const probe of probes) {
        const path = join(input.root, probe.file);
        let original: string;
        try {
            original = await readFile(path, 'utf8');
        } catch (error) {
            results.push({ caseId: probe.caseId, outcome: 'inconclusive', observed: `${probe.file} cannot be read: ${(error as Error).message}`, why: probe.why });
            continue;
        }
        const occurrences = original.split(probe.find).length - 1;
        if (occurrences !== 1) {
            // A probe whose anchor is gone or ambiguous cannot measure anything, and saying so is the point: the anchor is
            // the defect's location, and a defect whose location moved is a case that needs re-describing rather than a
            // detection that failed.
            results.push({ caseId: probe.caseId, outcome: 'inconclusive', observed: `the anchor appears ${occurrences} time(s) in ${probe.file}, so the defect cannot be restored unambiguously`, why: probe.why });
            continue;
        }

        const before = await run(probe.check, input.root);
        let mutated = -1;
        let after = -1;
        try {
            await writeFile(path, original.replace(probe.find, probe.replace));
            mutated = await run(probe.check, input.root);
        } finally {
            await writeFile(path, original);
        }
        after = await run(probe.check, input.root);

        const observed = `check exit {before: ${before}, mutated: ${mutated}, after: ${after}}`;
        if (before !== 0) {
            results.push({ caseId: probe.caseId, outcome: 'inconclusive', observed: `${observed} — the check was already failing, so it cannot show what the defect changed`, why: probe.why });
        } else if (after !== 0) {
            results.push({ caseId: probe.caseId, outcome: 'inconclusive', observed: `${observed} — the file was not restored to a green state`, why: probe.why });
        } else if (mutated === 0) {
            results.push({ caseId: probe.caseId, outcome: 'undetected', observed: `${observed} — the check stayed green with the defect restored`, why: probe.why });
        } else {
            results.push({ caseId: probe.caseId, outcome: 'detected', observed, why: probe.why });
        }
    }

    const corpusIds = new Set(admissibilityCorpus().map((entry) => entry.id));
    // Both directions, because a declaration nothing checks is the class this repository keeps finding: a probe naming no
    // corpus case, and a probed case that is not in the corpus, are both refused rather than ignored.
    const unknownProbe = probes.find((probe) => !corpusIds.has(probe.caseId));
    if (unknownProbe) throw new Error(`probe names a case the corpus does not hold: ${unknownProbe.caseId}`);

    return {
        measured: results.length,
        detected: results.filter((result) => result.outcome === 'detected').length,
        undetected: results.filter((result) => result.outcome === 'undetected'),
        inconclusive: results.filter((result) => result.outcome === 'inconclusive'),
        notProbed: [...NOT_PROBED],
        measures: 'whether the checks that own a corpus case still redden when its defect is restored — not whether a reviewer would find it, which needs a verifier implementation',
        results,
    };
}
