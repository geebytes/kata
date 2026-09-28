/**
 * Verifiers — one per evidence type. A verifier decides; it never proposes.
 *
 * The command-backed type is the falsifier, and it is the three-step protocol this repository already measured: run the
 * check clean, inject the defect, watch the check redden, restore, watch it pass again. The point of the second and
 * third steps is the one the old ledger recorded as `did_not_redden` — a check that does not redden under its own defect
 * proves nothing, and a check that is already failing proves something else entirely. It is the **only** type that runs
 * a command, which is what makes the mutation requirement structural rather than a rule to remember.
 */
import type { Evidence, EvidenceVerdict } from '../kernel/types.js';
import type { CommandOutcome, EvidenceVerifier, VerifyContext } from './port.js';

function makeVerdict(input: {
    evidence: Evidence;
    context: VerifyContext;
    verdict: EvidenceVerdict['verdict'];
    observed: string;
    verifier: string;
}): EvidenceVerdict {
    return {
        evidenceId: input.evidence.id,
        evidenceType: input.evidence.type,
        verdict: input.verdict,
        observed: input.observed,
        at: input.context.now(),
        verifier: input.verifier,
        subjectRevision: input.context.subject.revision,
        // **Stamped by the context, not by the verifier.** The party that decided is supplied by the adapter that hosted
        // the run, which is what keeps a quorum possible: `groupByProducer` can only tell two readings from one if the
        // reading names the run that produced it, and a verifier that filled this in from its own name would make two
        // runs of one adapter look like one producer.
        producer: input.context.producer(),
    };
}

function outcomeLine(outcome: CommandOutcome): string {
    const tail = (outcome.stderr || outcome.stdout).trim().split('\n').slice(-1)[0] ?? '';
    return `exit ${outcome.code}${outcome.timedOut ? ' (timed out)' : ''}${tail === '' ? '' : `: ${tail.slice(0, 200)}`}`;
}

const staticWitness: EvidenceVerifier = {
    type: 'static_witness',
    verifier: 'producers/verifiers#static-witness',
    verify: async (evidence, context) => {
        if (evidence.type !== 'static_witness') throw new Error('static witness verifier received another type');
        const content = await context.readText(evidence.ref);
        if (content === null) {
            return makeVerdict({ evidence, context, verdict: 'inconclusive', observed: `${evidence.ref} does not exist at this subject`, verifier: staticWitness.verifier });
        }
        const [kind, ...rest] = evidence.assertion.split(':');
        const literal = rest.join(':');
        const present = content.includes(literal);
        const holds = kind === 'contains' ? present : !present;
        return makeVerdict({
            evidence,
            context,
            verdict: holds ? 'supported' : 'refuted',
            observed: `${evidence.ref} ${present ? 'contains' : 'does not contain'} "${literal.slice(0, 120)}"`,
            verifier: staticWitness.verifier,
        });
    },
};

const crossArtifact: EvidenceVerifier = {
    type: 'cross_artifact_contradiction',
    verifier: 'producers/verifiers#cross-artifact',
    verify: async (evidence, context) => {
        if (evidence.type !== 'cross_artifact_contradiction') throw new Error('cross-artifact verifier received another type');
        const a = await context.readText(evidence.a);
        const b = await context.readText(evidence.b);
        if (a === null || b === null) {
            const missing = a === null ? evidence.a : evidence.b;
            return makeVerdict({ evidence, context, verdict: 'inconclusive', observed: `${missing} does not exist at this subject`, verifier: crossArtifact.verifier });
        }
        const inA = a.includes(evidence.literal);
        const inB = b.includes(evidence.literal);
        const holds = evidence.comparator === 'literal-in-a-not-b' ? inA && !inB : inB && !inA;
        return makeVerdict({
            evidence,
            context,
            verdict: holds ? 'supported' : 'refuted',
            observed: `${evidence.a} ${inA ? 'has' : 'lacks'} it, ${evidence.b} ${inB ? 'has' : 'lacks'} it`,
            verifier: crossArtifact.verifier,
        });
    },
};

/**
 * The falsifier: three steps whose whole value is that the second one can fail. A check that stays green when its defect
 * is injected is not sensitive to that defect, and one that is red before anything is injected is reporting a defect that
 * is already present — both are verdicts about the artifact, not about the check's paperwork.
 */
/**
 * The prefix a falsifier writes when its check could not be *evaluated* rather than when the mutation did not redden.
 *
 * Exported so the one consumer that needs to tell the two apart — `ledger replay` — reads a constant rather than a
 * sentence: the verdict is `refuted` in both cases, because the evidence item is invalid either way, but only one of them
 * means the claim is false.
 */
export const CHECK_CANNOT_RUN = 'the check was already failing before any mutation:';

