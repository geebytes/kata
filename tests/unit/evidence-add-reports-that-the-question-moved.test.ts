import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runLedgerCommand } from '../../src/cli/ledger.js';
import { readLedger } from '../../src/store/ledger.js';
import { writeTaskRecord } from '../helpers/task-fixture.js';

/**
 * **The drift is reported where it is created — by every writer that can create it.**
 *
 * Four commands move the declared question: `ledger evidence add` (it writes the submission's claims), `ledger claim add`,
 * `ledger claim restate` and `ledger plan` (the plan is half of the question). Learning about the move at `decide` — after the
 * reading has been taken, stamped and ignored — is learning it too late, so each of them reports it. The first version wired
 * only `evidence add`; an independent round measured the other three as silent, which falsified this criterion's own
 * universal clause.
 *
 * The controls matter as much as the assertions: a submission that only fills in `evidenceIds` does **not** move the question
 * (`evidenceIds` is bookkeeping about the answer, not part of it), and a claim added while nothing is frozen cannot move a
 * question that does not exist yet — so a report that always appeared would be as wrong as one that never did.
 */
const changeId = 'evidence-add-reports';
let root = '';
let previousExitCode: number | string | null | undefined;
const chunks: string[] = [];

async function ledger(argv: string[]): Promise<Record<string, unknown>> {
    chunks.length = 0;
    process.exitCode = 0;
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
        chunks.push(String(chunk));
        return true;
    });
    try {
        await runLedgerCommand(argv, { root, changeId });
    } finally {
        spy.mockRestore();
    }
    const text = chunks.join('');
    const start = text.indexOf('{');
    return start < 0 ? {} : (JSON.parse(text.slice(start)) as Record<string, unknown>);
}

async function submit(name: string, body: Record<string, unknown>): Promise<string> {
    const path = join(root, `${name}.json`);
    await writeFile(path, `${JSON.stringify(body, null, 2)}\n`);
    return path;
}

const declaredClaim = (id: string) => ({
    id,
    statement: `the ${id} question holds`,
    riskClass: 'boundary',
    severity: 'major',
    dependsOn: ['path:src/a.ts'],
    evidenceIds: ['E1'],
    challengeIds: [],
    status: 'open',
    at: '',
    reopens: 0,
});

const falsifier = {
    id: 'E1',
    type: 'executable_falsifier',
    command: 'grep -q "holds = true" src/a.ts',
    mutation: { file: 'src/a.ts', find: 'holds = true', replace: 'holds = false' },
};

beforeEach(async () => {
    previousExitCode = process.exitCode;
    root = await mkdtemp(join(tmpdir(), 'kata-evidence-add-reports-'));
    await mkdir(join(root, 'src'), { recursive: true });
    await mkdir(join(root, '.kata', 'tasks', changeId), { recursive: true });
    await writeFile(join(root, 'src', 'a.ts'), 'export const holds = true;\n');
    await writeTaskRecord(root, { id: changeId, phase: 'implement', ownedPaths: ['src/a.ts'] });
    await ledger(['policy', '--init']);
    await ledger(['claim', 'add', '--id', 'C1', '--statement', 'the export holds', '--risk-class', 'consistency', '--severity', 'major', '--depends-on', 'path:src/a.ts']);
    await ledger(['freeze']);
});

afterEach(async () => {
    process.exitCode = previousExitCode;
    await rm(root, { recursive: true, force: true });
    vi.restoreAllMocks();
});

