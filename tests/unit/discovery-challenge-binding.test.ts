import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runLedgerCommand } from '../../src/cli/ledger.js';
import { readLedger } from '../../src/store/ledger.js';

/**
 * **A challenge is a reproduction of a declared falsifier, not a shell string.**
 *
 * The discovery floor used to be satisfiable by `challenge add --command 'exit 0'` plus one check: the record was terminal,
 * its observation was non-blank, and nothing compared the check to anything the change had declared. This suite pins the
 * bound form at the layer an author actually uses — the verbs — and proves that a free command cannot stand in for it.
 *
 * The falsifier's own verifier is the one that runs: baseline, injected defect, restored baseline. A check that stays green
 * while its declared defect is injected is not evidence of anything, which is exactly what the free form could not express.
 */
let root: string;
const changeId = 'challenge-binding';
let previousExitCode: number | string | null | undefined;

beforeEach(async () => {
    previousExitCode = process.exitCode;
    process.exitCode = 0;
    root = await mkdtemp(join(tmpdir(), 'kata-challenge-binding-'));
    await mkdir(join(root, '.kata', 'tasks', changeId), { recursive: true });
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src', 'a.ts'), 'export const holds = true;\n');
    await writeFile(
        join(root, '.kata', 'tasks', changeId, 'task.json'),
        `${JSON.stringify({ id: changeId, ownedPaths: ['src/a.ts'] }, null, 2)}\n`,
    );
});

afterEach(async () => {
    process.exitCode = previousExitCode;
    await rm(root, { recursive: true, force: true });
    vi.restoreAllMocks();
});

