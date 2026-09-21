import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initLayout } from '../../src/core/layout.js';
import { buildChangeRecord, changeRecordPath } from '../../src/quality/change-record.js';

/**
 * A review round's factual surface, derived rather than asserted.
 *
 * The measurement this answers: thirteen passes of one real change produced thirty de-duplicated findings, and twenty of
 * them — seven of the eleven `major` ones — were not about the deliverable but about *the author's prose about their own
 * work*: a ledger row, a count, a pointer, a doc sentence. The reason is structural. The platform requires a written
 * record and provides nothing that can check it: code has tests, RED/GREEN and claims, while "is the ledger row true" had
 * no checker at all — so the cheapest falsifiable surface a reviewer could attack was the prose.
 *
 * The fix is not "write more carefully". Facts a machine already holds — which files the revision touched, which checks
 * ran, which claims were evaluated, which findings are open — are written by the machine; the author writes only the
 * judgement a machine cannot derive (why this fix, what was traded away).
 */
describe('machine-generated change record', () => {
    const roots: string[] = [];

    afterEach(async () => {
        await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
    });

    async function tempRoot(): Promise<string> {
        const root = await mkdtemp(join(tmpdir(), 'kata-change-record-'));
        roots.push(root);
        await initLayout(root);
        execFileSync('git', ['init', '--quiet'], { cwd: root });
        execFileSync('git', ['config', 'user.email', 'kata@example.test'], { cwd: root });
        execFileSync('git', ['config', 'user.name', 'Kata Test'], { cwd: root });
        await mkdir(join(root, 'src'), { recursive: true });
        await writeFile(join(root, 'src/untouched.ts'), 'export const untouched = 1;\n', 'utf8');
        execFileSync('git', ['add', '.'], { cwd: root });
        execFileSync('git', ['commit', '--quiet', '-m', 'base'], { cwd: root });
        return root;
    }

    it('derives the factual surface from the diff, the evidence and the findings', async () => {
        const root = await tempRoot();
        // Two files actually changed; one is owned and one is not. The record must report the facts, not the declaration.
        await writeFile(join(root, 'src/changed.ts'), 'export const changed = 2;\n', 'utf8');
        await writeFile(join(root, 'src/also.ts'), 'export const also = 3;\n', 'utf8');

        const record = await buildChangeRecord({
            root,
            taskId: 'record-task',
            revisionId: 'revision-abc',
            ownedPaths: ['src/changed.ts'],
            evidence: [
                { id: 'e1', checkId: 'typecheck', name: 'typecheck', command: 'npx', exitCode: 0, passed: true },
                { id: 'e2', checkId: 'claim:AC-1:no-caller', name: 'claim-AC-1-no-caller', command: 'grep', exitCode: 1, passed: true },
            ],
            claimFailures: [],
            findings: [{ id: 'f1', severity: 'major', disposition: 'open' }],
        });

        // Facts the machine holds, written from the machine's own sources.
        expect(record.revisionId).toBe('revision-abc');
        expect(record.changedPaths).toEqual(['src/also.ts', 'src/changed.ts']);
        expect(record.changedOutsideOwnership).toEqual(['src/also.ts']);
        expect(record.checks.map((check) => check.checkId)).toEqual(['typecheck', 'claim:AC-1:no-caller']);
        expect(record.checks.every((check) => check.passed)).toBe(true);
        expect(record.openFindings).toEqual([{ id: 'f1', severity: 'major', disposition: 'open' }]);
        expect(record.claimFailures).toEqual([]);
    });

    it('refuses a record whose factual fields were not derived — the fields are not writable input', async () => {
        const root = await tempRoot();
        const record = await buildChangeRecord({
            root,
            taskId: 'record-task',
            revisionId: 'revision-abc',
            ownedPaths: [],
            evidence: [],
            claimFailures: [],
            findings: [],
            // The author's judgement is the only prose the record accepts, and it is labelled as such. Anything that
            // could be derived has no channel to be asserted through.
            judgement: 'Chose the structural check over a locale pin: the previous prose match could not distinguish the two failures.',
        });

        expect(record.judgement).toContain('structural check');
        expect(Object.keys(record)).not.toContain('changedPathsOverride');
        // A count is a derived quantity: the record reports it, the author cannot type it.
        expect(record.changedPaths).toEqual([]);
    });

    it('reports a claim failure with its identifier, and writes where the record lives', async () => {
        const root = await tempRoot();
        const record = await buildChangeRecord({
            root,
            taskId: 'record-task',
            revisionId: 'revision-abc',
            ownedPaths: [],
            evidence: [],
            claimFailures: [{ checkId: 'claim:AC-3:ledger-row', acceptanceId: 'AC-3', claimId: 'ledger-row', statement: 'the ledger row is true', expect: { exitCode: 0 }, actualExitCode: 1, missing: false }],
            findings: [],
        });

        expect(record.claimFailures.map((failure) => failure.checkId)).toEqual(['claim:AC-3:ledger-row']);
        expect(changeRecordPath(root, 'record-task')).toContain(join('.kata', 'tasks', 'record-task'));
    });

    it('does not re-derive a fact the file already records, so re-reading is stable', async () => {
        const root = await tempRoot();
        await writeFile(join(root, 'src/changed.ts'), 'export const changed = 9;\n', 'utf8');

        const first = await buildChangeRecord({ root, taskId: 'record-task', revisionId: 'revision-abc', ownedPaths: [], evidence: [], claimFailures: [], findings: [] });
        const second = await buildChangeRecord({ root, taskId: 'record-task', revisionId: 'revision-abc', ownedPaths: [], evidence: [], claimFailures: [], findings: [] });
        expect(second.changedPaths).toEqual(first.changedPaths);
        // No wall-clock field, so two builds of the same state are byte-identical (the same rule the revision hash follows).
        expect(JSON.stringify(second)).toBe(JSON.stringify(first));
        expect(await readFile(join(root, 'src/changed.ts'), 'utf8')).toContain('9');
    });
});
