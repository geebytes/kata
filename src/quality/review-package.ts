import type { TaskRelation } from '../core/relations.js';
import type { TaskClassificationRecord, TaskRecord } from '../core/task.js';
import type { AcceptanceAmendment } from './acceptance-amendment.js';
import type { AssuranceLevel, Claim, Evidence, TierName } from '../kernel/types.js';
import type { Policy } from '../kernel/policy.js';

export type ReviewPackage = {
    version: 1;
    relations: TaskRelation[];
    axes: {
        qualityEvidence: {
            tier: string;
            requirements: Array<{ claimId: string; types: string[]; minimumStrength: number }>;
        };
        executionAssurance: {
            achieved: AssuranceLevel;
            floor: AssuranceLevel | null;
            reviewers: number | null;
            quorumOn: string[];
        };
        reviewLane: string;
        classification: TaskClassificationRecord | { unreadable: string };
    };
    declaration: {
        ownedPaths: string[];
        acceptance: TaskRecord['acceptance'];
        acceptanceMatrix: TaskRecord['acceptanceMatrix'];
        /**
         * **The amendments that produced this contract, if any** — carried so the reviewer judges the correction rather than
         * only the corrected sentence. A criterion's text is what a certification is *about*, and a contract corrected after
         * the seal is exactly the fact a reviewer would otherwise have to reconstruct from the diff of a file they are not
         * given. An unreadable log is a **named hole** here, like the classification: reporting "no amendments" for a log
         * nobody could read would assert a history that was never established.
         */
        acceptanceAmendments: AcceptanceAmendment[] | { unreadable: string };
        claims: Array<Pick<Claim, 'id' | 'statement' | 'riskClass' | 'severity' | 'dependsOn' | 'evidenceIds' | 'boundary'>>;
    };
    falsifiers: Array<{
        id: string;
        file: string;
        find: string;
        replace: string;
        command: string;
        expectedRedForClaims: string[];
    }>;
};

/**
 * Assemble the reviewer-facing package from the same records that build the request.
 *
 * This is a projection, not a second planner: relations come from the authoritative relation graph, declaration fields from
 * the task record, axes from the stored plan/policy/assurance/classification, and falsifiers from the ledger's evidence plus
 * its claim-to-evidence links. `expectedRedForClaims` is therefore a join over declared ids, never prose inferred from a test.
 */
export function buildReviewPackage(input: {
    task: TaskRecord;
    relations: TaskRelation[];
    policy: Policy;
    achievedAssurance: AssuranceLevel;
    tier: string;
    requirements: Array<{ claimId: string; types: string[]; minimumStrength: number }>;
    classification: TaskClassificationRecord | { unreadable: string };
    acceptanceAmendments: AcceptanceAmendment[] | { unreadable: string };
    claims: Claim[];
    evidence: Evidence[];
}): ReviewPackage {
    const tierPolicy = input.policy.tiers[input.tier as TierName];
    const executable = input.evidence.filter((entry): entry is Extract<Evidence, { type: 'executable_falsifier' }> => entry.type === 'executable_falsifier');
    return {
        version: 1,
        relations: input.relations,
        axes: {
            qualityEvidence: { tier: input.tier, requirements: input.requirements },
            executionAssurance: {
                achieved: input.achievedAssurance,
                floor: tierPolicy?.assuranceFloor ?? null,
                reviewers: tierPolicy?.reviewers ?? null,
                quorumOn: tierPolicy ? [...tierPolicy.quorumOn] : [],
            },
            reviewLane: input.task.workflowProfile?.reviewMode ?? 'unknown',
            classification: input.classification,
        },
        declaration: {
            ownedPaths: [...(input.task.ownedPaths ?? [])],
            acceptance: input.task.acceptance,
            acceptanceMatrix: input.task.acceptanceMatrix,
            acceptanceAmendments: input.acceptanceAmendments,
            claims: input.claims.map(({ id, statement, riskClass, severity, dependsOn, evidenceIds, boundary }) => ({
                id, statement, riskClass, severity, dependsOn, evidenceIds, ...(boundary === undefined ? {} : { boundary }),
            })),
        },
        falsifiers: executable.map((entry) => ({
            id: entry.id,
            file: entry.mutation.file,
            find: entry.mutation.find,
            replace: entry.mutation.replace,
            command: entry.command,
            expectedRedForClaims: input.claims.filter((claim) => claim.evidenceIds.includes(entry.id)).map((claim) => claim.id),
        })),
    };
}