async function ledger(argv: string[]): Promise<Record<string, unknown>> {
    const chunks: string[] = [];
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

/** One claim, one executable falsifier whose mutation really does redden its command. */
async function declareFalsifier(): Promise<void> {
    await ledger(['policy', '--init']);
    await ledger(['freeze']);
    const path = join(root, 'submission.json');
    await writeFile(path, `${JSON.stringify({
        claims: [{
            id: 'C1',
            statement: 'the export is present',
            riskClass: 'consistency',
            severity: 'major',
            dependsOn: ['path:src/a.ts'],
            evidenceIds: ['E1'],
            challengeIds: [],
            status: 'open',
            at: '2026-10-06T00:00:00.000Z',
            reopens: 0,
        }],
        evidence: [{
            id: 'E1',
            type: 'executable_falsifier',
            command: 'grep -q "holds = true" src/a.ts',
            mutation: { file: 'src/a.ts', find: 'holds = true', replace: 'holds = false' },
        }, {
            id: 'E2',
            type: 'static_witness',
            ref: 'src/a.ts',
            assertion: 'contains:holds',
        }],
    }, null, 2)}\n`);
    await ledger(['evidence', 'add', '--file', path]);
}

const codesOf = (output: Record<string, unknown>): string[] =>
    (output.reasons as Array<{ code: string }>).map((reason) => reason.code);

describe('a challenge bound to a declared falsifier', () => {
    it('records the falsifier, the subject it ran against and the verifier outcome', async () => {
        await declareFalsifier();
        const added = await ledger(['challenge', 'add', '--claim', 'C1', '--falsifier', 'E1', '--id', 'X1']);
        expect(process.exitCode).toBe(0);
        expect(added.challenge).toMatchObject({ id: 'X1', claimId: 'C1', falsifierEvidenceId: 'E1' });

        const checked = await ledger(['challenge', 'check', '--id', 'X1']);
        expect(process.exitCode).toBe(0);
        expect(checked.outcomes).toHaveLength(1);

        const stored = await readLedger(root, changeId);
        const challenge = stored.challenges.find((entry) => entry.id === 'X1');
        const subject = stored.subject?.revision;
        expect(subject).toBeTruthy();
        expect(challenge?.falsifierEvidenceId).toBe('E1');
        expect(challenge?.state).toBe('withdrawn');
        // The resolution is the *binding*, not only an observation: which falsifier, which subject, and what the verifier
        // decided. Without all three a later subject could inherit this reading.
        expect(challenge?.resolution).toMatchObject({
            falsifierEvidenceId: 'E1',
            subjectRevision: subject,
            verdict: 'supported',
        });
    });

    it('counts as executed discovery at the layer that decides', async () => {
        await declareFalsifier();
        await ledger(['challenge', 'add', '--claim', 'C1', '--falsifier', 'E1', '--id', 'X1']);
        await ledger(['challenge', 'check', '--id', 'X1']);

        const decision = await ledger(['decide']);
        expect(codesOf(decision)).not.toContain('discovery_floor');
        expect(codesOf(decision)).not.toContain('discovery_unverified');
    });

    it('does not count a free command as current discovery, however it ends', async () => {
        // The old form: a terminal record with a non-blank observation. It is still readable — legacy records stay legible —
        // but it is not a reproduction of anything this change declared, so the floor must still refuse.
        await declareFalsifier();
        const added = await ledger(['challenge', 'add', '--claim', 'C1', '--command', 'exit 0', '--id', 'X9']);
        expect(added.challenge).not.toHaveProperty('falsifierEvidenceId');
        await ledger(['challenge', 'check', '--id', 'X9']);

        const stored = await readLedger(root, changeId);
        const legacy = stored.challenges.find((entry) => entry.id === 'X9');
        expect(legacy?.state).toBe('withdrawn');
        expect(legacy?.resolution?.observed).toBeTruthy();

        const decision = await ledger(['decide']);
        expect(codesOf(decision)).toContain('discovery_floor');
    });

    it('refuses a falsifier the claim does not name, an item that is not a falsifier, and a challenge with neither form', async () => {
        await declareFalsifier();

        await ledger(['challenge', 'add', '--claim', 'C1', '--falsifier', 'E404', '--id', 'X1']);
        expect(process.exitCode).toBe(1);

        // `E2` is a static witness: it has no mutation to inject, so no falsifier run exists to bind.
        await ledger(['challenge', 'add', '--claim', 'C1', '--falsifier', 'E2', '--id', 'X2']);
        expect(process.exitCode).toBe(1);

        await ledger(['challenge', 'add', '--claim', 'C1', '--id', 'X3']);
        expect(process.exitCode).toBe(1);

        const stored = await readLedger(root, changeId);
        expect(stored.challenges).toHaveLength(0);
    });

    it('refuses a falsifier run whose command was already failing before any mutation', async () => {
        // A check that is red before the defect is injected is reporting a defect that is already present. The verifier says
        // `refuted` with a named cause, and a refuted run must not withdraw the challenge: the floor needs an execution that
        // actually decided something about this change.
        await ledger(['policy', '--init']);
        await ledger(['freeze']);
        const path = join(root, 'submission.json');
        await writeFile(path, `${JSON.stringify({
            claims: [{
                id: 'C1', statement: 'the export is present', riskClass: 'consistency', severity: 'major',
                dependsOn: ['path:src/a.ts'], evidenceIds: ['E1'], challengeIds: [], status: 'open',
                at: '2026-10-06T00:00:00.000Z', reopens: 0,
            }],
            evidence: [{
                id: 'E1',
                type: 'executable_falsifier',
                command: 'grep -q "holds = absent" src/a.ts',
                mutation: { file: 'src/a.ts', find: 'holds = true', replace: 'holds = false' },
            }],
        }, null, 2)}\n`);
        await ledger(['evidence', 'add', '--file', path]);
        await ledger(['challenge', 'add', '--claim', 'C1', '--falsifier', 'E1', '--id', 'X1']);
        await ledger(['challenge', 'check', '--id', 'X1']);

        const stored = await readLedger(root, changeId);
        const challenge = stored.challenges.find((entry) => entry.id === 'X1');
        expect(challenge?.resolution).toMatchObject({ verdict: 'refuted' });
        expect(challenge?.state).toBe('open');

        // Both refusals are true and they are different facts: an open counterexample blocks (`challenge_open`), and a
        // bound attempt that decided nothing leaves the floor unverified (`discovery_unverified`). The point of the case is
        // that a refuted run neither withdraws the challenge nor counts as a reading.
        const decision = await ledger(['decide']);
        expect(codesOf(decision)).toContain('challenge_open');
        expect(codesOf(decision)).toContain('discovery_unverified');
        expect(codesOf(decision)).not.toContain('discovery_floor');
    });
});