const executableFalsifier: EvidenceVerifier = {
    type: 'executable_falsifier',
    verifier: 'producers/verifiers#executable-falsifier',
    verify: async (evidence, context) => {
        if (evidence.type !== 'executable_falsifier') throw new Error('falsifier verifier received another type');
        const before = await context.run(evidence.command);
        if (before.code !== 0) {
            return makeVerdict({
                evidence,
                context,
                verdict: 'refuted',
                // **Named, because a reader has to classify this case and prose matching is not a derivation.** The verdict
                // is `refuted` — the evidence item is not valid — but the *cause* is that the check could not be evaluated
                // at all, and that is a different fact from a claim being false. `ledger replay` reads this marker to split
                // "the record no longer holds" from "the record can no longer be checked": the same sentence used to be
                // matched by hand, and a reworded message would have silently moved every such item into the wrong bucket.
                observed: `${CHECK_CANNOT_RUN} ${outcomeLine(before)}`,
                verifier: executableFalsifier.verifier,
            });
        }

        const original = await context.readText(evidence.mutation.file);
        if (original === null) {
            return makeVerdict({ evidence, context, verdict: 'inconclusive', observed: `${evidence.mutation.file} does not exist`, verifier: executableFalsifier.verifier });
        }
        if (!original.includes(evidence.mutation.find)) {
            return makeVerdict({
                evidence,
                context,
                verdict: 'inconclusive',
                observed: `the mutation site is gone from ${evidence.mutation.file}, so this check can no longer be reddened`,
                verifier: executableFalsifier.verifier,
            });
        }

        try {
            await context.writeText(evidence.mutation.file, original.replace(evidence.mutation.find, evidence.mutation.replace));
            const mutated = await context.run(evidence.command);
            await context.writeText(evidence.mutation.file, original);
            const after = await context.run(evidence.command);
            const observed = JSON.stringify({ before: before.code, mutated: mutated.code, after: after.code });
            if (mutated.code === 0) {
                return makeVerdict({
                    evidence,
                    context,
                    verdict: 'refuted',
                    observed: `${observed} — the check did not redden under its own defect`,
                    verifier: executableFalsifier.verifier,
                });
            }
            if (after.code !== 0) {
                return makeVerdict({
                    evidence,
                    context,
                    verdict: 'inconclusive',
                    observed: `${observed} — the tree was not restored to green`,
                    verifier: executableFalsifier.verifier,
                });
            }
            return makeVerdict({ evidence, context, verdict: 'supported', observed, verifier: executableFalsifier.verifier });
        } catch (error) {
            await context.writeText(evidence.mutation.file, original);
            return makeVerdict({
                evidence,
                context,
                verdict: 'inconclusive',
                observed: `the mutation could not be run: ${(error as Error).message}`,
                verifier: executableFalsifier.verifier,
            });
        }
    },
};

/**
 * Concurrence is the weakest type on purpose: it records that independent reviewers agreed, and it carries the
 * acknowledgement receipt that makes the agreement auditable. The kernel refuses it for a blocking claim.
 */
const expertConcurrence: EvidenceVerifier = {
    type: 'expert_concurrence',
    verifier: 'producers/verifiers#expert-concurrence',
    verify: async (evidence, context) => {
        if (evidence.type !== 'expert_concurrence') throw new Error('concurrence verifier received another type');
        const ack = await context.readText(evidence.humanAck);
        if (ack === null || ack.trim() === '') {
            return makeVerdict({
                evidence,
                context,
                verdict: 'inconclusive',
                observed: `no acknowledgement receipt at ${evidence.humanAck}, so the concurrence is not auditable`,
                verifier: expertConcurrence.verifier,
            });
        }
        return makeVerdict({
            evidence,
            context,
            verdict: 'supported',
            observed: `${evidence.reviewers.length} reviewers concurred; receipt ${evidence.humanAck}`,
            verifier: expertConcurrence.verifier,
        });
    },
};

export const VERIFIERS: readonly EvidenceVerifier[] = [
    executableFalsifier,
    staticWitness,
    crossArtifact,
    expertConcurrence,
];

export function verifierFor(type: Evidence['type']): EvidenceVerifier | undefined {
    return VERIFIERS.find((entry) => entry.type === type);
}

/** One item, decided by the verifier registered for its type. */
async function verifyOne(item: Evidence, context: VerifyContext): Promise<EvidenceVerdict> {
    const verifier = verifierFor(item.type);
    if (!verifier) {
        return {
            evidenceId: item.id,
            evidenceType: item.type,
            verdict: 'inconclusive',
            observed: `no verifier is registered for ${item.type}`,
            at: context.now(),
            verifier: 'producers/verifiers',
            subjectRevision: context.subject.revision,
            producer: context.producer(),
        };
    }
    return verifier.verify(item, context);
}

/**
 * Verify a list, one verdict per item, in a stable order.
 *
 * A caller may supply its own decide-one function, which is how the CLI's adapter choice reaches this path: the adapter
 * is what makes the round observed or relayed, and the list walk should not exist twice.
 */
export async function verifyAll(
    evidence: readonly Evidence[],
    context: VerifyContext,
    verify?: (item: Evidence, context: VerifyContext) => Promise<EvidenceVerdict>,
): Promise<EvidenceVerdict[]> {
    const decideOne = verify ?? verifyOne;
    const verdicts: EvidenceVerdict[] = [];
    for (const item of evidence) verdicts.push(await decideOne(item, context));
    return verdicts;
}
