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
import { declaredPaths, freezeSubject, readProbes, readProbeAnswers, readLedger, readPlan } from './ledger.js';
import { strengthOf } from '../kernel/evidence.js';
import { diffSubjects } from '../kernel/subject.js';
import { readCurrentTaskRevisionState } from '../workflow/revision.js';
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
    // **The request speaks for the sealed revision, or it is not handed to a reviewer at all.** Measured by an independent
    // review on a real flow: this function copied `ledger.subject.revision` straight into the request, and the frozen
    // subject was 20 files behind the sealed revision — so the reviewer was given a brief for content that was no longer
    // the change. Binding the *result* to the current revision (which the result path already did) cannot catch that: the
    // input was wrong before the result existed. Freezing does not move on its own, so the mismatch is a real state and
    // the refusal names the remedy rather than handing over a stale brief.
    // **Compared against the content on disk, not against the seal's own snapshot.** Two facts make the obvious
    // comparisons useless, both measured: the subject's `rev:<digest-of-digests>` and the revision's `revision-<digest>`
    // are different derivations of the same content, so comparing the strings refuses every honest request; and the
    // revision's `contentDigests` records the paths *changed at seal time*, so comparing it to the subject's declared
    // roll-up compares two snapshots taken at the same moment and can never see a later edit. What the request has to
    // speak for is the content as it is now, so the freeze is re-derived from the declaration and compared — the same
    // measurement `ledger plan` and `ledger status` already make, so the three cannot disagree about drift.
    const current = await freezeSubject({ root: input.root, paths: await declaredPaths(input.root, input.changeId) });
    if (!current.ok) {
        return { ok: false, why: `the declared paths cannot be read, so a request cannot speak for the content: ${current.error}` };
    }
    if (current.subject.revision !== ledger.subject.revision) {
        const diff = diffSubjects(ledger.subject, current.subject);
        const moved = [...diff.changed, ...diff.added, ...diff.removed];
        return {
            ok: false,
            why: `the frozen subject describes content that has moved since it was frozen`
                + (moved.length > 0 ? ` (${moved.slice(0, 3).join(', ')}${moved.length > 3 ? ', …' : ''})` : '')
                + ': the request would brief a reviewer on content that is no longer the change. Re-freeze with `kata-cli ledger freeze --change <id>` first',
        };
    }
    // The seal has to exist too: a request that speaks for content nobody sealed is a brief for a revision the workflow
    // has not accepted, and the reviewer's result could not bind to anything.
    const sealed = await readCurrentTaskRevisionState(input.root, input.changeId);
    if (sealed.kind === 'unreadable') {
        return { ok: false, why: `the sealed revision cannot be read (${sealed.detail}); a request has to speak for the content under review` };
    }
    if (sealed.kind === 'absent') {
        return { ok: false, why: 'nothing is sealed for this change, so there is no revision the request can speak for: run `kata-cli build --seal` first' };
    }
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
    const { claimDecisions } = await import('./verdict.js');
    const decisions = new Map(claimDecisions(ledger).map((decision) => [decision.claimId, decision]));
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
            // **Asked of the kernel, not of the verdict list.** This read `verdicts.find(verdict === 'supported')` and
            // called that "the claim holds", which is a second derivation of the question `unsupportedClaims` answers: a
            // supported verdict at a strength below what the claim's severity requires reads as satisfied here and as a
            // deficit there. The gap message says which of the two facts is missing, because "not checked" and "checked
            // and not enough" are different instructions.
            const decision = decisions.get(claim.id);
            if (decision === undefined || decision.state !== 'supported') {
                gaps.push({
                    claimId: claim.id,
                    what: decision === undefined
                        ? 'this claim has no decision, so the evidence the request asked for has not been judged'
                        : `the claim is ${decision.state} (${decision.reasons.map((reason) => reason.code).join(', ') || 'no reason recorded'}), so the evidence the request asked for does not yet support it`,
                });
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
