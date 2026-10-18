import { statSync } from 'node:fs';
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
 * Four of the seven fields are checkable at seal time, and those four are the ones enforced — each **read the way the round
 * that writes it can write it**, because the reviewer is handed a packet, not a parser:
 *
 * - **`repairSurface`** — the paths the class-level repair promised to touch. They must be declared (a path this change does
 *   not own cannot be its repair) and at least one must actually differ from the revision being superseded. A repair that
 *   touched none of them did not happen on the surface the round contracted to.
 * - **`inventory`** — the file each entry names must exist. Entries are written as prose about a site
 *   (`` `src/x.ts` the reader (what it does) ``, or a sentence listing several paths), so an entry is resolved to the first
 *   token in it that names a file on disk. `entryPathOf` used to look the whole sentence up as a filename, which made **every**
 *   inventory written in the reviewer's own shape unsatisfiable however correct the repair was — measured on
 *   `the-gates-can-be-repaired`: 10 of 10 entries, the seal refused, and the remedy it printed could not be run from the
 *   phase the refusal left the task in.
 * - **`effectivenessTest`** — a check that ran **and passed** in this seal, matched against the envelope's id, name, command or
 *   recorded scope. Where the declaration names **no check at all** — the field is a sentence describing what reddens —
 *   nothing the seal ran can ever confirm it, and that is its own state rather than "no passing check matches": the second
 *   reads as a test that ran and did not match, so the operator looks for a failing test that does not exist, and the same
 *   sentence is printed on every future attempt. An unverifiable declaration is decided by a recorded operator decision
 *   (`obligation:<defectClass>` among the task's waivers, with its reason and approver) and is then reported as a **gap**,
 *   never as a pass — and with no decision recorded it refuses like any other unmet obligation.
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
    /**
     * Contracts this seal could not verify and that a **recorded operator decision** allowed through, each carrying the
     * decision's reason and approver.
     *
     * Their own field, not folded into `satisfied`: an unverifiable contract that was decided is not a contract that held,
     * and a reader that could not tell the two apart would report a gap as a verification — the false assurance this module
     * exists to avoid. A recorded gap never refuses the seal; the absence of a decision does.
     */
    recordedGaps: string[];
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
    /**
     * The operator's recorded decisions for this change — the task's waivers. Read here so an obligation the mechanism
     * cannot verify is *decided* rather than silently blocking: only an entry whose `path` is `obligation:<defectClass>`
     * is read as a decision about this declaration, so the same file can hold decisions about other facts without either
     * reader answering for the other's.
     */
    waivers?: readonly RecordedDecision[];
}): ObligationCheck[] {
    return input.open.flatMap((declaration) => {
        const obligation = declaration.closureObligation;
        if (obligation === undefined) return [];
        const satisfied: string[] = [];
        const unmet: string[] = [];
        const recordedGaps: string[] = [];
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

        // **An entry is resolved to the file it names, not to the whole sentence.** The reviewer writes an inventory entry
        // about a site — `src/x.ts the reader (what it does)`, a sentence listing several paths, a note about a dead import
        // — and looking the sentence up as a filename made every such entry unsatisfiable. The claim the field makes is
        // "these sites exist", and that is what is read here.
        const missing = obligation.inventory.filter((entry) => inventoryPathOf(input.root, entry) === undefined);
        if (missing.length > 0) {
            unmet.push(`inventory entries name no file in this repository: ${missing.map((entry) => JSON.stringify(entry)).join(', ')}`);
        } else {
            satisfied.push(`every inventory entry names a file that exists (${obligation.inventory.length})`);
        }

        // **One question, asked once, with one rule.** Which envelopes speak for the declared test is decided here; whether any
        // of them passed is a second, independent fact about the same set — and the two branches below are the only two states
        // that can follow, because "names no check at all" is now exactly "no envelope speaks for it".
        const declaredTest = normaliseDeclaredTest(obligation.effectivenessTest);
        const speaking = input.evidence.filter((envelope) => envelopeSpeaksFor(envelope, declaredTest));
        const proof = speaking.find((envelope) => isPassingEnvelope(envelope));
        if (proof !== undefined) {
            satisfied.push(`the effectiveness test ran and passed as ${proof.checkId ?? proof.name ?? proof.command}`);
        } else if (speaking.length === 0) {
            // **A contract nothing can confirm is its own state.** "No passing check matches" tells the operator a test
            // exists, ran and did not match — so they go looking for a failing check that does not exist, and the same
            // sentence is printed on every retry. What is true here is that the declaration names no check at all, which
            // no repair can change: the only roads are a round that names the check it means, or the operator's recorded
            // decision to proceed with the gap stated.
            const decision = recordedDecisionFor(input.waivers ?? [], declaration.defectClass);
            const reads = `the declared effectivenessTest names no check at all, so nothing this seal ran can confirm it: ${JSON.stringify(obligation.effectivenessTest)}`;
            if (decision === undefined) {
                unmet.push(`${reads}. Decide it — record a decision naming obligation:${declaration.defectClass} with its reason and approver — or have a round name the check it means`);
            } else {
                recordedGaps.push(`${reads}. Decided by ${decision.approvedBy} at ${decision.createdAt}: ${decision.reason}`);
            }
        } else {
            // **The check it names ran, and did not pass.** Reported with the checks that answered for it, so the operator sees
            // which evidence the sentence is about rather than being told a test they cannot find "did not run".
            const ids = speaking.map((envelope) => envelope.checkId ?? envelope.name ?? envelope.command ?? '<unnamed check>');
            unmet.push(`no passing check in this seal matches the declared effectivenessTest (${obligation.effectivenessTest}) — ${ids.join(', ')} answered for it and did not pass`);
        }
        return [{ defectClass: declaration.defectClass, obligation, satisfied, unmet, recordedGaps }];
    });
}

