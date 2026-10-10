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
 * **The check on the way back.** `verifyAgainstRequest` compares the plan with what arrived: every claim the request carries
 * has evidence of a required type at or above its strength, the kernel's own decision on that claim is not a refusal, and the
 * planned reading set is present. A gap is named rather than scored, for the same reason the decision names its reasons.
 * Two limits are deliberate: a claim the plan names but the ledger does not hold is dropped when the request is built (the
 * request speaks for the ledger, and `ledger claim add` is the remedy, not a gap here), and probe answers are **not** checked —
 * they are audit history, and approval must never rest on free text the reviewed party wrote.
 */
import { declaredDefectClasses, unbackedDefectClasses } from '../quality/defect-classes.js';
import { readReviewRoundsState } from '../quality/repair.js';
import { replayLoop } from '../quality/loop-replay.js';
import { planDigestOf, questionForComparison, declaredPaths, freezeSubject, readLedger, readPlanState, readProbesState } from './ledger.js';
import { strengthOf } from '../kernel/evidence.js';
import { diffSubjects } from '../kernel/subject.js';
import { readCurrentTaskRevisionState, revisionIsCurrent, revisionStatus } from '../workflow/revision.js';
import type { EvidenceType } from '../kernel/types.js';

export type ClaimRequest = {
    claimId: string;
    statement: string;
    /** The paths this claim's reading set names — what the reviewer is asked to read, not the whole change. */
    readingSet: string[];
    /** Evidence types the tier requires, strongest first, with the minimum strength the claim's severity demands. */
    requiredEvidence: { types: EvidenceType[]; minimumStrength: number };
    /**
     * The judged domain this claim closes over, when it declares one.
     *
     * **Carried, not summarised.** The reviewer decides whether what they found is inside the claim, so the boundary they
     * judge against has to be the author's own words on the claim they are judging; a paraphrase in a brief would be a
     * second statement of the same boundary.
     */
    boundary?: string;
};

export type ReviewRequest = {
    version: 1;
    changeId: string;
    subjectRevision: string;
    tier: string;
    /** The one number the brief has always carried: derived from the recorded baseline, `null` when there is none. */
    deadlineToolCalls: number | null;
    claims: ClaimRequest[];
    /** The probes a reviewer must answer, when any were asked — and only those asking about this revision. */
    probes: Array<{ id: string; claimId: string; command: string }>;
    /**
     * **The questions this request did not hand over, because they ask about another revision.**
     *
     * A probe keeps the revision it was derived from, so a stored set is a history: when the content moves, a question can
     * survive whose expected digest no longer describes the file it names. Handing that over asks the reviewer to do work
     * that cannot succeed. Present only when non-empty, the same shape as `unreadableArtefacts`: an absent field means the
     * brief withheld nothing, and an entry here means the reviewer is looking at a request built around a hole.
     */
    withheldProbes?: Array<{ id: string; claimId: string; subjectRevision: string | null }>;
    note: string;
};

export type RequestGap = { claimId: string | null; what: string };

/** Assemble the request from what the planner already decided and what the ledger holds. */
export async function buildReviewRequest(input: {
    root: string;
    changeId: string;
    /** The caller's own read of the pointer, so the request speaks for the revision that was decided on. */
    sealedRead?: Awaited<ReturnType<typeof readCurrentTaskRevisionState>>;
}): Promise<
    | { ok: true; request: ReviewRequest }
    | { ok: false; why: string }
