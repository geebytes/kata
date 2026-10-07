import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTaskRevisionIfChanged } from '../../src/workflow/revision.js';
import { readUpstreamSummary, suggestCandidateAction } from '../../src/workflow/navigation.js';

/**
 * `assessReviewLoop` answers one `kind`, and it is right to: it answers *the route*. What was wrong is that the published
 * facts were derived from that single answer, so with the pointer and the round history both unreadable the summary
 * published one refusal and stayed silent about the other — an operator repairing the pointer would not learn that the
 * round log is damaged too, and would meet it on the next command.
 *
 * The pointer's route (2300) outranking the round history's (2290) is the ladder's existing precedence, not suppression:
 * the second case below shows the round-history route still reachable in its own state.
 */
const taskId = 'both-refusals';
let root: string;

async function seed(): Promise<void> {
    root = await mkdtemp(join(tmpdir(), 'kata-both-refusals-'));
    await mkdir(join(root, '.kata', 'tasks', taskId), { recursive: true });
    await writeFile(join(root, 'subject.ts'), 'export const version = 1;\n');
    await writeFile(
        join(root, '.kata', 'tasks', taskId, 'task.json'),
        `${JSON.stringify({ id: taskId, title: 'T', phase: 'review', acceptance: [{ id: 'AC-1', statement: 'x' }], ownedPaths: ['subject.ts'] })}\n`,
    );
    await writeFile(
        join(root, '.kata', 'tasks', taskId, 'current-state.json'),
        `${JSON.stringify({ taskId, phase: 'review' })}\n`,
    );
}

const malformedRounds = '{ this is not a round\n';

describe('two unreadable reads publish two refusals', () => {
    beforeEach(seed);
    afterEach(async () => {
        await rm(root, { recursive: true, force: true });
    });

    it('publishes the round history as well when the pointer is unreadable', async () => {
        await writeFile(join(root, '.kata', 'tasks', taskId, 'current-revision.json'), '{ this is not JSON\n');
        await writeFile(join(root, '.kata', 'tasks', taskId, 'review-rounds.jsonl'), malformedRounds);

        const upstream = await readUpstreamSummary(root, taskId);

        expect(upstream.currentRevisionUnreadable).toContain('current-revision.json');
        expect(upstream.reviewHistoryUnreadable).toBe(true);
        // Both facts, so the count is two: one refusal where an operator has two files to repair.
        expect(upstream.reviewFindings).toBe(2);
        // The harder failure still routes: a change whose content identity cannot be read cannot be repaired by rewriting
        // its round log.
        expect(suggestCandidateAction('review', upstream).reason).toBe('repair_unreadable_current_revision');
    });

    it('still routes the round history when it is the only unreadable read', async () => {
        await createTaskRevisionIfChanged({ root, taskId, ownedPaths: ['subject.ts'], checkIds: [] });
        await writeFile(join(root, '.kata', 'tasks', taskId, 'review-rounds.jsonl'), malformedRounds);

        const upstream = await readUpstreamSummary(root, taskId);

        expect(upstream.reviewHistoryUnreadable).toBe(true);
        expect(upstream.currentRevisionUnreadable).toBeUndefined();
        expect(suggestCandidateAction('review', upstream).reason).toBe('repair_unreadable_round_history');
    });
});
