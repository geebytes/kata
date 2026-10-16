import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { EvidenceEnvelope } from './evidence.js';
import type { ClosureObligation } from './recurrence-packet.js';
import { openClosureObligations, type RepairDeclaration } from './repair-declarations.js';

/**
 * **The closure obligation as something a seal has to satisfy, rather than something a record has to mention.**
 *
 * The packet demands seven named fields and the review validator refuses a `repair` conclusion without them, and until this
 * module *nothing read them again*: the repair could declare one `sourceOfTruth` and fix one call site, declare an
 * `effectivenessTest` and never run it, and seal — because the fields only had to be non-empty strings. Measured on the change
 * this whole line of work came from: five rounds, three classes, three sites, every round reporting itself as a class-level fix.
 * A label that no mechanism reads is a label; the difference between "the round explained itself" and "the repair is
 * contracted to something checkable" is whether a later command compares the arrow against the work.
 *
 * Four of the seven fields are checkable at seal time, and those four are the ones enforced:
 *
 * - **`repairSurface`** — the paths the class-level repair promised to touch. They must be declared (a path this change does
 *   not own cannot be its repair) and at least one must actually differ from the revision being superseded. A repair that
 *   touched none of them did not happen on the surface the round contracted to.
 * - **`inventory`** — every site named must exist in the repository. An inventory is a claim about what exists; a stale or
 *   invented entry is the state a later round finds a neighbour in.
 * - **`effectivenessTest`** — a check that ran **and passed** in this seal, matched against the envelope's id, name, command or
 *   recorded scope. "It is fixed" is decided by running something, which is what the field promised.
 * - **`ifRecursAgain`** — a closed vocabulary (`rewrite_mechanism | waive_with_owner | abandon_change`) checked when the
 *   declaration is read, so the route out is a route that exists.
 *
 * What is **not** enforced, said plainly rather than implied: `states`, `sourceOfTruth` and `invariant` are prose. Verifying
 * that a state enumeration is complete, that a symbol is the only derivation of a fact, or that a sentence holds at every site
 * is the class-level review's job, not a seal's — and pretending a substring check enforced it would be the false assurance
 * this project refuses elsewhere. They are recorded, they are read by the next round, and they are not claimed here.
 */
export interface ObligationCheck {
    defectClass: string;
    obligation: ClosureObligation;
    /** The obligations that hold, each named with the fact that satisfied it. */
    satisfied: string[];
    /** The obligations the repair has not met. A non-empty list is what refuses the seal. */
    unmet: string[];
}

/** The obligations contracted on the revision a seal is about to supersede — the repair this seal is expected to be. */
export function obligationsForSeal(input: {
    declarations: readonly RepairDeclaration[];
    /** One entry per classified finding of every recorded round, in append order. */
    occurrences: Parameters<typeof openClosureObligations>[1];
}): RepairDeclaration[] {
    return openClosureObligations(input.declarations, input.occurrences);
}

/**
 * Check each open obligation against the work the seal is certifying.
 *
 * `paths` is the task's declaration, `evidence` is what this seal just ran, and `movedPaths` is what actually changed relative
 * to the superseded revision — passed in rather than recomputed here, because the seal already derives it and a second
 * derivation of "what changed" is the defect this repository removes most often.
 */
