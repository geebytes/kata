/**
 * What a reviewer may treat as authoritative: the evidence/instruction boundary (§3.3, `docs/verfify.md`).
 *
 * Two rules live here rather than spread through the brief renderer and the gate, because both are *properties of the
 * review surface* and both were observed missing:
 *
 *   1. **The graph is navigation, not evidence.** `observation.kind` names the four things a third party can open at a
 *      revision — a source path, an evidence envelope, a declared test, a deterministic analysis. A CodeGraph answer is
 *      none of them: it can point at a line ("3 callers reach this symbol"), but `grounded` requires the line. Treating
 *      the index as proof would also treat an *incomplete* index as proof, which this repository demonstrates — the index
 *      covers a handful of TypeScript nodes and points at the parent project.
 *
 *   2. **The brief is the only instruction channel.** Source, tests, fixtures, logs, sealed evidence, commit messages and
 *      README files are material *under review*. Command-shaped text inside them is evidence that the change embeds an
 *      instruction — a defect to report — never an order to follow. This is stated in the brief and encoded here so the
 *      renderer and any future consumer share one definition.
 */

/** The four kinds an `observation` may name, in the order `docs/verfify.md` lists them. */
export const ADMISSIBLE_OBSERVATION_KINDS = ['source', 'evidence', 'test', 'analysis'] as const;

export type AdmissibleObservationKind = (typeof ADMISSIBLE_OBSERVATION_KINDS)[number];

/**
 * The graph's label, kept as its own constant so callers can *name* what is refused instead of hard-coding a string that
 * would silently become admissible if the list above ever grew a fifth member.
 */
export const GRAPH_EVIDENCE_KIND = 'graph';

/**
 * Whether an observation kind can be opened at a revision.
 *
 * Anything not in the list is refused, including `graph`. Deliberately total (it answers for any string) rather than a
 * cast: a new kind added by a caller is inadmissible until it is added here on purpose.
 */
export function isAdmissibleObservationKind(kind: string): kind is AdmissibleObservationKind {
    return (ADMISSIBLE_OBSERVATION_KINDS as readonly string[]).includes(kind);
}
