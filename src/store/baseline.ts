import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { taskDir } from '../core/layout.js';
import { readLedger } from './ledger.js';

/**
 * **The change-level baseline six acceptance items were waiting for.**
 *
 * The plan's P1 said the corpus is the critical path because six acceptance items — cost, recall, false-pass rate, the
 * re-review reduction, evidence replayability — all compare against a baseline that has never been measured. What was
 * missing is not a number: the repository holds **eleven archived changes** whose records carry what the retired route
 * cost, and three that walked the ledger route with kata-measured figures. Both are on disk, and neither had a reader.
 *
 * **What this reports, and what it deliberately does not.** The retired route's figures come from
 * `adversarial-review.json`'s `usage` block, which was **self-reported by the pass** — two of them reported
 * `total_tokens: 0` for rounds the harness measured at 134K and 449K — so the report labels every retired figure
 * `self-reported` and never presents it as measured. The ledger route's figures come from the run registry, which kata
 * writes from the stream it reads. A comparison between the two is therefore a comparison of *different kinds of
 * evidence*, and the report says so in one field rather than in a footnote.
 *
 * **What it is for**: giving `Cost ≤ 0.6 C0` a denominator, and showing whether the two routes' quality signals are
 * comparable at all. It measures cost, not quality — `ledger corpus` and `ledger verifier` measure the decision, and
 * neither measures whether a reviewer finds defects.
 */

export interface RetiredCost {
    changeId: string;
    /** Passes recorded live plus those the record replaced, which is the whole round count. */
    passes: number;
    /** The tokens the passes reported. Self-reported, and two records reported zero. */
    reportedTokens: number;
    reportedToolUses: number;
    reportedDurationMs: number;
    /** Findings across every recorded pass, which is what a repair round was paid for. */
    findings: number;
    /** Sealed revisions, read from the change-record files the seal wrote one per revision. */
    revisions: number;
    /** True when at least one pass reported no tokens, so the sum understates the real cost. */
    tokensUnreported: boolean;
}

export interface LedgerCost {
    changeId: string;
    claims: number;
    evidence: number;
    challenges: number;
    /** Runs kata launched and observed, with the figures it counted itself. */
    runs: number;
    /** A run's `tokens` is null when the host did not report it: a null is not a zero. */
    measuredToolCalls: number;
    measuredOutputBytes: number;
    measuredTokens: number | null;
    measuredWallMs: number;
    /** What the ledger recorded about its own budget, when a round wrote one. Nulls are kept as nulls. */
    recordedUsage: { toolCalls?: number | null; wallMs?: number | null; tokens?: number | null } | null;
}

export interface BaselineReport {
    retired: RetiredCost[];
    ledgerRoute: LedgerCost[];
    /**
     * The retired route's mean reported cost per change, which is the C0 the acceptance items compare against.
     * `null` when no change has a readable figure, because a denominator nobody can compute is not zero.
     */
    c0: { changes: number; meanReportedTokens: number | null; meanPasses: number | null; meanFindings: number | null };
    /** Which side of the comparison is self-reported, said once rather than implied. */
    evidenceBasis: {
        retired: 'self-reported by the pass, and understated where a pass reported nothing';
        ledgerRoute: 'measured by kata from the stream it read while running the round';
    };
    /** What this instrument does not measure, so a number is not read as a quality claim. */
    measures: string;
    /** Changes present on disk with neither a ledger nor an adversarial record, named rather than skipped silently. */
    unmeasured: string[];
}

async function readJson<T>(path: string): Promise<T | null> {
    try {
        return JSON.parse(await readFile(path, 'utf8')) as T;
    } catch {
        return null;
    }
}

type PassRecord = { usage?: { total_tokens?: number; tool_uses?: number; duration_ms?: number }; findings?: unknown[] };

/** The changes this workspace holds, from the task directories rather than from a list someone maintains by hand. */
export async function changeIdsWithRecords(root: string): Promise<string[]> {
    const tasksRoot = join(root, '.kata', 'tasks');
    const entries = await readdir(tasksRoot).catch(() => [] as string[]);
    const ids: string[] = [];
    for (const entry of entries) {
        const dir = join(tasksRoot, entry);
        const info = await stat(dir).catch(() => null);
        if (!info?.isDirectory()) continue;
        const task = await stat(join(dir, 'task.json')).catch(() => null);
        if (task?.isFile()) ids.push(entry);
    }
    return ids.sort();
}

/** Every pass a retired-route change recorded: the live record and the ones it replaced. */
export async function retiredPasses(root: string, changeId: string): Promise<PassRecord[]> {
    const dir = taskDir(root, changeId);
    const live = await readJson<PassRecord>(join(dir, 'adversarial-review.json'));
    const history = await readJson<PassRecord[]>(join(dir, 'adversarial-review-history.json'));
    const passes = [...(Array.isArray(history) ? history : []), ...(live ? [live] : [])];
    return passes.filter((pass) => pass !== null && typeof pass === 'object');
}