export function checkObligations(input: {
    root: string;
    open: readonly RepairDeclaration[];
    declaredPaths: readonly string[];
    evidence: readonly EvidenceEnvelope[];
    /** What this seal changed relative to the revision it replaces — the fallback when the contract names no baseline. */
    movedPaths: readonly string[];
    /** The path digests of the revision each contract was written about, keyed by that revision. */
    baselineDigests: ReadonlyMap<string, Record<string, string>>;
    /** The revision this seal is minting: what "touched" is measured against. */
    currentDigests: Record<string, string>;
}): ObligationCheck[] {
    return input.open.flatMap((declaration) => {
        const obligation = declaration.closureObligation;
        if (obligation === undefined) return [];
        const satisfied: string[] = [];
        const unmet: string[] = [];
        const declared = new Set(input.declaredPaths);
        const moved = new Set(input.movedPaths);

        const undeclared = obligation.repairSurface.filter((path) => !declared.has(path));
        if (undeclared.length > 0) {
            unmet.push(`repairSurface names paths this change does not declare: ${undeclared.join(', ')}`);
        } else {
            satisfied.push(`every repairSurface path is declared (${obligation.repairSurface.length})`);
        }
        // **Measured against the revision the contract was written about, when the record says which that is.** Comparing with
        // the immediately preceding revision asks "did anything change since the last attempt", and an attempt that was refused
        // for this very reason has already moved the pointer — so a repair that was made after the refusal reads as no repair at
        // all, and the seal names "changed: nothing" for work that is on disk. The contract was written about the content the
        // round read; that is the baseline the repair has to differ from.
        const baseline = declaration.revisionId === undefined ? undefined : input.baselineDigests.get(declaration.revisionId);
        const touched = baseline === undefined
            ? obligation.repairSurface.filter((path) => moved.has(path))
            : obligation.repairSurface.filter((path) => baseline[path] !== input.currentDigests[path]);
        if (touched.length === 0) {
            // The distinction matters: an undeclared surface is a declaration error, an untouched one is a repair that happened
            // somewhere else. Only the second says the contract was not honoured.
            unmet.push(`the repair touched none of its declared repairSurface (${obligation.repairSurface.join(', ')}); changed: ${[...moved].slice(0, 10).join(', ') || 'nothing'}`);
        } else {
            satisfied.push(`the repair touched ${touched.length} of ${obligation.repairSurface.length} declared surface path(s)`);
        }

        const missing = obligation.inventory.filter((entry) => !existsSync(join(input.root, entryPathOf(entry))));
        if (missing.length > 0) {
            unmet.push(`inventory names sites that do not exist: ${missing.join(', ')}`);
        } else {
            satisfied.push(`every inventory site exists (${obligation.inventory.length})`);
        }

        const proof = input.evidence.find((envelope) => isPassingEnvelope(envelope) && envelopeNamesCheck(envelope, obligation.effectivenessTest));
        if (proof === undefined) {
            unmet.push(`no passing check in this seal matches the declared effectivenessTest (${obligation.effectivenessTest})`);
        } else {
            satisfied.push(`the effectiveness test ran and passed as ${proof.checkId ?? proof.name ?? proof.command}`);
        }
        return [{ defectClass: declaration.defectClass, obligation, satisfied, unmet }];
    });
}

/** Whether a check that declared itself the effectiveness test produced the outcome it declared. */
function isPassingEnvelope(envelope: EvidenceEnvelope): boolean {
    return (envelope.passed ?? envelope.exitCode === (envelope.expectExitCode ?? 0)) === true;
}

/**
 * Whether one envelope is the declared effectiveness test.
 *
 * Matched against every place the declaration could have been written — the check id, its name, the command, and the paths the
 * evidence was scoped to — because the field is written by a reviewer reading a repository, not by a schema. The comparison is
 * a substring one in the direction that matters (the envelope must *contain* the declared test): a reviewer naming
 * `tests/unit/a.test.ts` satisfies a check whose command is `npx vitest run tests/unit/a.test.ts`, and a reviewer naming the
 * whole command satisfies itself.
 */
function envelopeNamesCheck(envelope: EvidenceEnvelope, effectivenessTest: string): boolean {
    const declared = effectivenessTest.trim();
    if (declared === '') return false;
    const haystack = [envelope.checkId, envelope.name, envelope.command, ...(envelope.scope?.paths ?? [])]
        .filter((value): value is string => typeof value === 'string');
    return haystack.some((value) => value.includes(declared) || declared.includes(value));
}

/** An inventory entry is a path, optionally with a `:line` suffix — the suffix is a reader's aid, not part of the path. */
function entryPathOf(entry: string): string {
    const withoutLine = entry.trim().split(':')[0] ?? entry.trim();
    return withoutLine.trim();
}
