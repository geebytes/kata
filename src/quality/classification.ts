import { classifyRisk, TIER_RANK, type RiskClassification } from '../kernel/risk.js';
import type { Policy } from '../kernel/policy.js';
import { RISK_CLASSES, type RiskClass, type TierName } from '../kernel/types.js';
import { reviewTierFor } from './review-ladder.js';

/**
 * **What a change's declaration classifies as, and whether the lane its profile names sits below it.**
 *
 * Two facts that were never printed together. A change can be opened with `--review std` while its declared paths classify it
 * as `strict`, and nothing anywhere said so: the classification is computed for the ledger's tier (`ledger plan` writes
 * `risk`) and the lane is read from `workflowProfile.reviewMode`, but no surface put them side by side — measured on this
 * repository's own lane change, whose classification read `standard` and whose lane read `std` with neither number visible
 * outside the artefacts.
 *
 * **No second ordering and no second translation.** The classification is the kernel's `classifyRisk`, the lane is rewritten
 * by the one owner of that translation (`reviewTierFor`), and the comparison uses the kernel's own `TIER_RANK`. The function
 * answers; the callers decide what to do with the answer, which is why nothing here refuses anything: naming the gap is the
 * property, and changing a gate's strength is a separate decision that this change does not take.
 */
export interface LaneAndClassification {
    classification: RiskClassification;
    /** Who supplied the judgement; `floor` means the deterministic path floor was used or raised it. */
    by: 'agent' | 'floor';
    reasons: string[];
    /** The lane as the profile spells it (`std` by default, and by default the profile is absent). */
    lane: string;
    /** The lane as the ladder reads it — the same value the ledger tier is resolved from. */
    laneTier: TierName;
    /** True when the lane is weaker than the recorded classification: the fact a reader must be told. */
    laneBelow: boolean;
}

export type AgentClassificationInput = { tier: TierName; reasons: string[]; riskClasses: RiskClass[] };

/** Parse only the host agent's judgement; paths and matched floors are always re-derived from the task declaration. */
export function parseAgentClassification(value: unknown): AgentClassificationInput {
    if (typeof value !== 'object' || value === null) throw new Error('classification input must be an object');
    const record = value as Record<string, unknown>;
    if (record.tier !== 'standard' && record.tier !== 'strict' && record.tier !== 'security') throw new Error('classification tier must be standard, strict, or security');
    if (!Array.isArray(record.reasons) || record.reasons.length === 0 || !record.reasons.every((item) => typeof item === 'string' && item.trim() !== '')) {
        throw new Error('classification reasons must be a non-empty string array');
    }
    if (!Array.isArray(record.riskClasses) || !record.riskClasses.every((item) => typeof item === 'string' && (RISK_CLASSES as readonly string[]).includes(item))) {
        throw new Error('classification riskClasses must use the kernel risk-class vocabulary');
    }
    return { tier: record.tier, reasons: record.reasons, riskClasses: record.riskClasses as RiskClass[] };
}

export function classifyLaneAndDeclaration(input: {
    paths: readonly string[];
    policy: Policy;
    reviewMode?: string;
    agentClassification?: AgentClassificationInput;
}): LaneAndClassification {
    const pathClassification = classifyRisk({ paths: input.paths, policy: input.policy });
    const lane = input.reviewMode ?? 'std';
    const laneTier = reviewTierFor(input.reviewMode);
    const proposedTier = input.agentClassification?.tier ?? pathClassification.tier;
    const raised = TIER_RANK[proposedTier] < TIER_RANK[pathClassification.tier];
    const tier = raised ? pathClassification.tier : proposedTier;
    const agentReasons = input.agentClassification?.reasons ?? ['No agent judgement was supplied; the path floor is used fail-closed.'];
    const reasons = raised
        ? [...agentReasons, `Raised from ${proposedTier} to the path floor ${pathClassification.tier} (${pathClassification.floor}).`]
        : agentReasons;
    const classification: RiskClassification = {
        ...pathClassification,
        tier,
        riskClasses: [...new Set([...pathClassification.riskClasses, ...(input.agentClassification?.riskClasses ?? [])])],
        reason: reasons.join(' '),
    };
    const by = input.agentClassification && !raised ? 'agent' : 'floor';
    return {
        classification,
        by,
        reasons,
        lane,
        laneTier,
        laneBelow: TIER_RANK[laneTier] < TIER_RANK[tier],
    };
}

/** The sentence a surface prints when the lane is below the declaration — one wording, so two surfaces cannot disagree. */
export function laneBelowSentence(input: {
    changeId: string;
    lane: string;
    laneTier: TierName;
    classification: RiskClassification;
}): string {
    const matched = input.classification.matched
        .map((entry) => `${entry.path} (${entry.pattern}, floor ${entry.floor})`)
        .join('; ');
    return `The lane "${input.lane}" (tier ${input.laneTier}) is below what this change's declared paths classify as `
        + `(${input.classification.tier}, floor ${input.classification.floor}${matched === '' ? '' : `: ${matched}`}). `
        + 'The lane is a floor, not a preference: either widen it at open time, or open the successor change whose '
        + `declaration matches — the change's identity (its lane included) is fixed when it is opened, so \`${input.changeId}\` `
        + 'cannot be raised in place.';
}


/** Build the durable task record from the one risk derivation used by lane reporting. */
export function taskClassificationRecord(input: {
    taskId: string;
    paths: readonly string[];
    answer: LaneAndClassification;
}): import('../core/task.js').TaskClassificationRecord {
    const classification = input.answer.classification;
    return {
        version: 1,
        taskId: input.taskId,
        by: input.answer.by,
        tier: classification.tier,
        floor: classification.floor,
        reasons: [...input.answer.reasons],
        riskClasses: [...classification.riskClasses],
        facts: {
            declaredPaths: [...input.paths],
            matched: classification.matched.map((entry) => ({ ...entry })),
            wideChange: classification.wideChange,
        },
        lane: input.answer.lane,
        laneTier: input.answer.laneTier,
        laneBelow: input.answer.laneBelow,
    };
}
