/**
 * Verifiers — one per evidence type. A verifier decides; it never proposes.
 *
 * The strongest of them is the falsifier, and it is the three-step protocol this repository already measured: run the
 * check clean, inject the defect, watch the check redden, restore, watch it pass again. The point of the second and
 * third steps is the one the old ledger recorded as `did_not_redden` — a check that does not redden under its own defect
 * proves nothing, and a check that is already failing proves something else entirely.
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

const invariantProof: EvidenceVerifier = {
    type: 'invariant_proof',
    verifier: 'producers/verifiers#invariant-proof',
    verify: async (evidence, context) => {
        if (evidence.type !== 'invariant_proof') throw new Error('invariant verifier received another type');
        const outcome = await context.run(evidence.command);
        return makeVerdict({
            evidence,
            context,
            verdict: outcome.code === 0 ? 'supported' : 'refuted',
            observed: `${evidence.invariantId}: ${outcomeLine(outcome)}`,
            verifier: invariantProof.verifier,
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
                observed: `the check was already failing before any mutation: ${outcomeLine(before)}`,
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
    invariantProof,
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