/** How many revisions the seal minted, counted from the change records rather than from a field that could drift. */
export async function sealedRevisionCount(root: string, changeId: string): Promise<number> {
    const dir = taskDir(root, changeId);
    const entries = await readdir(dir).catch(() => [] as string[]);
    const revisionBound = entries.filter((entry) => entry.startsWith('change-record-revision-')).length;
    const hasLatest = entries.includes('change-record.json') ? 1 : 0;
    return revisionBound + hasLatest;
}

export async function buildBaseline(root: string): Promise<BaselineReport> {
    const ids = await changeIdsWithRecords(root);
    const retired: RetiredCost[] = [];
    const ledgerRoute: LedgerCost[] = [];
    const unmeasured: string[] = [];

    for (const changeId of ids) {
        const passes = await retiredPasses(root, changeId);
        const ledger = await readLedger(root, changeId).catch(() => null);
        const hasLedger = Boolean(ledger && ledger.claims.length > 0);

        if (passes.length > 0) {
            let reportedTokens = 0;
            let reportedToolUses = 0;
            let reportedDurationMs = 0;
            let findings = 0;
            let tokensUnreported = false;
            for (const pass of passes) {
                const tokens = pass.usage?.total_tokens;
                if (typeof tokens === 'number' && tokens > 0) reportedTokens += tokens;
                else tokensUnreported = true;
                if (typeof pass.usage?.tool_uses === 'number') reportedToolUses += pass.usage.tool_uses;
                if (typeof pass.usage?.duration_ms === 'number') reportedDurationMs += pass.usage.duration_ms;
                findings += (pass.findings ?? []).length;
            }
            retired.push({
                changeId,
                passes: passes.length,
                reportedTokens,
                reportedToolUses,
                reportedDurationMs,
                findings,
                revisions: await sealedRevisionCount(root, changeId),
                tokensUnreported,
            });
        } else if (!hasLedger) {
            // Named rather than skipped: a change with neither route's records is a fact about the corpus, and a baseline
            // that quietly omitted it would report a mean over a population it never stated.
            unmeasured.push(changeId);
        }

        if (hasLedger && ledger) {
            // **The measured figures come from the round-run registry**, which kata wrote while it read the round's stream
            // (tool calls, output bytes, tokens, wall clock). It is a file from the retired protocol, kept as history, and
            // it is the only place in the repository where a round's cost was counted by kata rather than reported by the
            // party being measured — which is exactly why the comparison below has to name its two bases.
            const registry = await readJson<{ runs?: Array<{ toolCalls?: number; outputBytes?: number; tokens?: number | null; startedAt?: string; endedAt?: string }> }>(
                join(taskDir(root, changeId), 'round-runs.json'),
            );
            const runs = Array.isArray(registry?.runs) ? registry.runs : [];
            let measuredToolCalls = 0;
            let measuredOutputBytes = 0;
            let measuredTokens: number | null = null;
            let measuredWallMs = 0;
            for (const run of runs) {
                if (typeof run.toolCalls === 'number') measuredToolCalls += run.toolCalls;
                if (typeof run.outputBytes === 'number') measuredOutputBytes += run.outputBytes;
                if (typeof run.tokens === 'number') measuredTokens = (measuredTokens ?? 0) + run.tokens;
                const started = Date.parse(run.startedAt ?? '');
                const ended = Date.parse(run.endedAt ?? '');
                if (Number.isFinite(started) && Number.isFinite(ended)) measuredWallMs += ended - started;
            }
            ledgerRoute.push({
                changeId,
                claims: ledger.claims.length,
                evidence: ledger.evidence.length,
                challenges: ledger.challenges.length,
                runs: runs.length,
                measuredToolCalls,
                measuredOutputBytes,
                measuredTokens,
                measuredWallMs,
                /** The ledger's own recorded budget, if a round wrote one. */
                recordedUsage: ledger.usage ?? null,
            });
        }
    }

    // A mean over a population is reported with its population, and a mean nobody can compute is `null` rather than 0.
    const withTokens = retired.filter((entry) => entry.reportedTokens > 0);
    return {
        retired,
        ledgerRoute,
        c0: {
            changes: retired.length,
            meanReportedTokens: withTokens.length === 0
                ? null
                : Math.round(withTokens.reduce((sum, entry) => sum + entry.reportedTokens, 0) / withTokens.length),
            meanPasses: retired.length === 0
                ? null
                : Math.round((retired.reduce((sum, entry) => sum + entry.passes, 0) / retired.length) * 10) / 10,
            meanFindings: retired.length === 0
                ? null
                : Math.round((retired.reduce((sum, entry) => sum + entry.findings, 0) / retired.length) * 10) / 10,
        },
        evidenceBasis: {
            retired: 'self-reported by the pass, and understated where a pass reported nothing',
            ledgerRoute: 'measured by kata from the stream it read while running the round',
        },
        measures:
            'What each route cost, per change, from records already on disk. It does not measure whether a reviewer found '
            + 'a defect: `ledger corpus` measures the decision and `ledger verifier` scores the retired corpus with the '
            + 'kernel. A cost comparison between the two routes compares different kinds of evidence, and the figures here '
            + 'are not interchangeable.',
        unmeasured,
    };
}
