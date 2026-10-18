import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { initLayout } from '../../src/core/layout.js';
import { createTask } from '../../src/core/task.js';
import { createTaskRevisionIfChanged } from '../../src/workflow/revision.js';
import {
    declareCorrectiveAction,
    readCorrectiveActionStatus,
    readCorrectiveActions,
} from '../../src/workflow/corrective-action.js';
import { runCorrectiveCommand } from '../../src/cli/corrective.js';

/**
 * **One class, one owner.**
 *
 * The design separates a delivery slice from a corrective action, and the second half had no representation: nothing
 * recorded that a task exists *because of a class*, so a reviewer reporting the same class again was free to start another
 * task. Measured on this repository: five consecutive rounds, three classes, three sites, each repair widening the same
 * enumeration.
 *
 * The record is the mechanism, and it carries two rules. A class that is still open has one owner — a second declaration is
 * refused, naming the first. And the class contract is the review loop's own seven-field obligation, read by the reader the
 * recurrence packet and the seal already use, so this cannot become a second definition of the same class.
 */

const roots: string[] = [];

function write(root: string, relativePath: string, content: string): void {
    const target = join(root, relativePath);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
}

async function fixture(name: string): Promise<string> {
    const root = mkdtempSync(join(tmpdir(), `kata-corrective-${name}-`));
    roots.push(root);
    await initLayout(root);
    write(root, 'src/a.ts', 'a v1\n');
    for (const id of ['delivery', 'corrective-a', 'corrective-b']) {
        await createTask({ root, id, title: id, acceptance: [{ id: 'AC-1', statement: 'x' }], ownedPaths: ['src/a.ts'] });
    }
    return root;
}

function obligation(over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        states: ['no record', 'record present'],
        sourceOfTruth: 'src/workflow/task-dependency.ts#decideTaskDependencies',
        inventory: ['src/workflow/task-dependency.ts the reader', 'src/cli/dependency.ts the writer'],
        invariant: 'every consumer of the decision asks decideTaskDependencies',
        repairSurface: ['src/workflow/task-dependency.ts'],
        effectivenessTest: 'tests/unit/a-blocked-task-cannot-cross-its-gate.test.ts',
        ifRecursAgain: 'rewrite_mechanism',
        ...over,
    };
}

/** Certify a task the way the gate reads certification: a Judge pass bound to its current revision. */
async function certify(root: string, id: string): Promise<string> {
    const { revision } = await createTaskRevisionIfChanged({ root, taskId: id, ownedPaths: ['src/a.ts'] });
    write(root, `.kata/tasks/${id}/judge.json`, `${JSON.stringify({
        taskId: id,
        result: 'PASS',
        revisionId: revision.id,
        acceptance: [{ id: 'AC-1', result: 'PASS' }],
    }, null, 2)}\n`);
    return revision.id;
}

afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('a corrective action declares which class it discharges', () => {
    it('records the contract, the source change and the owner', async () => {
        const root = await fixture('declare');
        const declared = await declareCorrectiveAction({
            root,
            taskId: 'corrective-a',
            classKey: 'one-fact-derived-twice',
            sourceChangeId: 'delivery',
            owner: 'the-owner',
            obligation: obligation(),
            sourceFindingIds: ['gate-r9-F1'],
        });
        expect(declared.declaration.classKey).toBe('one-fact-derived-twice');
        expect(declared.declaration.sourceChangeId).toBe('delivery');
        expect(declared.status.discharged).toBe(false);

        const stored = JSON.parse(readFileSync(join(root, '.kata/tasks/corrective-a/corrective-action.json'), 'utf8')) as { obligation: { invariant: string } };
        expect(stored.obligation.invariant).toMatch(/asks decideTaskDependencies/u);
    });

    it('refuses a second owner for a class that is still open, and names the first', async () => {
        const root = await fixture('one-owner');
        await declareCorrectiveAction({
            root, taskId: 'corrective-a', classKey: 'one-fact-derived-twice', sourceChangeId: 'delivery', owner: 'the-owner', obligation: obligation(),
        });
        await expect(declareCorrectiveAction({
            root, taskId: 'corrective-b', classKey: 'one-fact-derived-twice', sourceChangeId: 'delivery', owner: 'someone-else', obligation: obligation(),
        })).rejects.toThrow(/already owned by 'corrective-a' \(owner: the-owner\)/u);
        // The road, not just the refusal: the operator's next move is a decision, not a new task.
        await expect(declareCorrectiveAction({
            root, taskId: 'corrective-b', classKey: 'one-fact-derived-twice', sourceChangeId: 'delivery', owner: 'someone-else', obligation: obligation(),
        })).rejects.toThrow(/Carry the finding there, or discharge that task first/u);
    });

    it('frees the class once the corrective task is certified', async () => {
        const root = await fixture('discharged');
        await declareCorrectiveAction({
            root, taskId: 'corrective-a', classKey: 'one-fact-derived-twice', sourceChangeId: 'delivery', owner: 'the-owner', obligation: obligation(),
        });
        await certify(root, 'corrective-a');
        expect((await readCorrectiveActionStatus(root, 'corrective-a')).discharged).toBe(true);

        // The same class may now be owned again — the previous repair is spent, so a recurrence is a new action rather than
        // a duplicate of one that never landed.
        const second = await declareCorrectiveAction({
            root, taskId: 'corrective-b', classKey: 'one-fact-derived-twice', sourceChangeId: 'delivery', owner: 'someone-else', obligation: obligation(),
        });
        expect(second.declaration.taskId).toBe('corrective-b');
    });

    it('tells two classes apart by their invariant, not only by their name', async () => {
        const root = await fixture('same-label');
        await declareCorrectiveAction({
            root, taskId: 'corrective-a', classKey: 'instrument_unsound', sourceChangeId: 'delivery', owner: 'the-owner', obligation: obligation(),
        });
        // A coarse label is a family, not a class: an unrelated defect that happens to share the name must not be blocked.
        const other = await declareCorrectiveAction({
            root,
            taskId: 'corrective-b',
            classKey: 'instrument_unsound',
            sourceChangeId: 'delivery',
            owner: 'someone-else',
            obligation: obligation({ invariant: 'a case that drives a bundle must drive the revision under review' }),
        });
        expect(other.declaration.taskId).toBe('corrective-b');
    });

    it('refuses a declaration with no contract, and one with a contract its own reader rejects', async () => {
        const root = await fixture('bad-obligation');
        await expect(declareCorrectiveAction({
            root, taskId: 'corrective-a', classKey: 'x', sourceChangeId: 'delivery', owner: 'o', obligation: undefined,
        })).rejects.toThrow(/the obligation is missing/u);
        await expect(declareCorrectiveAction({
            root, taskId: 'corrective-a', classKey: 'x', sourceChangeId: 'delivery', owner: 'o', obligation: obligation({ ifRecursAgain: 'repair_again' }),
        })).rejects.toThrow(/ifRecursAgain is not one of/u);
    });

    it('refuses to declare over a declaration it cannot read, rather than replacing it silently', async () => {
        const root = await fixture('damaged');
        await declareCorrectiveAction({
            root, taskId: 'corrective-a', classKey: 'one-fact-derived-twice', sourceChangeId: 'delivery', owner: 'the-owner', obligation: obligation(),
        });
        write(root, '.kata/tasks/corrective-a/corrective-action.json', '{ "taskId": "corrective-a", "classKey": 42 }\n');
        await expect(declareCorrectiveAction({
            root, taskId: 'corrective-b', classKey: 'other', sourceChangeId: 'delivery', owner: 'o', obligation: obligation(),
        })).rejects.toThrow(/cannot be read/u);
    });
});

describe('the repository view of which classes are owned', () => {
    it('lists open and discharged actions, and keeps an unreadable declaration its own answer', async () => {
        const root = await fixture('repository-view');
        await declareCorrectiveAction({
            root, taskId: 'corrective-a', classKey: 'one-fact-derived-twice', sourceChangeId: 'delivery', owner: 'the-owner', obligation: obligation(),
        });
        await declareCorrectiveAction({
            root, taskId: 'corrective-b', classKey: 'refusal-cannot-be-executed', sourceChangeId: 'delivery', owner: 'someone-else', obligation: obligation({ invariant: 'a refusal prints a command that runs' }),
        });
        await certify(root, 'corrective-b');

        const view = await readCorrectiveActions(root);
        expect(view.unreadable).toEqual([]);
        expect(view.open.map((entry) => `${entry.taskId}:${entry.discharged}`).sort()).toEqual(['corrective-a:false', 'corrective-b:true']);
    });

    it('reports the repository view through the CLI, with the counts an operator decides on', async () => {
        const root = await fixture('cli-view');
        // The contract is a document, and its path is read relative to the root, as an operator would write it.
        write(root, 'obligation.json', `${JSON.stringify(obligation(), null, 2)}\n`);
        const declared = await runCorrectiveCommand([
            'declare', '--change', 'corrective-a', '--source-change', 'delivery', '--class', 'one-fact-derived-twice',
            '--owner', 'the-owner', '--obligation-file', 'obligation.json', '--root', root,
        ]);
        expect(declared.classKey).toBe('one-fact-derived-twice');
        expect(String(declared.message)).toMatch(/until its current revision carries a Judge pass/u);

        const view = await runCorrectiveCommand(['status', '--all', '--root', root]);
        expect(view.openCount).toBe(1);
        expect(view.dischargedCount).toBe(0);

        // And a second owner for the same class is refused through the CLI too, which is where it will actually be typed.
        await expect(runCorrectiveCommand([
            'declare', '--change', 'corrective-b', '--source-change', 'delivery', '--class', 'one-fact-derived-twice',
            '--owner', 'someone-else', '--obligation-file', 'obligation.json', '--root', root,
        ])).rejects.toThrow(/already owned by 'corrective-a'/u);
    });
});
