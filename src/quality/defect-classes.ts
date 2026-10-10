import { statSync } from 'node:fs';
import { relative as relativePathOf, resolve, sep } from 'node:path';
import { isIgnoredRepositoryPath } from '../core/repository-identity.js';

/**
 * **The defect classes this repository's review loop produces, and what kind of oracle each one needs.**
 *
 * A round records a finding; nothing recorded *which class of defect* it was. Measured on 2026-10-10: 49 changes, 102 review
 * rounds, and 56 findings left on disk, because a round record kept ids and a count while `review.json` was overwritten each
 * round. So the one number that would say whether the loop is converging — which class keeps recurring — could not be read at
 * all, and the loop kept paying for the same class in change after change.
 *
 * The `oracle` field is the load-bearing part, and it is a statement about *instrument*, not about severity:
 *
 * - `mechanizable` — the defect is decidable by a machine over a declared input space: two derivations of one fact disagreeing
 *   (differential/metamorphic testing), a refusal whose named remedy cannot be executed (run it), a corrupt read that reads as
 *   absent (three-state fixtures), a comparison that does not name what it compared, a guard whose mutation does not redden it
 *   (mutation adequacy), a declaration that does not cover what it claims (generated inputs over the surface). Those are
 *   enumerated exhaustively and cheaply, and paying a 22-minute independent round for the *n*-th shape of one of them is the
 *   cost this vocabulary exists to make visible.
 * - `judgment` — no machine decides it from the artefacts: a requirement that says X while nothing does X, two consumers that
 *   disagree about a contract's meaning, an omission nobody wrote down. This is what an independent round is *for* (Fagan), and
 *   it stays expensive on purpose.
 *
 * A class with no definition would be a word two people fill differently, so every entry carries one. An unknown value is
 * refused by name at the point a finding is recorded rather than filed under a neighbouring word.
 */
export type OracleType = 'mechanizable' | 'judgment';

export interface DefectClassDefinition {
    /** What kind of oracle answers this class — see the module comment; this is the field that decides the instrument. */
    oracle: OracleType;
    /** One sentence a reviewer can read and apply without asking. */
    definition: string;
}

export const DEFECT_CLASSES = {
    'one-fact-derived-twice': {
        oracle: 'mechanizable',
        definition:
            'The same fact is computed by two implementations, or read from two different surfaces, and they can disagree — a differential or metamorphic relation decides it by enumeration.',
    },
    'refusal-cannot-be-executed': {
        oracle: 'mechanizable',
        definition:
            'A refusal, or a diagnostic, names a remedy the operator cannot reach from the state that produced it (the named command fails, names a path that does not exist, or names the state the operator just left).',
    },
    'corrupt-read-as-absent': {
        oracle: 'mechanizable',
        definition:
            'A reader folds "cannot be read" into "there is nothing there", so a damaged record, directory or pointer is answered as a missing one; decided by driving each of the three states.',
    },
    'comparison-unnamed': {
        oracle: 'mechanizable',
        definition:
            'A verdict asserts that something differs without naming what it compared, so the reader cannot reach the difference from the artefact they were given.',
    },
    'instrument-unsound': {
        oracle: 'mechanizable',
        definition:
            'A guard, a declared falsifier or an anchor claims to prove a property and does not: it reddens for another reason, its anchor no longer matches, or it stays green under the mutation it names. Decided by mutation adequacy, including whether the mutation applied.',
    },
    'declaration-covers-other': {
        oracle: 'mechanizable',
        definition:
            'A declaration — owned paths, a check set, a boundary, a coverage claim — describes something other than what it actually covers, so its subject is measured against the wrong surface.',
    },
    'boundary-on-a-default': {
        oracle: 'mechanizable',
        definition:
            'A limit, budget or timeout is whatever a library or platform defaulted to rather than a value this repository chose and can state, so behaviour under load is a coin flip rather than a bound.',
    },
    'intent-omission': {
        oracle: 'judgment',
        definition:
            'A requirement, decision or accepted contract says something must happen and nothing in the change does it (or something does the opposite). Decided by reading the statement against the artefacts.',
    },
    'contract-semantics': {
        oracle: 'judgment',
        definition:
            'One term is used with two meanings across a boundary — a field, a state, a role, an assurance word — while each side is internally consistent, so no single-site test sees it.',
    },
} as const satisfies Record<string, DefectClassDefinition>;

export type DefectClass = keyof typeof DEFECT_CLASSES;

/** The vocabulary as a list, in declaration order, for a report or a brief. */
export function defectClasses(): Array<{ class: DefectClass; oracle: OracleType; definition: string }> {
    return (Object.keys(DEFECT_CLASSES) as DefectClass[]).map((name) => ({
        class: name,
        oracle: DEFECT_CLASSES[name].oracle,
        definition: DEFECT_CLASSES[name].definition,
    }));
}

export function isDefectClass(value: unknown): value is DefectClass {
    return typeof value === 'string' && Object.prototype.hasOwnProperty.call(DEFECT_CLASSES, value);
}

