/**
 * Discovery: questions a claim's own dependency surface puts to the reviewer.
 *
 * **The problem this replaces.** `executedInFreshContext` was an agent's assertion about itself, and the receipt that
 * replaced it is a document only a host can author — which is why two strict changes were stuck for a day. The clean-sheet
 * reading is that a reviewer cannot prove its internals, so it should be asked something it can only answer by having
 * looked: a question **generated from the claim's dependency surface**, after the fact, which the reviewer was never told.
 * Answering it is readable audit history. `Challenge` records executable propositions that can satisfy a gate, so a probe has two
 * extra facts: it was **asked** (not authored), and it has an **answer state**.
 *
 * **Generation is deterministic and derived, never hand-written.** A question is drawn from the claim's own paths at a
 * recorded seed, so the same ledger asks the same questions and a reviewer cannot be handed a softened set. What makes a
 * probe *answerable by looking* is that its assertion is about the **content of one path the claim rests on**: an
 * off-by-one in a digest, a literal that must or must not be present, a file that must exist. A reviewer that never opened
 * that path cannot answer it; one that did cannot fail to.
 *
 * **Trust boundary.** Kata records an answer but cannot authenticate its free-text observation. It therefore cannot prove
 * the reviewer read the path, nor can the answer decide a gate. Independent context remains the host assurance axis; a
 * mutation-backed challenge plus a supported verifier run is the repository-side discovery evidence.
 */
import type { Claim, Subject } from './types.js';

export type ProbeKind = 'file-exists' | 'literal-present' | 'literal-absent' | 'digest-prefix';

export type Probe = {
    id: string;
    claimId: string;
    kind: ProbeKind;
    /** The path the claim rests on that this probe asks about. */
    path: string;
    /** A literal the probe asks about, for the three literal kinds. */
    literal?: string;
    /** The short digest prefix the probe asks for, for `digest-prefix`. */
    prefix?: string;
    /** The command that answers it: exit 0 means the asked-about fact holds. */
    command: string;
    askedAt: string;
    /**
     * **The revision this question was derived from.**
     *
     * A probe is a fact about one revision's content: the digest it asks for, the file it asks about. Without the revision
     * on the record, an answer could be carried over to a subject it says nothing about — and a later revision that moved
     * the file would inherit a reading about the content that preceded it.
     *
     * Absent means a legacy record: still readable, and ineligible as a reading about the current content.
     */
    subjectRevision?: string;
};

export type ProbeAnswer = {
    probeId: string;
    /** Advisory audit history reported by the reviewer; it is not authenticated gate evidence. */
    command: string;
    observed: string;
    answeredAt: string;
    /** The revision whose question this answer is about, copied from the probe it answered. */
    subjectRevision?: string;
    /** The path the question asked about, copied so the answer can be checked against the question rather than trusted. */
    path?: string;
    /** The fact the question asked for (a digest prefix, a literal, or `exists`), copied for the same reason. */
    expected?: string;
};

/**
 * A deterministic pseudo-random draw.
 *
 * No clock and no entropy: the same (seed, index) yields the same choice, so a probe set is reproducible from the ledger
 * alone and cannot be softened for the round being asked. `Math.random` is banned in `src/kernel`, and this is the reason
 * the ban exists rather than an exception to it.
 */
function draw(seed: string, index: number, bound: number): number {
    let hash = 2_166_136_261;
    const material = `${seed}:${index}`;
    for (let position = 0; position < material.length; position += 1) {
        hash ^= material.charCodeAt(position);
        hash = Math.imul(hash, 16_777_619) >>> 0;
    }
    return bound === 0 ? 0 : hash % bound;
}

/** The paths a claim rests on, in a stable order, so a probe set is reproducible. */
function surfacesOf(claim: Claim, subject: Subject): string[] {
    const declared = claim.dependsOn
        .filter((dep): dep is `path:${string}` => dep.startsWith('path:'))
        .map((dep) => dep.slice('path:'.length))
        // A dependency that is not in the subject cannot be asked about; the decision refuses it as unresolvable, and a
        // probe about a path that does not exist would be a question with one honest answer — "it is not there" — which
        // measures nothing. So the surface is the intersection.
        .filter((path) => Object.prototype.hasOwnProperty.call(subject.pathDigests, path));
    return [...new Set(declared)].sort();
}

/**
 * Generate the probe set for a claim.
 *
 * One probe per **distinct** requested question, each drawn from the claim's surface at the seed. A claim whose surface is
 * empty gets no probes — and that is reported by the caller rather than padded, because a padded probe would be a question
 * nobody can answer from looking.
 *
 * **Distinct, because a repeated question is not a second reading.** Measured on a real change: asking two questions per
 * claim produced six probes of which three were duplicates — `P1-AC-1` and `P2-AC-1` carried the same kind, the same path
 * and therefore the same command — and a duplicated question would have let one answer be counted as two. (The floor no
 * longer reads probe answers at all — a free-text answer cannot be authenticated, so it is audit history — but the rate
 * this feeds is still a count of distinct questions, because repetition is not a second reading there either.) A count
 * inflated by repetition is not a count of independent readings, which is the one thing this mechanism exists to supply;
 * the draws advance past a question already asked, and a claim whose surface cannot supply the number asked for simply
 * gets fewer, which the caller reports.
 */
export function probesFor(input: {
    claim: Claim;
    subject: Subject;
    seed: string;
    count: number;
    askedAt: string;
}): Probe[] {
    const surface = surfacesOf(input.claim, input.subject);
    if (surface.length === 0 || input.count <= 0) return [];
    const kinds: ProbeKind[] = ['file-exists', 'digest-prefix', 'file-exists'];
    const probes: Probe[] = [];
    const asked = new Set<string>();
    // Bounded attempts: the (path, kind) space is finite, so a request for more distinct questions than it holds must end
    // rather than spin. Six attempts per wanted question is generous for the surfaces real claims have (a handful of paths).
    const attempts = input.count * 6 + kinds.length * surface.length;
    for (let index = 0; index < attempts && probes.length < input.count; index += 1) {
        const path = surface[draw(input.seed, index * 3, surface.length)]!;
        const kind = kinds[draw(input.seed, index * 3 + 1, kinds.length)]!;
        const identity = `${kind}:${path}`;
        if (asked.has(identity)) continue;
        asked.add(identity);
        const digest = input.subject.pathDigests[path] ?? '';
        // The command asks about **content of one path the claim rests on**, in a form that cannot be answered from the
        // claim's own text: the file's presence, and the first eight characters of its recorded digest.
        const prefix = digest.slice(0, 8);
        const command = kind === 'file-exists'
            ? `test -f ${path}`
            : `test "$(node -e "process.stdout.write(require('node:crypto').createHash('sha256').update(require('node:fs').readFileSync('${path}')).digest('hex').slice(0,8))")" = "${prefix}"`;
        probes.push({
            id: `P${probes.length + 1}-${input.claim.id}`,
            claimId: input.claim.id,
            kind,
            path,
            ...(kind === 'digest-prefix' ? { prefix } : {}),
            command,
            askedAt: input.askedAt,
            subjectRevision: input.subject.revision,
        });
    }
    return probes;
}

/**
 * The response rate: answered probes over asked ones.
 *
 * Reported as `null` when nothing was asked, never as zero: an empty denominator is an unmeasured question, and the same
 * rule applies here as to every other rate in this subsystem.
 */
export function responseRate(input: { asked: number; answered: number }): number | null {
    if (input.asked === 0) return null;
    return Math.min(1, Math.max(0, input.answered / input.asked));
}