> {
    const ledger = await readLedger(input.root, input.changeId);
    if (ledger.subject === null) return { ok: false, why: 'the subject is not frozen' };
    // **An unreadable plan is not an absent one.** `readPlan` answers `null` for both, so a corrupt `plan.json` was reported
    // as "no plan has been stored" — a claim about the content — and the brief handed to a reviewer was built from that
    // answer. The two states are named separately.
    const storedPlan = await readPlanState(input.root, input.changeId);
    if (storedPlan.kind === 'unreadable') return { ok: false, why: `plan.json exists and cannot be read (${storedPlan.detail})` };
    if (storedPlan.kind === 'absent') return { ok: false, why: 'no plan has been stored: a request is derived from the plan, and without one there is nothing to hand over' };
    const stored = storedPlan.value;
    const plan = stored as {
        tier?: string;
        readingSets?: Array<{ claimId: string; paths: string[] }>;
        requiredEvidence?: Array<{ claimId: string; types: EvidenceType[]; minimumStrength: number }>;
        discovery?: { deadlineToolCalls: number | null };
        /** The defect classes the change declared on its plan, each with the generator the class's oracle needs. */
        defectClasses?: Array<{ class: string; oracle?: string; generator?: string; relation?: string }>;
    };
    // **Which declared classes have no instrument, named in the request.** A class declared `mechanizable` without a generator
    // is a class that will be paid for by independent rounds instead of by a machine, so the round is *briefed* about it
    // rather than surprised by it — and `decide` reports the same gap as a deficit (the operator chose the report-and-route
    // form over refusing to dispatch).
    // **The same derivation the decision uses.** These were two copies, and they disagreed on a plan whose `defectClasses`
    // is not an array — this one threw a raw `TypeError` where the decision answered "nothing declared" (measured by an
    // independent round; the defect class is the one this change exists to name).
    // **The loop's own record, handed to the round that has to live with it.** `replayLoop` was computed and read by nothing
    // in production (measured twice by independent rounds: first "computed, nobody reads it", then "published, nobody reads
    // it"). The reviewer is its real consumer — the shares and the stop-line classes are exactly what a round needs to tell
    // "this loop is recycling its own repairs" from "this class keeps turning up in the original code".
    const roundsRead = await readReviewRoundsState(input.root, input.changeId);
    const loopReplay = roundsRead.kind === 'readable' ? replayLoop(roundsRead.rounds) : null;
    const declaredClasses = declaredDefectClasses(stored);
    const declaredForInstruments = await declaredPaths(input.root, input.changeId);
    const missingGenerators = (await unbackedDefectClasses(declaredClasses, input.root, declaredForInstruments)).map((entry) => entry.class);
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
    const ledgerForDrift = await readLedger(input.root, input.changeId);
    const current = await freezeSubject({
        root: input.root,
        paths: await declaredPaths(input.root, input.changeId),
        ...questionForComparison(ledgerForDrift.subject, ledgerForDrift.claims, await planDigestOf(input.root, input.changeId)),
    });
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
    const sealed = input.sealedRead ?? await readCurrentTaskRevisionState(input.root, input.changeId);
    if (sealed.kind === 'unreadable') {
        return { ok: false, why: `the sealed revision cannot be read (${sealed.detail}); a request has to speak for the content under review` };
    }
    if (sealed.kind === 'absent') {
        return { ok: false, why: 'nothing is sealed for this change, so there is no revision the request can speak for: run `kata-cli build --seal` first' };
    }
    // **The seal's own content, compared too.** F-2: the two checks above were independent facts — "the subject matches the
    // content" and "a seal exists" — so freeze(A) → seal(revA) → edit a file → freeze(revB) → run passed and produced
    // `subjectRevision = revB` while the reviewer's result would bind to revA. The request and the result have to speak
    // for one revision, so the sealed revision's contents are compared as well; `status` is the seal's own answer about
    // whether what it hashed is still what is on disk.
    const sealedStatus = await revisionStatus(input.root, sealed.revision, input.changeId);
    if (!revisionIsCurrent(sealedStatus)) {
        // **The refusal names the state it measured, and the two states are different facts.** R5: the status is an object,
        // so interpolating it printed `[object Object]` — the refusal hid what it had just measured — and the wording
        // hard-coded "content has changed" for a `declaration-moved` revision, which `revision.ts` is explicit is a
        // different fact (the manifest hash cannot see it, because that hash is taken over the old declaration).
        // Narrowed structurally rather than asserted away: the two non-current states carry different facts, and
        // reading them off the union's own discriminant is what keeps the message honest about which one was measured.
        const because = sealedStatus.status === 'declaration-moved'
            ? `the task's declaration has moved since it was sealed (added: ${sealedStatus.added.join(', ') || 'none'}; removed: ${sealedStatus.removed.join(', ') || 'none'})`
            : 'the content under its declared paths has changed since it was sealed';
        return {
            ok: false,
            why: `the sealed revision ${sealed.revision.id} is ${sealedStatus.status}: ${because}, `
                + 'so a request derived now would name content the reviewer could not bind a result to. Re-seal '
                + '(`kata-cli build --change <id> --seal`) after the content or the declaration is settled',
        };
    }
    const readingById = new Map((plan.readingSets ?? []).map((set) => [set.claimId, set.paths]));
    const requiredById = new Map((plan.requiredEvidence ?? []).map((entry) => [entry.claimId, entry]));
    // **A brief that silently omits what it could not read is a brief about a different ledger.** `readProbes` answers `[]`
    // for a file that exists and cannot be decoded, so the request carried no probes and said nothing about why. The
    // artefacts that could not be read travel with the request now, so the reviewer sees the state rather than an absence.
    const probesRead = await readProbesState(input.root, input.changeId);
    const probes = probesRead.kind === 'usable' ? probesRead.value : [];
    // **A request asks about one revision.** A stored question keeps the revision it was derived from, so the set is a
    // history: the same id can survive a move and ask about a digest the file no longer has — measured, a request built at
    // `rev:7ea2ab14145fe8c5` still handed the reviewer two questions stored against `rev:93208fecfaab9f0b`, one of them
    // expecting a prefix the file had lost. A question that cannot be answered truthfully is not handed over, and the
    // withholding is named rather than silent: an empty `probes` array would otherwise read as "nothing was asked".
    // The same rule `ledger ask` uses for "already asked": only a question bound to the current revision is current.
    // Read into a local because the narrowing above is a property access: TypeScript drops it inside a callback, and the
    // callbacks below are where it is needed.
    const currentRevision = ledger.subject.revision;
    const currentProbes = probes.filter((probe) => probe.subjectRevision === currentRevision);
    const withheldProbes = probes
        .filter((probe) => probe.subjectRevision !== currentRevision)
        .map((probe) => ({
            id: probe.id,
            claimId: probe.claimId,
            // `null` is a record written before a probe carried the revision at all: it cannot be shown to be current.
            subjectRevision: typeof probe.subjectRevision === 'string' ? probe.subjectRevision : null,
        }));
    const unreadableArtefacts = [...new Set([
        ...(probesRead.kind === 'unreadable' ? [probesRead.file] : []),
        ...ledger.malformedFiles,
    ])];

    return {
        ok: true,
        request: {
            version: 1,
            changeId: input.changeId,
            subjectRevision: ledger.subjectAsDeclared?.revision ?? ledger.subject.revision,
            tier: plan.tier ?? 'unknown',
            ...(declaredClasses.length > 0 ? { defectClasses: declaredClasses } : {}),
            ...(missingGenerators.length > 0 ? { missingGenerators } : {}),
            // The loop's record for this change, so the round can tell "we are fixing our own fixes" from "this class keeps
            // appearing in the original code" — the reading AC-6 exists to publish, handed to its real consumer.
            ...(loopReplay === null ? {} : { loopReplay }),
            deadlineToolCalls: plan.discovery?.deadlineToolCalls ?? null,
            // Present only when something could not be read: an absent field means the brief describes a ledger that was
            // fully readable, and a name here means the reviewer is looking at a request built around a hole.
            ...(unreadableArtefacts.length === 0 ? {} : { unreadableArtefacts }),
            claims: ledger.claims.map((claim) => ({
                claimId: claim.id,
                statement: claim.statement,
                readingSet: readingById.get(claim.id) ?? [],
                requiredEvidence: requiredById.get(claim.id) ?? { types: [], minimumStrength: 0 },
                ...(claim.boundary === undefined ? {} : { boundary: claim.boundary }),
            })),
            probes: currentProbes.map((probe) => ({ id: probe.id, claimId: probe.claimId, command: probe.command })),
            // Present only when something was withheld, for the same reason `unreadableArtefacts` is: an absent field means
            // the brief describes a question set that was fully current.
            ...(withheldProbes.length === 0 ? {} : { withheldProbes }),
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
export async function verifyAgainstRequest(input: {
    root: string;
    changeId: string;
    /** Passed through to the builder, so the handshake is checked against the revision the caller decided on. */
    sealedRead?: Awaited<ReturnType<typeof readCurrentTaskRevisionState>>;
}): Promise<{ gaps: RequestGap[] }> {
    const ledger = await readLedger(input.root, input.changeId);
    const built = await buildReviewRequest(input);
    if (!built.ok) return { gaps: [{ claimId: null, what: built.why }] };
    const { claimDecisions } = await import('./verdict.js');
    const decisions = new Map(claimDecisions(ledger).map((decision) => [decision.claimId, decision]));
    // Probe answers are advisory audit history. Approval must never depend on self-reported free text.
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
    return { gaps };
}