describe('evidence add reports a question it moved', () => {
    it('names both revisions and the remedy when the claims it wrote moved the declared question', async () => {
        const frozen = (await readLedger(root, changeId)).subject?.revision ?? '';
        const file = await submit('moves', { claims: [declaredClaim('C2')], evidence: [falsifier] });

        const result = await ledger(['evidence', 'add', '--file', file]);

        expect(result.ok).toBe(true);
        const declared = (await readLedger(root, changeId)).subjectAsDeclared?.revision ?? '';
        expect(declared).not.toBe(frozen);
        expect(result.questionMoved).toMatchObject({ frozen, declared });
        expect(String(result.remedy)).toContain(`kata-cli ledger freeze --change ${changeId}`);
        expect(String(result.questionMovedNote)).toContain('re-frozen');
    });

    it('says nothing when the submission only fills in evidence bindings', async () => {
        // **The control, and the fact the report got wrong.** `evidenceIds` is not part of the question, so writing it must
        // not report a move — and must not move anything.
        const frozen = (await readLedger(root, changeId)).subject?.revision ?? '';
        const existing = (await readLedger(root, changeId)).claims.find((claim) => claim.id === 'C1');
        const file = await submit('binds', { claims: [{ ...existing, evidenceIds: ['E1'] }], evidence: [falsifier] });

        const result = await ledger(['evidence', 'add', '--file', file]);

        expect(result.ok).toBe(true);
        expect(result.questionMoved).toBeUndefined();
        expect(result.remedy).toBeUndefined();
        expect((await readLedger(root, changeId)).subjectAsDeclared?.revision).toBe(frozen);
        // And the reading this submission was about is still takeable: no refusal follows from binding evidence.
        expect((await ledger(['evidence', 'verify'])).ok).toBe(true);
    });

    it('still reports the move when a later write in the same submission is refused', async () => {
        // **A refusal must not hide the change the command already made.** The claims are written before the evidence, so
        // a submission whose evidence write is refused has *still* moved the question — and reporting only the evidence
        // conflict sent the operator to fix that while the ledger stayed in the state where no reading counts. Measured by
        // an independent round: `evidence add` returned ok=false with no `questionMoved`, and the next `evidence verify`
        // refused with the moved question.
        const frozen = (await readLedger(root, changeId)).subject?.revision ?? '';
        await submit('first', { claims: [], evidence: [falsifier] });
        expect((await ledger(['evidence', 'add', '--file', join(root, 'first.json')])).ok).toBe(true);

        // The same evidence id again, with different content: write-once refuses it — after the claim below is written.
        const file = await submit('conflicting', {
            claims: [declaredClaim('C2')],
            evidence: [{ ...falsifier, command: 'grep -q "holds = true" src/a.ts # a different check' }],
        });
        const result = await ledger(['evidence', 'add', '--file', file]);

        expect(result.ok).toBe(false);
        const declared = (await readLedger(root, changeId)).subjectAsDeclared?.revision ?? '';
        expect(declared).not.toBe(frozen);
        expect(result.questionMoved).toMatchObject({ frozen, declared });
        expect(String(result.remedy)).toContain(`kata-cli ledger freeze --change ${changeId}`);
    });

    it('reports it from `claim add`, which is the other way a claim arrives', async () => {
        const frozen = (await readLedger(root, changeId)).subject?.revision ?? '';

        const result = await ledger(['claim', 'add', '--id', 'C2', '--statement', 'the second question holds', '--risk-class', 'boundary', '--severity', 'major', '--depends-on', 'path:src/a.ts']);

        expect(result.ok).toBe(true);
        const declared = (await readLedger(root, changeId)).subjectAsDeclared?.revision ?? '';
        expect(declared).not.toBe(frozen);
        expect(result.questionMoved).toMatchObject({ frozen, declared });
        expect(String(result.questionMovedNote)).toContain('claim just added');
    });

    it('reports it from `claim restate`, where the content never moves at all', async () => {
        const frozen = (await readLedger(root, changeId)).subject?.revision ?? '';

        const result = await ledger(['claim', 'restate', '--id', 'C1', '--statement', 'the export holds, restated']);

        expect(result.ok).toBe(true);
        const declared = (await readLedger(root, changeId)).subjectAsDeclared?.revision ?? '';
        expect(declared).not.toBe(frozen);
        expect(result.questionMoved).toMatchObject({ frozen, declared });
    });

    it('reports it from `ledger plan`, because the plan is half of the question', async () => {
        // The other half of the question, and the one that moves without any claim or content changing: the plan digest is
        // hashed into the subject, so a re-plan on a changed tree moves it.
        const frozen = (await readLedger(root, changeId)).subject?.revision ?? '';
        await writeFile(join(root, 'src', 'a.ts'), 'export const holds = true;\nexport const extra = 1;\n');

        const result = await ledger(['plan']);

        expect(result.ok).toBe(true);
        const declared = (await readLedger(root, changeId)).subjectAsDeclared?.revision ?? '';
        expect(declared).not.toBe(frozen);
        expect(result.questionMoved).toMatchObject({ frozen, declared });
    });

    it('says nothing from `claim add` while nothing is frozen', async () => {
        // The control: with no subject there is no question to move, so a report here would be a false alarm.
        await rm(join(root, '.kata', 'tasks', changeId, 'review', 'subject.json'), { force: true });

        const result = await ledger(['claim', 'add', '--id', 'C3', '--statement', 'a claim before any freeze', '--risk-class', 'boundary', '--severity', 'major']);

        expect(result.ok).toBe(true);
        expect(result.questionMoved).toBeUndefined();
        expect(result.remedy).toBeUndefined();
    });
});
