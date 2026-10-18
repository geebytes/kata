import { DISPOSITIONS } from './review-ladder.js';

/**
 * **The rules a finding's disposition has to obey — one place, because they were enforced by nothing.**
 *
 * `docs/design/2026-09-18-finding-lifecycle-and-proportional-reverification.md` §F1.3 states them: a `blocking`/`major`
 * finding **refuses both `defer` and `accept`** — the message points at the repair, which is the only way out — while
 * `minor`/`note` allow both and `deferred` requires a `reason`. §I1's failure table says the same thing from the other side
 * ("用 `accept` 掩盖真缺陷 | `blocking`/`major` 拒绝 accept").
 *
 * The command that enforced it (`kata-cli findings defer|accept|carry`) was removed together with the route it belonged to,
 * and the path that replaced it — a review result file — validates each finding's **severity** and its **class** and never
 * its disposition. So `schemas/review-finding.schema.json` documented a vocabulary that nothing checked, and the one shape
 * §I1 names as burying a real defect (a merge-blocking finding marked `accepted`) was reachable with no reason given.
 *
 * **The vocabulary is imported, not restated.** `DISPOSITIONS` is the ladder's list; a copy here is how one lifecycle field
 * acquires two readings, which is the class this repository has already paid for once between the schema and its readers.
 * What *closes* a finding stays the ladder's answer (`CLOSING_DISPOSITIONS` and `isOpenFinding`), and this module does not
 * offer a second opinion on it: a `closesFinding` helper lived here for one revision, unused, and `check:wiring` reported it
 * as a reference kept alive only by its own test — the finding class this repository deletes rather than tolerates.
 *
 * **Why this validates data rather than a command.** Findings enter the repository through a review result file — the brief
 * the round was dispatched with and the payload it answers with — so the rules belong where that payload is read, on every
 * route at once. A rule that only a subcommand can enforce is a rule that the route which *wrote* the record never met.
 */
export interface DisposableFinding {
    id?: unknown;
    severity?: unknown;
    disposition?: unknown;
    dispositionReason?: unknown;
}

/** The severities whose findings may not be dispositioned away: the repair is the only way out. */
const MUST_BE_REPAIRED = new Set(['blocking', 'major']);

/** The dispositions that leave the problem in place, each of which therefore owes a reason. */
const NEEDS_A_REASON = new Set(['deferred', 'accepted', 'routed']);

const nameOf = (finding: DisposableFinding): string => (typeof finding.id === 'string' && finding.id !== '' ? finding.id : '(unnamed)');

/**
 * Every rule this finding's disposition breaks, as sentences that name the finding and the way out.
 *
 * All of them, not the first: a round that has three findings to fix should be told about three, and a validator that stops
 * at the first turns one round of work into three.
 */
export function findingDispositionProblems(findings: readonly DisposableFinding[]): string[] {
    const problems: string[] = [];
    for (const finding of findings) {
        const disposition = finding.disposition;
        // Absent is the schema's own reading of "open" — a finding nobody has disposed of yet, which is not a problem.
        if (disposition === undefined || disposition === null) continue;
        if (typeof disposition !== 'string' || !(DISPOSITIONS as readonly string[]).includes(disposition)) {
            problems.push(
                `Finding ${nameOf(finding)} carries disposition "${String(disposition)}", which is not in the disposition vocabulary `
                + `(${DISPOSITIONS.join(', ')}); it is refused rather than filed under a neighbouring word.`,
            );
            continue;
        }
        const severity = typeof finding.severity === 'string' ? finding.severity : '';
        if (MUST_BE_REPAIRED.has(severity) && disposition !== 'fixed') {
            problems.push(
                `Finding ${nameOf(finding)} is ${severity} and disposed "${disposition}": a ${severity} finding must be repaired in this `
                + `change, not deferred, accepted or routed. Repair it, or narrow the change so the finding does not apply.`,
            );
            continue;
        }
        if (NEEDS_A_REASON.has(disposition) && !hasReason(finding.dispositionReason)) {
            problems.push(
                `Finding ${nameOf(finding)} is disposed "${disposition}" with no dispositionReason: this value leaves the problem in `
                + `place, so the record has to say why and where it went. Add \`dispositionReason\`.`,
            );
        }
    }
    return problems;
}

/** Whether a reason was given: the field exists so a reader can answer "why is this still here", so blank is not an answer. */
function hasReason(reason: unknown): boolean {
    return typeof reason === 'string' && reason.trim().length > 0;
}