export function oracleFor(value: DefectClass): OracleType {
    return DEFECT_CLASSES[value].oracle;
}

/**
 * The class a finding declares, or a refusal that names both the offending value and the vocabulary it is not in.
 *
 * `where` is the finding the value came from, so the message points at the record rather than at the vocabulary — the
 * "a refusal names its subject" rule this repository keeps having to relearn.
 */
export function requireDefectClass(value: unknown, where: string): DefectClass {
    if (isDefectClass(value)) return value;
    throw new Error(
        `${where} carries class "${String(value)}", which is not in the defect-class vocabulary (${Object.keys(DEFECT_CLASSES).join(', ')}); `
        + 'name the class the defect belongs to, or omit the field — a value that is close to one of these is worse than none, '
        + 'because it makes the class register wrong rather than incomplete',
    );
}

/**
 * **The classes a plan declares, read once for every consumer.**
 *
 * The declaration has two readers — the ledger's decision (which reports a missing instrument as a deficit) and the review
 * request (which names the missing generators in the brief) — and they were written twice: one guarded with `Array.isArray`
 * and answered "nothing declared" for a plan whose `defectClasses` is not an array, while the other inlined a filter that
 * threw a raw `TypeError` for the same document. That is this module's own subject (`one-fact-derived-twice`), measured by an
 * independent round on the change that introduced it. Both now ask this function.
 *
 * A document this cannot understand is answered as "nothing declared" rather than by guessing: the plan is already refused by
 * name where it matters (`buildReviewRequest` names an unreadable plan), and inventing a declaration here would make this the
 * second reader deciding what the change is about.
 */
export interface DeclaredDefectClass {
    class: string;
    oracle: OracleType;
    generator?: string;
    relation?: string;
}

export function declaredDefectClasses(plan: unknown): DeclaredDefectClass[] {
    const document = plan as { defectClasses?: unknown } | null | undefined;
    const declared = document?.defectClasses;
    if (!Array.isArray(declared)) return [];
    return declared
        .filter((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null && !Array.isArray(entry))
        .filter((entry) => typeof entry.class === 'string')
        .map((entry) => ({
            class: entry.class as string,
            oracle: entry.oracle === 'mechanizable' ? 'mechanizable' : 'judgment',
            ...(typeof entry.generator === 'string' ? { generator: entry.generator } : {}),
            ...(typeof entry.relation === 'string' ? { relation: entry.relation } : {}),
        }));
}

/**
 * **Naming a machine is not having one.** A declaration says `mechanizable` and names a generator; a generator that does not
 * exist, or that names a directory, cannot decide anything, so it is reported exactly like a missing one — the first version
 * tested for the presence of a *string* and accepted a path to nothing (measured by an independent round).
 *
 * Resolution is against the workspace, and the file must be a regular file: a directory is not an instrument, and neither is
 * a name that resolves nowhere.
 */
export function instrumentResolves(root: string, generator: string): boolean {
    const candidate = generator.trim();
    if (candidate === '') return false;
    const resolved = resolve(root, candidate);
    // **Inside the workspace, and inside the surface that is sampled.** A file inside `.git/` resolves and is a regular
    // file, yet it is excluded from the declared/sampled surface, so an instrument living there would be one no change can
    // carry — measured by an independent round (R3-F4). The policy that says what is content is asked rather than guessed,
    // so this cannot drift from the walk.
    const relative = relativePath(root, resolved);
    if (relative === null) return false;
    if (isIgnoredRepositoryPath(relative)) return false;
    try {
        return statSync(resolved).isFile();
    } catch {
        return false;
    }
}

/** The workspace-relative path, or `null` when the path is outside the workspace entirely. */
function relativePath(root: string, path: string): string | null {
    const rootPrefix = root.endsWith(sep) ? root : root + sep;
    if (path === root) return '';
    if (!path.startsWith(rootPrefix)) return null;
    return path.slice(rootPrefix.length).split(sep).join('/');
}

/**
 * The declared mechanizable classes whose instrument is missing or does not resolve, with the reason — one derivation for the
 * deficit (the ledger's decision) and for the brief (the review request's `missingGenerators`).
 */
export function unbackedDefectClasses(
    classes: readonly DeclaredDefectClass[],
    root: string,
): Array<{ class: string; generator?: string; because: string }> {
    return classes
        .filter((entry) => entry.oracle === 'mechanizable')
        .map((entry) => {
            const generator = entry.generator;
            if (generator === undefined || generator.trim() === '') {
                return { class: entry.class, because: 'no generator is named, so nothing can decide this class' };
            }
            if (!instrumentResolves(root, generator)) {
                return { class: entry.class, generator, because: `the generator \`${generator}\` does not resolve to a file in this workspace, so nothing can decide this class` };
            }
            return undefined;
        })
        .filter((entry): entry is { class: string; generator?: string; because: string } => entry !== undefined);
}