/** Whether a check that declared itself the effectiveness test produced the outcome it declared. */
function isPassingEnvelope(envelope: EvidenceEnvelope): boolean {
    return (envelope.passed ?? envelope.exitCode === (envelope.expectExitCode ?? 0)) === true;
}

/**
 * **The declaration as it is compared, with its decoration removed.**
 *
 * A reviewer writes this field as prose about a repository: `` `tests/unit/a.test.ts` `` with backticks, a trailing `:12`, a
 * sentence around a path. Comparing the raw string against an envelope's fields made a *decorated* declaration fail to match
 * the very check it named — measured (round 10, P4): a backticked test path read against the passing envelope of exactly that
 * test printed "it names a check, and that check did not run or did not pass", because the backticks are not in the command.
 *
 * One normalisation, so the two questions below cannot disagree about what the declaration says.
 */
export function normaliseDeclaredTest(effectivenessTest: string): string {
    return effectivenessTest
        .replace(/[`'"]/gu, '')
        .replace(/:+\d+/gu, '')
        .replace(/\s+/gu, ' ')
        .trim();
}

/**
 * **Whether one envelope speaks for the declared effectiveness test — the one rule for that fact.**
 *
 * Matched against every place the declaration could have been written — the check id, its name, the command, and the paths the
 * evidence was scoped to — because the field is written by a reviewer reading a repository, not by a schema. The comparison is
 * a substring one in the direction that matters (the envelope must *contain* the declared test): a reviewer naming
 * `tests/unit/a.test.ts` satisfies a check whose command is `npx vitest run tests/unit/a.test.ts`, and a reviewer naming the
 * whole command satisfies itself.
 *
 * **This is the only rule for this question.** It used to have a second, contradictory one (`declarationNamesACheck`, an
 * eight-character-identifier search) answering "does the declaration name a check at all", and for legal inputs the two
 * disagreed: a passing check whose declaration was decorated read as "ran and did not pass", and a *failing* check with a
 * short id read as "names no check at all" — the state that offers the recorded-decision road, so an operator could waive a
 * contract the seal had in fact decided (measured: round 10, P3/P4/P5/P9; the class this change exists to close, inside the
 * reader added to close it).
 */
function envelopeSpeaksFor(envelope: EvidenceEnvelope, declaredTest: string): boolean {
    if (declaredTest === '') return false;
    const haystack = [envelope.checkId, envelope.name, envelope.command, ...(envelope.scope?.paths ?? [])]
        .filter((value): value is string => typeof value === 'string')
        .map((value) => normaliseDeclaredTest(value))
        .filter((value) => value !== '');
    return haystack.some((value) => value.includes(declaredTest) || declaredTest.includes(value));
}

/**
 * **The file an inventory entry names**, resolving the entry rather than trusting its shape.
 *
 * An entry is written by a reviewer reading a repository: `src/x.ts the reader (what it does)`, a sentence that lists
 * several paths, or a note about a site that is dead. What the field claims is that these sites exist, so the entry is read
 * as: the first token in it that names a file on disk, with backticks, quotes, a trailing `:line` and trailing punctuation
 * stripped. `undefined` means the entry names no file at all — a real defect in the declaration, reported with the entry
 * quoted so the round can see which one, rather than the whole list being reported as missing.
 */
export function inventoryPathOf(root: string, entry: string): string | undefined {
    const rawTokens = entry.split(/[\s,]+/u);
    for (const [index, raw] of rawTokens.entries()) {
        const stripped = raw.replace(/[`'"[\]()<>]/gu, '').replace(/:+\d*$/u, '').replace(/[.,;:]+$/u, '').trim();
        if (stripped === '') continue;
        // **A token has to be written where a path goes, not merely appear in a sentence.**
        //
        // The resolver used to take the first token that existed at all, and a directory counted. Measured (round 10, P1/P2):
        // "the reader that used to exist in src was removed by the repair" resolved to `src` and the check reported the
        // inventory satisfied, and "the dead import was in package.json and nowhere else, no site named" resolved to
        // `package.json`. An entry that names no site is exactly the shape this field exists to reject, so the resolution is
        // narrowed to the positions a reviewer writes a site in: the entry's first token (the documented shape,
        // `src/x.ts the reader`), a backticked or quoted token, or a token that carries a path separator.
        const writtenAsPath = index === 0 || /[`'"]/u.test(raw) || stripped.includes('/');
        if (!writtenAsPath) continue;
        // **And only a regular file counts.** `existsSync` accepts a directory, a FIFO and a socket alike; the claim this
        // field makes is "the site exists", and a directory is not a site the round repaired.
        const resolved = join(root, stripped);
        try {
            if (statSync(resolved).isFile()) return stripped;
        } catch {
            continue;
        }
    }
    return undefined;
}

/** A decision the operator recorded, with the facts needed to report it: who decided, when, and why. */
export interface RecordedDecision {
    path: string;
    reason: string;
    approvedBy: string;
    createdAt: string;
}

/** The recorded decision about one class' obligation, if the operator recorded one. */
function recordedDecisionFor(waivers: readonly RecordedDecision[], defectClass: string): RecordedDecision | undefined {
    return waivers.find((waiver) => waiver.path?.trim() === `obligation:${defectClass}`);
}
function entryPathOf(entry: string): string {
    const withoutLine = entry.trim().split(':')[0] ?? entry.trim();
    return withoutLine.trim();
}
