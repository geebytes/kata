/**
 * Submissions — what a producer may hand in, and what it may not.
 *
 * A producer proposes claims and evidence. It may not hand in a verdict: deciding is the verifier's half, and the rule is
 * enforced here rather than trusted, because "the producer also said it passes" is exactly the shape this subsystem
 * exists to remove. The refusal names the offending key.
 */
import { evidenceShapeProblems } from '../kernel/evidence.js';
import {
    EVIDENCE_TYPES,
    RISK_CLASSES,
    SEVERITIES,
    type Claim,
    type Evidence,
    type RiskClass,
    type Severity,
} from '../kernel/types.js';

export type Submission = { claims: Claim[]; evidence: Evidence[] };
export type SubmissionRead = { ok: true; submission: Submission } | { ok: false; errors: string[] };

const FORBIDDEN_KEYS = ['verdict', 'verdicts', 'decision', 'decisions', 'passed', 'satisfied'];

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A producer that decides is refused, wherever the decision is hidden. */
function findForbiddenKeys(value: unknown, path: string, found: string[]): void {
    if (Array.isArray(value)) {
        value.forEach((entry, index) => findForbiddenKeys(entry, `${path}[${index}]`, found));
        return;
    }
    if (!isRecord(value)) return;
    for (const [key, entry] of Object.entries(value)) {
        if (FORBIDDEN_KEYS.includes(key)) found.push(`${path}.${key}`);
        findForbiddenKeys(entry, `${path}.${key}`, found);
    }
}

export function readSubmission(value: unknown): SubmissionRead {
    const errors: string[] = [];
    if (!isRecord(value)) return { ok: false, errors: ['a submission must be a JSON object'] };

    const forbidden: string[] = [];
    findForbiddenKeys(value, '$', forbidden);
    if (forbidden.length > 0) {
        errors.push(`a producer may not submit a verdict; found ${forbidden.join(', ')}`);
    }

    const rawClaims = value.claims;
    const rawEvidence = value.evidence ?? [];
    if (!Array.isArray(rawClaims)) errors.push('claims must be an array');
    if (!Array.isArray(rawEvidence)) errors.push('evidence must be an array');
    if (errors.length > 0) return { ok: false, errors };

    const claims: Claim[] = [];
    const evidence: Evidence[] = [];
    const seenIds = new Set<string>();

    for (const [index, entry] of (rawClaims as unknown[]).entries()) {
        if (!isRecord(entry)) {
            errors.push(`claims[${index}] must be an object`);
            continue;
        }
        const id = entry.id;
        if (typeof id !== 'string' || id.trim() === '') {
            errors.push(`claims[${index}].id is required`);
            continue;
        }
        if (seenIds.has(id)) errors.push(`claims[${index}].id "${id}" is used twice`);
        seenIds.add(id);
        if (typeof entry.statement !== 'string' || entry.statement.trim() === '') {
            errors.push(`claims[${index}].statement is required`);
        }
        if (typeof entry.riskClass !== 'string' || !RISK_CLASSES.includes(entry.riskClass as RiskClass)) {
            errors.push(`claims[${index}].riskClass must be one of ${RISK_CLASSES.join(', ')}`);
        }
        if (typeof entry.severity !== 'string' || !SEVERITIES.includes(entry.severity as Severity)) {
            errors.push(`claims[${index}].severity must be one of ${SEVERITIES.join(', ')}`);
        }
        const dependsOn = entry.dependsOn ?? [];
        if (!Array.isArray(dependsOn) || dependsOn.some((dep) => typeof dep !== 'string' || !/^(path|claim):/u.test(dep))) {
            errors.push(`claims[${index}].dependsOn entries must start with "path:" or "claim:"`);
        }
        claims.push({
            id,
            statement: typeof entry.statement === 'string' ? entry.statement : '',
            riskClass: entry.riskClass as RiskClass,
            severity: entry.severity as Severity,
            dependsOn: (Array.isArray(dependsOn) ? dependsOn : []) as Claim['dependsOn'],
            evidenceIds: Array.isArray(entry.evidenceIds) ? (entry.evidenceIds as string[]) : [],
            challengeIds: Array.isArray(entry.challengeIds) ? (entry.challengeIds as string[]) : [],
            status: 'open',
            // A producer declares claims, not times: the store stamps `at`, so every path gets the same one.
            at: '',
            reopens: 0,
        });
    }

    for (const [index, entry] of (rawEvidence as unknown[]).entries()) {
        if (!isRecord(entry)) {
            errors.push(`evidence[${index}] must be an object`);
            continue;
        }
        if (typeof entry.id !== 'string' || entry.id.trim() === '') {
            errors.push(`evidence[${index}].id is required`);
            continue;
        }
        if (typeof entry.type !== 'string' || !EVIDENCE_TYPES.includes(entry.type as Evidence['type'])) {
            errors.push(`evidence[${index}].type must be one of ${EVIDENCE_TYPES.join(', ')}`);
            continue;
        }
        // One assertion, named, after the checks that make it true — rather than two `as unknown as Evidence` casts that
        // said "any value at all is an Evidence" and would have kept compiling after the checks above changed.
        const item = entry as Evidence;
        const problems = evidenceShapeProblems(item);
        if (problems.length > 0) {
            errors.push(...problems.map((problem) => `evidence[${index}] (${entry.id as string}): ${problem}`));
            continue;
        }
        evidence.push(item);
    }

    if (errors.length > 0) return { ok: false, errors };
    return { ok: true, submission: { claims, evidence } };
}
