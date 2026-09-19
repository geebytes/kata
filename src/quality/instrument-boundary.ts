import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { instrumentPaths, isInstrumentPath, type FindingLayer } from './code-surface.js';

/**
 * Declared coverage boundaries for a task's instruments (§21.2).
 *
 * The problem this closes: a finding is today either repaired or — at `blocking`/`major` — not deferrable at all. But
 * *"your guard does not cover dimension X"* is frequently a **design boundary rather than a defect**: the guard was never
 * meant to cover X, and saying so is the resolution. Without a way to say it, an adversarial search against any guard has
 * **no terminating condition** — it finds the unguarded dimension every time, and the round count grows until the guard is
 * deleted.
 *
 * So a task may declare, per instrument, what it covers and what it does not, and **where the single canonical statement of
 * that lives**. Findings are then classified `within` or `beyond` that declaration. `within` is repaired as before;
 * `beyond` is closeable **with the declaration as the reason**, and the reason is displayed at review/judge/archive so a
 * boundary can never be used to bury something silently.
 */
export interface InstrumentBoundary {
    /** The instrument this boundary describes, as declared in `instruments[]`. */
    instrument: string;
    /** One line per dimension the instrument **does** cover. */
    covers: string[];
    /**
     * One line per dimension it does not, each with why not.
     *
     * This is the declaration a `beyond-declared-coverage` finding is closed against, so it has to be specific enough to
     * answer "does it cover X?" without a human re-reading the instrument.
     */
    doesNotCover: Array<{ dimension: string; reason: string }>;
    /**
     * The **single** canonical statement of this boundary (a doc path, usually), checked to exist.
     *
     * One statement, not several: two statements of a boundary drift, and the drift is only discovered when a finding is
     * closed against the stale one.
     */
    canonicalStatement: string;
}

export interface BoundaryDeclaration {
    boundaries: InstrumentBoundary[];
}

/** Why a declaration was refused — read by the preflight that runs before a seal. */
export interface BoundaryRefusal {
    instrument: string;
    reason: 'undeclared_instrument' | 'missing_canonical_statement' | 'empty_boundary' | 'not_a_list';
    detail: string;
}

/**
 * Validates a boundary declaration against the task's own instruments.
 *
 * The rules are the ones whose absence caused the measured loop:
 *   - an instrument must be **declared** before a boundary can be claimed for it (you cannot decide a boundary for
 *     something you have not admitted is an instrument);
 *   - the canonical statement must **exist**, because a boundary whose single source of truth is missing is a boundary
 *     nobody can check a finding against;
 *   - the boundary must say something — an empty `doesNotCover` is not a declaration, it is silence with a field name.
 */
export function validateBoundaries(
    root: string,
    task: { instruments?: string[] },
    declaration: BoundaryDeclaration | null | undefined,
): BoundaryRefusal[] {
    if (!declaration) return [];
    if (!Array.isArray(declaration.boundaries)) {
        return [{ instrument: '', reason: 'not_a_list', detail: 'boundaries must be an array of declarations' }];
    }
    const declared = new Set(instrumentPaths(task));
    const refusals: BoundaryRefusal[] = [];
    for (const boundary of declaration.boundaries) {
        if (!declared.has(boundary.instrument)) {
            refusals.push({
                instrument: boundary.instrument,
                reason: 'undeclared_instrument',
                detail: `'${boundary.instrument}' has a boundary declaration but is not in the task's instruments[] — a boundary for something not declared as an instrument cannot be closed against`,
            });
            continue;
        }
        if (!boundary.canonicalStatement?.trim()) {
            refusals.push({ instrument: boundary.instrument, reason: 'missing_canonical_statement', detail: `'${boundary.instrument}' declares a boundary with no canonicalStatement` });
            continue;
        }
        if (!existsSync(join(root, boundary.canonicalStatement))) {
            refusals.push({
                instrument: boundary.instrument,
                reason: 'missing_canonical_statement',
                detail: `'${boundary.instrument}' names ${boundary.canonicalStatement} as the canonical statement of its boundary, and that file does not exist`,
            });
        }
        if ((boundary.doesNotCover ?? []).length === 0) {
            refusals.push({
                instrument: boundary.instrument,
                reason: 'empty_boundary',
                detail: `'${boundary.instrument}' declares no doesNotCover entries; a boundary that excludes nothing is not a boundary`,
            });
        }
    }
    return refusals;
}

/**
 * The classification a finding gets against a declaration.
 *
 * `beyond` requires a **quoted dimension** from the declaration, not a free-text excuse: the whole failure mode being
 * closed is a boundary used as a catch-all, so the closing argument has to point at a line someone decided in advance.
 */
export type CoverageClass = 'within-declared-coverage' | 'beyond-declared-coverage';

export interface CoverageVerdict {
    classification: CoverageClass;
    /** The declared dimension the finding falls outside, when it is `beyond`. */
    dimension?: string;
    /** The canonical statement the closure is answerable to. */
    canonicalStatement?: string;
    /** Why the classification could not be made, when it could not — reported rather than guessed. */
    undecidable?: string;
}

export function classifyFindingCoverage(
    task: { instruments?: string[] },
    declaration: BoundaryDeclaration | null | undefined,
    finding: { path?: string; message?: string },
): CoverageVerdict | null {
    const layer: FindingLayer | null = finding.path && isInstrumentPath(task, finding.path) ? 'instrument' : null;
    // Only an instrument finding can be beyond a declaration: the deliverable has no boundary to be outside of.
    if (layer !== 'instrument') return null;
    const instrument = instrumentPaths(task).find((candidate) => finding.path?.startsWith(candidate.replace(/\/$/, '')));
    const boundary = (declaration?.boundaries ?? []).find((entry) => entry.instrument === instrument);
    if (!boundary) {
        return { classification: 'within-declared-coverage', undecidable: `'${instrument}' has no boundary declaration, so no dimension can be excluded — a guard with no stated boundary is answerable for everything it could cover` };
    }
    // Match the finding to a declared dimension by quoting it: the finding must name the dimension the declaration excluded.
    const message = finding.message ?? '';
    const excluded = (boundary.doesNotCover ?? []).find((entry) => message.includes(entry.dimension));
    if (!excluded) {
        return {
            classification: 'within-declared-coverage',
            undecidable: `the finding does not quote any dimension declared as not covered by '${instrument}' (declared: ${(boundary.doesNotCover ?? []).map((entry) => entry.dimension).join(', ') || 'none'})`,
        };
    }
    return { classification: 'beyond-declared-coverage', dimension: excluded.dimension, canonicalStatement: boundary.canonicalStatement };
}
