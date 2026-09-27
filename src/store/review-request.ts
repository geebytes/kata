/**
 * The review request: what a round is handed, derived from the plan and checked when it comes back.
 *
 * **Why this exists.** `plan` computed reading sets, the required evidence types and the deadline, and wrote them to
 * `plan.json` — and nothing consumed them. A review was dispatched by a human writing a prompt from memory, which is how
 * the same requirement had to be carried by hand for a day while twenty-eight rounds produced no record. A plan nobody
 * hands to anyone is a printout; this is the action that hands it.
 *
 * **What a request contains, and each part's reason.** The reading set (the claim's own paths, so the reviewer's context is
 * decided by the claim rather than by the whole change), the evidence types the tier requires *for this claim*, the
 * deadline as a number, and the probe set if one was asked — because the question a reviewer must answer is part of what it
 * is given, and handing over the reading set without the questions would be handing over material and hoping.
 *
 * **What it deliberately does not contain.** No platform, no session, no model, no receipt. Those are the assurance axis,
 * and a request that named them would put the process back inside the criteria — which is the coupling the clean-sheet
 * design exists to remove. The request is a document a person or any tool can act on.
 *
 * **The check on the way back.** `verifyAgainstRequest` compares the plan with what arrived: every required type has at
 * least one evidence item, the reading set was not exceeded by what the reviewer cited, and the probes were answered. A
 * gap is named rather than scored, for the same reason the decision names its reasons.
 */
import { readProbes, readProbeAnswers, readLedger, readPlan } from './ledger.js';
import { strengthOf } from '../kernel/evidence.js';
import type { EvidenceType } from '../kernel/types.js';

export type ClaimRequest = {
    claimId: string;
    statement: string;
    /** The paths this claim's reading set names — what the reviewer is asked to read, not the whole change. */
    readingSet: string[];
    /** Evidence types the tier requires, strongest first, with the minimum strength the claim's severity demands. */
    requiredEvidence: { types: EvidenceType[]; minimumStrength: number };
};

export type ReviewRequest = {
    version: 1;
    changeId: string;
    subjectRevision: string;
    tier: string;
    /** The one number the brief has always carried: derived from the recorded baseline, `null` when there is none. */
    deadlineToolCalls: number | null;
    claims: ClaimRequest[];
    /** The probes a reviewer must answer, when any were asked. */
    probes: Array<{ id: string; claimId: string; command: string }>;
    note: string;
};

export type RequestGap = { claimId: string | null; what: string };

/** Assemble the request from what the planner already decided and what the ledger holds. */
export async function buildReviewRequest(input: { root: string; changeId: string }): Promise<
    | { ok: true; request: ReviewRequest }
    | { ok: false; why: string }
> {
    const ledger = await readLedger(input.root, input.changeId);
    if (ledger.subject === null) return { ok: false, why: 'the subject is not frozen' };
    const stored = await readPlan(input.root, input.changeId);
    if (stored === null) return { ok: false, why: 'no plan has been stored: a request is derived from the plan, and without one there is nothing to hand over' };
    const plan = stored as {
        tier?: string;
        readingSets?: Array<{ claimId: string; paths: string[] }>;
        requiredEvidence?: Array<{ claimId: string; types: EvidenceType[]; minimumStrength: number }>;
        discovery?: { deadlineToolCalls: number | null };
    };
    const readingById = new Map((plan.readingSets ?? []).map((set) => [set.claimId, set.paths]));
    const requiredById = new Map((plan.requiredEvidence ?? []).map((entry) => [entry.claimId, entry]));
    const probes = await readProbes(input.root, input.changeId);

    return {
        ok: true,
        request: {
            version: 1,
            changeId: input.changeId,
            subjectRevision: ledger.subject.revision,
            tier: plan.tier ?? 'unknown',
            deadlineToolCalls: plan.discovery?.deadlineToolCalls ?? null,
            claims: ledger.claims.map((claim) => ({
                claimId: claim.id,
                statement: claim.statement,
                readingSet: readingById.get(claim.id) ?? [],
                requiredEvidence: requiredById.get(claim.id) ?? { types: [], minimumStrength: 0 },
            })),
            probes: probes.map((probe) => ({ id: probe.id, claimId: probe.claimId, command: probe.command })),
            note: 'the reading set comes from the plan, the deadline from the recorded baseline, and the probes from the ledger; a request carries no platform, session or model, because those are the assurance axis and not a criterion',
        },
    };
}

/**
 * What the plan asked for and what arrived, compared by name.
 *
 * This is the action the plan was missing: a request that is checked rather than a prompt that is hoped for. A gap is
 * `{ claimId, what }` so the reader knows which claim and which requirement, and an empty list is the only reading of
 * "the request was satisfied".
 */
export async function verifyAgainstRequest(input: { root: string; changeId: string }): Promise<{ gaps: RequestGap[] }> {
    const ledger = await readLedger(input.root, input.changeId);
    const built = await buildReviewRequest(input);
    if (!built.ok) return { gaps: [{ claimId: null, what: built.why }] };
    const answers = await readProbeAnswers(input.root, input.changeId);
    const answered = new Set(answers.map((answer) => answer.probeId));
    const gaps: RequestGap[] = [];

    for (const claimRequest of built.request.claims) {
        const claim = ledger.claims.find((entry) => entry.id === claimRequest.claimId);
        if (claim === undefined) continue;
        const held = new Set(
            claim.evidenceIds
                .map((id) => ledger.evidence.find((item) => item.id === id))
                .filter((item): item is NonNullable<typeof item> => item !== undefined)
                .map((item) => item.type),
        );
        for (const type of claimRequest.requiredEvidence.types) {
            // The required set is ordered strongest first and a stronger type satisfies the requirement: a falsifier is
            // acceptable where a static witness was asked for, and the reverse is not.
            const satisfied = [...held].some((have) => strengthOf(have) >= strengthOf(type));
            if (!satisfied) {
                gaps.push({ claimId: claim.id, what: `no evidence of ${type} or stronger: the tier requires it and the claim holds ${[...held].join(', ') || 'nothing'}` });
                break;
            }
        }
        // The reading set is a *ceiling*: a reviewer that read more is not a violation, and one that read nothing outside
        // the set has answered from what it was given. What is a gap is a claim with no reading set at all, because then
        // nobody decided what the reviewer should read.
        if (claimRequest.readingSet.length === 0) {
            gaps.push({ claimId: claim.id, what: 'the stored plan names no reading set for this claim, so the request could not scope it' });
        }
        if (claimRequest.requiredEvidence.minimumStrength > 0) {
            const verdict = claim.evidenceIds
                .map((id) => ledger.verdicts.find((entry) => entry.evidenceId === id))
                .find((entry) => entry?.verdict === 'supported');
            if (verdict === undefined) {
                gaps.push({ claimId: claim.id, what: 'no supported verdict for this claim, so the evidence the request asked for has not been checked' });
            }
        }
    }
    for (const probe of built.request.probes) {
        if (!answered.has(probe.id)) {
            gaps.push({ claimId: probe.claimId, what: `the probe ${probe.id} was asked and not answered` });
        }
    }
    return { gaps };
}
