/**
 * The inline adapter — verdicts decided by running the artifact, in this process.
 *
 * This is the observed route: commands run here, the mutation is applied and restored here, and the verdict records what
 * happened. It claims only the capabilities it uses.
 */
import type { Evidence, EvidenceVerdict } from '../../kernel/types.js';
import type { EvidenceAdapter, VerifyContext } from '../../producers/port.js';
import { verifierFor } from '../../producers/verifiers.js';

export function createInlineAdapter(): EvidenceAdapter {
    return {
        id: 'inline',
        assurance: 'observed',
        capabilities: ['executes_commands', 'reads_files', 'restores_after_mutation', 'counts_its_own_work'],
        verify: async (evidence: Evidence, context: VerifyContext): Promise<EvidenceVerdict> => {
            const verifier = verifierFor(evidence.type);
            if (!verifier) {
                return {
                    evidenceId: evidence.id,
                    evidenceType: evidence.type,
                    verdict: 'inconclusive',
                    observed: `no verifier is registered for ${evidence.type}`,
                    at: context.now(),
                    verifier: 'assurance/adapters/inline',
                    subjectRevision: context.subject.revision,
                };
            }
            return verifier.verify(evidence, context);
        },
    };
}
