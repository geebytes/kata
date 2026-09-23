import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initLayout } from '../../src/core/layout.js';
import { createTask } from '../../src/core/task.js';
import { reportRounds } from '../../src/quality/repair-rounds.js';

const roots: string[] = [];
afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/**
 * AC-3: how many review rounds a change has had, and how many of the latest round's findings are about what the previous round
 * changed. The five rounds of `closure-gate` were reconstructed by hand from a directory listing to reach the conclusion that
 * the change could not be finished by its author; this is that reconstruction as a command.
 */
async function fixture(id: string): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'kata-rounds-'));
    roots.push(root);
    await initLayout(root);
    await createTask({ root, id, title: 'Rounds', acceptance: [{ id: 'AC-1', statement: 'x' }] });
    const dir = join(root, '.kata/tasks', id);
    await mkdir(dir, { recursive: true });
    await mkdir(join(dir, 'revisions'), { recursive: true });
    // Two recorded rounds, the second of which changed two paths.
    await writeFile(join(dir, 'adversarial-review-history.json'), JSON.stringify([
        { revisionId: 'revision-one', findings: [1, 2, 3], createdAt: '2026-09-23T01:00:00.000Z' },
    ]), 'utf8');
    await writeFile(join(dir, 'revisions/revision-one.json'), JSON.stringify({
        pathDigests: { 'src/changed.ts': 'a'.repeat(64), 'src/other.ts': 'b'.repeat(64) },
    }), 'utf8');
    await writeFile(join(dir, 'adversarial-review.json'), JSON.stringify({
        revisionId: 'revision-two',
        createdAt: '2026-09-23T02:00:00.000Z',
        // Three findings, of which two targeted a path the previous round changed.
        findings: [{ id: 'f1' }, { id: 'f2' }, { id: 'f3' }],
        hypotheses: [{ targets: ['src/changed.ts'] }, { targets: ['src/other.ts', 'AC-1'] }, { targets: ['src/untouched.ts'] }],
    }), 'utf8');
    return root;
}

describe('a change reports its review rounds and how many findings are about the previous round', () => {
    it('counts the rounds that left a record, and the share about the previous round', async () => {
        const root = await fixture('rounds');
        const report = await reportRounds(root, 'rounds', 'review');

        // Two rounds: the one in history and the live one. A round that produced nothing leaves no trace, which is why the
        // count can be lower than the number of rounds actually run.
        expect(report.rounds.map((round) => round.revisionId)).toEqual(['revision-one', 'revision-two']);
        expect(report.rounds.map((round) => round.findings)).toEqual([3, 3]);
        expect(report.aboutThePreviousRound).toBe(2);
        expect(report.shareAboutThePreviousRound).toBeCloseTo(2 / 3);
    });

    it('reports the rounds of the real change this was written from', async () => {
        // The measurement, on the data it came from: closure-gate had five attempts and four records, and every finding in the
        // last recorded round was about the previous round's repairs.
        const report = await reportRounds(process.cwd(), 'closure-gate', 'review');
        expect(report.rounds.length).toBe(4);
        expect(report.rounds.at(-1)?.findings).toBe(2);
        expect(report.aboutThePreviousRound).toBeGreaterThan(0);
    });
});
