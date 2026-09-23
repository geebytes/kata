import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initLayout } from '../../src/core/layout.js';
import { createTask } from '../../src/core/task.js';
import { createTaskRevision } from '../../src/workflow/revision.js';
import { writeAdversarialRecord } from '../../src/quality/adversarial.js';
import { persistBlockingFindings, readObligations } from '../../src/quality/repair-obligations.js';
import { recordFalsifierReddening } from '../../src/quality/falsifier-reddenings.js';

const roots: string[] = [];
afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/**
 * AC-3: `adversarial status` distinguishes an obligation answered by evidence from one answered **and falsified**. Before
 * this the two read identically, so a batch that closed on evidence alone looked exactly like one whose repairs were shown to
 * bite — and a change sealed before the criterion existed was indistinguishable from one that met it.
 *
 * Four attempts went into this case, and every one of them failed for a reason it was not about. The causes, kept here so the
 * next person does not pay them again: `readObligations` swallowed a validation failure into an empty list (fixed — a record
 * that fails validation is not an absent record); and **the command reports the full shape, including `obligations`, only when
 * a node has a record** — without a revision and a record the list was simply absent while the obligations sat on disk.
 */
async function fixture(id: string): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'kata-visibility-'));
    roots.push(root);
    await initLayout(root);
    await createTask({ root, id, title: 'Visibility', acceptance: [{ id: 'AC-1', statement: 'An obligation says how it was answered.' }] });
    // The two things the command needs to report the full shape rather than its early one.
    await createTaskRevision({ root, taskId: id, ownedPaths: ['src/x.ts'], checkIds: [] });
    await writeAdversarialRecord(root, id, {
        node: 'review',
        status: 'recorded',
        revisionId: 'revision-one',
        manifestHash: 'h',
        executedInFreshContext: true,
        contextNote: 'a fixture',
        createdAt: '2026-09-23T01:00:00.000Z',
        hypotheses: [],
        attempts: [],
        findings: [],
    } as never);
    return root;
}

describe('the status report distinguishes how an obligation was answered', () => {
    it('reports the obligations with the distinction, and asserts the setup before the subject', async () => {
        const root = await fixture('vis');
        const created = await persistBlockingFindings(root, 'vis', [
            { id: 'reddened-finding', severity: 'major', message: 'm' },
            { id: 'unreddened-finding', severity: 'major', message: 'm' },
        ]);
        expect(created).toHaveLength(2);
        await recordFalsifierReddening(root, 'vis', {
            findingId: 'reddened-finding',
            check: 'tests/unit/x.test.ts',
            mutation: 'revert',
            revisionId: 'revision-one',
            reddenedAt: '2026-09-23T02:00:00.000Z',
        });
        // The setup, before the subject.
        expect((await readObligations(root, 'vis')).map((obligation) => obligation.findingId).sort())
            .toEqual(['reddened-finding', 'unreddened-finding']);

        // **The command resolves its root from `process.cwd()`, not from an argument** — which is why four attempts read an
        // empty list: the obligations were on disk in the fixture while the command was reading the repository it was run
        // from. Found by probing the command's own input rather than the reader's.
        const previous = process.cwd();
        process.chdir(root);
        const { runAdversarialCommand } = await import('../../src/cli/ops.js');
        const status = await runAdversarialCommand(['status', '--change', 'vis', '--json']).finally(() => process.chdir(previous));
        const reported = (status.obligations ?? []) as Array<{ findingId: string | null; answeredBy: string | null }>;
        expect(reported).toHaveLength(2);
        // Unresolved until something answers them — "not answered" is its own value, not a default that erases it.
        expect(reported.every((entry) => entry.answeredBy === null)).toBe(true);

        // Now answer them and assert the **distinction**, which is what AC-3 is about: the reddened finding resolves and is
        // reported as answered by evidence **and** a falsifier; the other cannot resolve at all, because the criterion
        // refuses it — so it stays null rather than being reported as answered on evidence alone. `evidence-only` is
        // therefore the legacy state, which is why the real change shows seven of them.
        const { resolveObligationsForRevision } = await import('../../src/quality/repair-obligations.js');
        const passing = [{ id: 'e1', taskId: 'vis', kind: 'test', command: 'vitest', exitCode: 0, startedAt: '2026-09-23T01:00:00.000Z', finishedAt: '2026-09-23T01:01:00.000Z', diffHash: 'a'.repeat(64) }];
        await resolveObligationsForRevision(root, 'vis', 'revision-one', ['AC-1'], ['e1'], undefined, passing as never);

        process.chdir(root);
        const after = await runAdversarialCommand(['status', '--change', 'vis', '--json']).finally(() => process.chdir(previous));
        const answered = (after.obligations ?? []) as Array<{ findingId: string | null; answeredBy: string | null }>;
        expect(answered.find((entry) => entry.findingId === 'reddened-finding')?.answeredBy).toBe('evidence-and-falsifier');
        expect(answered.find((entry) => entry.findingId === 'unreddened-finding')?.answeredBy).toBeNull();
    });
});
