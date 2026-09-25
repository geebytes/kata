import { describe, expect, it } from 'vitest';
import { createPiAdapter } from '../../host/pi-adapter.js';
import { runReviewRound, type ReviewPacket } from '../../host/executor.js';

/**
 * **The adapter cannot turn "nothing ran" into a receipt.**
 *
 * `host/executor.ts` now refuses to produce one when a session ends without a result — but the adapter is what turns a process into an event
 * stream, so it is the side that must not pretend a failed process was a session. Measured here by pointing the adapter at a `PATH` with no
 * `pi` in it: the spawn fails, `error` ends the stream, and the round must come back as `executor_unavailable` with **no receipt**.
 *
 * This file also brings `host/pi-adapter.ts` under `tsc`, which nothing did before: `tsconfig.include` lists `src/**` and `tests/**`, so the
 * adapter was compiled by nothing until a test imported it — and two errors (a constructor parameter property Node's type stripping cannot
 * express, and `events` declared as a method rather than a property) survived until the first run.
 */
const packet: ReviewPacket = {
    request: {
        runId: 'run-no-executable',
        requestSha256: 'c'.repeat(64),
        briefSha256: 'd'.repeat(64),
        budget: { maxHypotheses: 6, maxToolCalls: 10, maxOutputBytes: 1000, maxWallMs: 5_000 },
        requiredCapabilities: ['fresh_context', 'read_only_fs'],
    },
    brief: { sha256: 'd'.repeat(64), text: 'A brief no session will read, because the session cannot start.' },
} as ReviewPacket;

describe('the pi adapter refuses what it cannot run', () => {
    it('writes no receipt when the executable cannot be started', async () => {
        const adapter = createPiAdapter({ model: 'litellm/deepseek-v4.1-flash-goat', cwd: process.cwd(), env: { PATH: '/nonexistent-bin' }, timeoutMs: 10_000 });
        const outcome = await runReviewRound({ packet, adapter, now: () => Date.now() });

        expect(outcome.receipt, 'a receipt for a session that never started is the defect this boundary exists to prevent').toBeUndefined();
        expect(outcome.status).toBe('executor_unavailable');
    }, 30_000);
});
