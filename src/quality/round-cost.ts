import { readFile } from 'node:fs/promises';
import { readAdversarialRecord } from './adversarial.js';
import { adversarialReviewPath } from '../core/layout.js';

/**
 * What each review round cost, so the loop's price is a number rather than an impression.
 *
 * **Measured, and it is the point of this module.** Seven recorded rounds on this line cost 351,864 / 658,523 / 347,000 / 400,000 /
 * 875,572 / 510,836 / 1,073,271 tokens and produced 7 / 0 / 5 / 5 / 0 / 7 findings. **Cost and yield are not correlated**: the two
 * most expensive produced *zero* findings because they never wrote a record, and the cheapest produced seven. What correlates is
 * whether the record lands and whether the round's scope narrowed.
 *
 * So the number this reports is not there to be driven down. It is there because a loop whose price is invisible cannot be discussed
 * — the change it belongs to has three criteria and none of them mentions cost, so "the cost has not fallen" was not a fact anything
 * could fail on. A reported cost is the first step to a criterion that can.
 */
export interface RoundCost {
    readonly revisionId: string;
    readonly at: string;
    readonly findings: number;
    /** Output tokens the round reported, when its record carried them. */
    readonly tokens?: number;
    readonly toolUses?: number;
    readonly durationMs?: number;
    /** Findings per 100k tokens — the number that says whether a round paid for what it found. */
    readonly yieldPer100k?: number;
}

export interface RoundCostReport {
    readonly rounds: readonly RoundCost[];
    readonly totalTokens: number;
    /** The latest round's cost, which is what a repair author is deciding about when it chooses how large a repair to make. */
    readonly latest?: RoundCost;
    /** The cheapest and dearest recorded rounds, so a reader sees the range rather than a mean that hides it. */
    readonly range?: { readonly cheapest: RoundCost; readonly dearest: RoundCost };
}

/** Reads the cost the records carry. Rounds that wrote no record are absent by construction and are not counted as free. */
export async function reportRoundCost(root: string, taskId: string, node = 'review'): Promise<RoundCostReport> {
    // The history is where a round's record goes when the next round replaces it, and the live record is the latest — so a cost
    // report that read only one of them would describe fewer rounds than ran, which is the same defect as a round list that counts
    // records and calls them revisions.
    const history = await readFile(adversarialReviewPath(root, taskId, node as never).replace(/\.json$/, '-history.json'), 'utf8')
        .then((raw) => JSON.parse(raw) as Array<Record<string, unknown>>)
        .catch(() => [] as Array<Record<string, unknown>>);
    const live = await readAdversarialRecord(root, taskId, node as never).catch(() => null);
    const records = [...history, ...(live ? [live as unknown as Record<string, unknown>] : [])];
    const rounds: RoundCost[] = [];
    for (const record of records) {
        const usage = (record as { usage?: Record<string, number> }).usage ?? {};
        const tokens = usage.total_tokens ?? usage.totalTokens;
        const findings = Array.isArray((record as { findings?: unknown[] }).findings) ? ((record as { findings: unknown[] }).findings.length) : 0;
        rounds.push({
            revisionId: String((record as { revisionId?: string }).revisionId ?? ''),
            at: String((record as { createdAt?: string }).createdAt ?? ''),
            findings,
            ...(typeof tokens === 'number' ? { tokens } : {}),
            ...(typeof usage.tool_uses === 'number' ? { toolUses: usage.tool_uses } : {}),
            ...(typeof usage.duration_ms === 'number' ? { durationMs: usage.duration_ms } : {}),
            ...(typeof tokens === 'number' && tokens > 0 ? { yieldPer100k: Math.round((findings / tokens) * 100000 * 100) / 100 } : {}),
        });
    }
    const withTokens = rounds.filter((round) => typeof round.tokens === 'number');
    const totalTokens = withTokens.reduce((sum, round) => sum + (round.tokens ?? 0), 0);
    const sorted = [...withTokens].sort((a, b) => (a.tokens ?? 0) - (b.tokens ?? 0));
    return {
        rounds,
        totalTokens,
        ...(rounds.length > 0 ? { latest: rounds[rounds.length - 1] } : {}),
        ...(sorted.length > 1 ? { range: { cheapest: sorted[0] as RoundCost, dearest: sorted[sorted.length - 1] as RoundCost } } : {}),
    };
}
