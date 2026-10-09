import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initLayout } from '../../src/core/layout.js';
import { readUpstreamSummary, suggestCandidateAction } from '../../src/workflow/navigation.js';
import { writeTaskRecord } from '../helpers/task-fixture.js';

/**
 * **AC-20 — a record that parses but does not hold what the reader consumes is unreadable, and routes by name.**
 *
 * The three-way reader (`absent | usable | unreadable`) was applied at the *top* of each record and not to the nested values
 * the consumers actually read. A judge record holding `"acceptance": "everything passed"` is a JSON object, so it arrived as
 * **usable** and the summary reported a judge that had run; a review record holding `"findings": "none"` arrived as a review
 * that recorded nothing; an acceptance entry keyed by a number arrived as a criterion nobody could match. Each of those is a
 * damaged file an operator has to repair, reported as a fact about the change — and `absent` is the same sentence with a
 * different meaning ("nobody has done this yet"), which is why the three states have to stay distinguishable all the way
 * down the shape.
 */
const roots: string[] = [];
const taskId = 'nested-shape';

async function tempRoot(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'kata-nested-shape-'));
    roots.push(root);
    await initLayout(root);
    await mkdir(join(root, '.kata', 'tasks', taskId), { recursive: true });
    await writeTaskRecord(root, {
        id: taskId,
        phase: 'hardVerify',
        acceptance: [{ id: 'AC-1', statement: 'The thing holds.' }],
        ownedPaths: ['src/a.ts'],
    });
    return root;
}

const writeRecord = async (root: string, name: string, body: unknown): Promise<void> => {
    await writeFile(join(root, '.kata', 'tasks', taskId, name), `${JSON.stringify(body, null, 2)}\n`);
};

afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('a nested malformed record is unreadable, not usable', () => {
    it('refuses a judge record whose acceptance is not a list of criteria', async () => {
        const root = await tempRoot();
        await writeRecord(root, 'judge.json', { result: 'PASS', acceptance: 'everything passed' });

        const summary = await readUpstreamSummary(root, taskId);

        // Named, with the file in the message: an operator repairs a file, and a summary that folded this into "no judge yet"
        // sent them looking for a judge record that was right there.
        expect(summary.judgeUnreadable).toContain('judge.json');
        expect(summary.judgeResult).toBeUndefined();
        // **And it routes.** The named field is what the router refuses on; a status that published the damage while routing as
        // if the phase were complete would be the same defect one layer up. The route names the repair, so an operator is not
        // left with a phase that looks finished and a file that cannot be read.
        const action = suggestCandidateAction('judge', summary);
        expect(action.reason).toBeTruthy();
        expect(action.nextSkill).toMatch(/^\/kata-/);
    });

    it('refuses a judge record whose acceptance entry is keyed by something that is not a criterion id', async () => {
        const root = await tempRoot();
        await writeRecord(root, 'judge.json', { result: 'FAIL', acceptance: [{ id: 7, result: 'FAIL' }] });

        const summary = await readUpstreamSummary(root, taskId);

        expect(summary.judgeUnreadable).toContain('judge.json');
        // And nothing read the entry as a failed criterion it could act on: the record is refused before any of it is used.
        expect(summary.failedAcceptance).toBe(0);
    });

    it('refuses a review record whose findings are not a list, instead of reporting a clean round', async () => {
        const root = await tempRoot();
        await writeRecord(root, 'review.json', { status: 'approved', reviewEvidence: 'read it', findings: 'none' });

        const summary = await readUpstreamSummary(root, taskId);

        // The load-bearing direction: an approval nobody can read must not arrive as an approval.
        // **The file's one name**, which is the same field a non-JSON record is reported under: a second id for the same
        // damaged file would be one fact with two answers, so the shape refusal contributes to the name that exists.
        expect(summary.reviewRecordUnreadable).toContain('review.json');
        expect(summary.invalidReviewApproval).not.toBe(true);
        expect(summary.reviewReady).not.toBe(true);
    });

    it('refuses a review record whose status is not a status, and a coverage declaration that is not a list', async () => {
        const statusRoot = await tempRoot();
        await writeRecord(statusRoot, 'review.json', { status: 42, findings: [] });
        expect((await readUpstreamSummary(statusRoot, taskId)).reviewRecordUnreadable).toContain('review.json');

        const coverageRoot = await tempRoot();
        await writeRecord(coverageRoot, 'review.json', { status: 'pending', findings: [], declaredCoverage: 'C-1, C-2' });
        expect((await readUpstreamSummary(coverageRoot, taskId)).reviewRecordUnreadable).toContain('review.json');
    });

    it('refuses a verify record whose acceptance is malformed, under its own name', async () => {
        const root = await tempRoot();
        await writeRecord(root, 'verify.json', { result: 'PASS', acceptance: [null] });

        const summary = await readUpstreamSummary(root, taskId);

        expect(summary.verifyUnreadable).toContain('verify.json');
        expect(summary.verifyResult).toBeUndefined();
    });

    it('accepts the well-formed shape, so the refusals above are about the damage and not about the gate', async () => {
        const root = await tempRoot();
        await writeRecord(root, 'judge.json', { result: 'PASS', acceptance: [{ id: 'AC-1', result: 'PASS' }] });
        await writeRecord(root, 'review.json', { status: 'pending', findings: [], declaredCoverage: ['C-1'] });

        const summary = await readUpstreamSummary(root, taskId);

        expect(summary.judgeUnreadable).toBeUndefined();
        expect(summary.reviewRecordUnreadable).toBeUndefined();
        expect(summary.judgeResult).toBe('PASS');
    });
});
