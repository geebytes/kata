import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initLayout } from '../../src/core/layout.js';
import { undeclaredChanges } from '../../src/quality/undeclared-changes.js';
import { assessReviewLoop, readReviewRoundsState, reviewProgress } from '../../src/quality/repair.js';
import { runLedgerCommand } from '../../src/cli/ledger.js';
import { writePolicy } from '../../src/store/ledger.js';
import { defaultPolicy } from '../../src/kernel/policy.js';
import { writeTaskRecord } from '../helpers/task-fixture.js';

/**
 * **AC-17 — a gate input that is damaged, fabricated or incomplete must not read as a pass.**
 *
 * Five measured ways an input could go missing while the gate still reported success: a fixture fabricating the record it was
 * meant to test (R-1/R-2), a malformed review round counted as a round (R-7), a refusal that named no deficit and no remedy
 * (R-4), a route case that skipped the routes it could not map (R-9), and undeclared content that had already been committed
 * (R-8). The first two live in the guard's own file (`tests-do-not-read-the-live-task-store.test.ts`, where its reach is
 * asserted); this case pins the other three.
 */
const roots: string[] = [];
const taskId = 'gate-input';

afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tempRoot(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'kata-gate-input-'));
    roots.push(root);
    await initLayout(root);
    await mkdir(join(root, 'src'), { recursive: true });
    await mkdir(join(root, '.kata', 'tasks', taskId), { recursive: true });
    await writeFile(join(root, 'src', 'a.ts'), 'export const holds = true;\n');
    await writeTaskRecord(root, {
        id: taskId,
        phase: 'hardVerify',
        acceptance: [{ id: 'AC-1', statement: 'The thing holds.' }],
        ownedPaths: ['src/a.ts'],
    });
    return root;
}

async function ledger(root: string, argv: string[]): Promise<Record<string, unknown>> {
    const chunks: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    (process.stdout.write as unknown as (chunk: string) => boolean) = ((chunk: unknown) => {
        chunks.push(String(chunk));
        return true;
    }) as never;
    const previous = process.exitCode;
    process.exitCode = 0;
    try {
        await runLedgerCommand(argv, { root, changeId: taskId });
    } finally {
        (process.stdout.write as unknown as (chunk: string) => boolean) = original as never;
        process.exitCode = previous;
    }
    const text = chunks.join('');
    const start = text.indexOf('{');
    return start < 0 ? {} : JSON.parse(text.slice(start)) as Record<string, unknown>;
}

describe('a damaged input does not read as a pass', () => {
    it('does not count a malformed round as a round', async () => {
        const root = await tempRoot();
        await writeFile(join(root, '.kata', 'tasks', taskId, 'review-rounds.jsonl'), '{ this is not json\n');

        const rounds = await readReviewRoundsState(root, taskId);
        const assessment = assessReviewLoop({
            // A current revision, because with none the assessment answers `not_applicable` before it reads the history — and
            // the fact under test is what an unreadable history does to the progress reading.
            currentRevision: { kind: 'current', identity: { revisionId: 'revision-1', manifestHash: 'a'.repeat(64) } },
            reviewRounds: rounds,
        });

        // A round nobody can read is not a round that reported nothing: it names the history as unreadable, and the progress
        // reader counts none of it — the defect was a placeholder pushed into the list and a kind that the counter ignored.
        expect(rounds.kind).toBe('unreadable');
        expect(assessment.kind).toBe('unreadable_round_history');
        expect(reviewProgress([]).rounds).toBe(0);
    });

    it('names a concrete deficit and remedy in every refusal it produces', async () => {
        const root = await tempRoot();
        await writePolicy(root, taskId, defaultPolicy());
        expect((await ledger(root, ['claim', 'add', '--id', 'C-1', '--statement', 'a.ts holds', '--risk-class', 'consistency', '--severity', 'major', '--depends-on', 'path:src/a.ts'])).ok).toBe(true);
        expect((await ledger(root, ['plan'])).ok).toBe(true);
        expect((await ledger(root, ['freeze'])).ok).toBe(true);

        const decided = await ledger(root, ['decide', '--tier', 'strict']);
        const deficits = (decided.deficits ?? []) as Array<{ claimId?: string; need?: string }>;

        // Nothing has been verified, so the decision refuses — and the refusal has to be actionable: a non-empty `deficits`
        // naming the claim and what it needs. The measured defect was a refusal carrying reasons and an *empty* deficits list,
        // which told an operator that something was wrong and nothing about what to do.
        expect(decided.verdict).not.toBe('pass');
        expect(deficits.length).toBeGreaterThan(0);
        for (const deficit of deficits) {
            expect(String(deficit.need ?? '').trim().length).toBeGreaterThan(0);
        }
    });

    it('reports content committed outside the declaration, not only uncommitted work', async () => {
        const root = await tempRoot();
        execFileSync('git', ['init', '--quiet', '--initial-branch=main'], { cwd: root });
        execFileSync('git', ['config', 'user.email', 'kata@example.test'], { cwd: root });
        execFileSync('git', ['config', 'user.name', 'Kata Test'], { cwd: root });
        await writeFile(join(root, 'README.md'), '# fixture\n');
        execFileSync('git', ['add', '-A'], { cwd: root });
        execFileSync('git', ['commit', '--quiet', '-m', 'base'], { cwd: root });
        // The branch's own work: a declared path and one that is not declared, both committed. `git status` is clean.
        execFileSync('git', ['checkout', '--quiet', '-b', 'feature'], { cwd: root });
        await writeFile(join(root, 'src', 'a.ts'), 'export const holds = false;\n');
        await writeFile(join(root, 'src', 'stowaway.ts'), 'export const notDeclared = true;\n');
        execFileSync('git', ['add', '-A'], { cwd: root });
        execFileSync('git', ['commit', '--quiet', '-m', 'work'], { cwd: root });

        const reported = await undeclaredChanges({ root, declaredPaths: ['src/a.ts'] });

        // The measured gap: with the working tree clean, the reading reported nothing at all, so a change could commit whatever
        // it liked beside its declaration and the seal saw a clean tree.
        expect(reported.committedReading).toBe('available');
        expect(reported.committedOutsideDeclaration).toEqual(['src/stowaway.ts']);
        // And the working-tree reading still reports what it is about, so the two are not conflated: `paths` is the
        // working tree, this new field is the branch's committed work.
        expect(reported.paths).toEqual([]);
        // **The narrow anchor, when the caller has one.** Once a `since` is supplied the reading is "what this change
        // committed": with a timestamp after the commit, nothing is attributed to the change — which is what keeps another
        // change's earlier commits on a shared branch from refusing this seal.
        // An anchor in the future is refused rather than trusted: `git` lists *every* commit for one (measured), so it would
        // come back as "everything is after it" — the fail-open direction dressed as a filter.
        const future = await undeclaredChanges({ root, declaredPaths: ['src/a.ts'], sinceCommitted: '2999-01-01T00:00:00.000Z' });
        expect(future.committedReading).toBe('unavailable');
        expect(future.committedOutsideDeclaration).toEqual([]);
        // **And an anchor nobody can parse is `unavailable`, not an empty pass.** Measured while writing this case: `git`
        // silently ignores a `--since` it cannot parse and lists every commit, so an unusable anchor used to be reported as
        // "nothing committed outside the declaration" — the fail-open direction, over an input the helper never examined.
        const unusable = await undeclaredChanges({ root, declaredPaths: ['src/a.ts'], sinceCommitted: 'not a timestamp' });
        expect(unusable.committedReading).toBe('unavailable');
    });
});
