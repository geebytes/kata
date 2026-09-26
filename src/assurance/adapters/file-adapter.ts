/**
 * The file adapter — verdicts read from results someone else recorded.
 *
 * This is the relayed route, and it is the second adapter the cross-adapter invariant needs: without two, "the kernel is
 * platform-neutral" would be a sentence about one implementation. It is deliberately weaker and says so — `relayed` —
 * and it refuses a result file that was recorded against a different revision, because a stale result cannot be allowed
 * to support a claim about a subject that moved.
 */
import type { Evidence, EvidenceVerdict, EvidenceType } from '../../kernel/types.js';
import type { EvidenceAdapter, VerifyContext } from '../../producers/port.js';

export type RecordedResult = {
    evidenceId: string;
    evidenceType: EvidenceType;
    verdict: EvidenceVerdict['verdict'];
    observed: string;
    subjectRevision: string;
    at?: string;
    verifier?: string;
};

export function createFileAdapter(input: { dir: string }): EvidenceAdapter {
    return {
        id: 'file',
        assurance: 'relayed',
        capabilities: ['reads_files'],
        verify: async (evidence: Evidence, context: VerifyContext): Promise<EvidenceVerdict> => {
            const path = `${input.dir}/${evidence.id}.json`;
            const raw = await context.readText(path);
            if (raw === null) {
                return verdictOf(evidence, context, 'inconclusive', `no recorded result at ${path}`, 'assurance/adapters/file');
            }
            let parsed: RecordedResult;
            try {
                parsed = JSON.parse(raw) as RecordedResult;
            } catch (error) {
                return verdictOf(evidence, context, 'inconclusive', `${path} is not readable JSON: ${(error as Error).message}`, 'assurance/adapters/file');
            }
            if (parsed.subjectRevision !== context.subject.revision) {
                return verdictOf(
                    evidence,
                    context,
                    'inconclusive',
                    `${path} was recorded against ${parsed.subjectRevision}, not ${context.subject.revision}`,
                    'assurance/adapters/file',
                );
            }
            return {
                evidenceId: evidence.id,
                evidenceType: evidence.type,
                verdict: parsed.verdict,
                observed: parsed.observed,
                at: parsed.at ?? context.now(),
                verifier: parsed.verifier ?? 'assurance/adapters/file',
                subjectRevision: parsed.subjectRevision,
            };
        },
    };
}

function verdictOf(
    evidence: Evidence,
    context: VerifyContext,
    verdict: EvidenceVerdict['verdict'],
    observed: string,
    verifier: string,
): EvidenceVerdict {
    return {
        evidenceId: evidence.id,
        evidenceType: evidence.type,
        verdict,
        observed,
        at: context.now(),
        verifier,
        subjectRevision: context.subject.revision,
    };
}

