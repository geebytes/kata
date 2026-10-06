import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runLedgerCommand } from '../../src/cli/ledger.js';
import { readLedger } from '../../src/store/ledger.js';

/**
 * **A probe answer is about the question that was asked, at the revision that asked it.**
 *
 * Measured defect: a probe's identity was its position (`P1-C1`), so when the subject moved the same id came back asking a
 * different question — and the answer already on file, written for the old content, still satisfied the discovery floor.
 * The stored probe was never refreshed, and nothing compared the answer to the question. Two records claimed to be one
 * reading about content neither of them described.
 *
 * The answer now copies the fact it answers (revision, path, expected value, canonical command) and is checked against the
 * stored question. A moved subject may receive a new answer, because the new question is a different question.
 */
let root: string;
const changeId = 'probe-binding';
let previousExitCode: number | string | null | undefined;

beforeEach(async () => {
    previousExitCode = process.exitCode;
    process.exitCode = 0;
    root = await mkdtemp(join(tmpdir(), 'kata-probe-binding-'));
    await mkdir(join(root, '.kata', 'tasks', changeId), { recursive: true });
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src', 'a.ts'), 'export const version = 1;\n');
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

async function declareClaim(): Promise<void> {
    await ledger(['policy', '--init']);
    await ledger(['freeze']);
    const path = join(root, 'submission.json');
    await writeFile(path, `${JSON.stringify({
        claims: [{
            id: 'C1', statement: 'the export is present', riskClass: 'consistency', severity: 'major',
            dependsOn: ['path:src/a.ts'], evidenceIds: ['E1'], challengeIds: [], status: 'open',
            at: '2026-10-06T00:00:00.000Z', reopens: 0,
        }],
        evidence: [{ id: 'E1', type: 'static_witness', ref: 'src/a.ts', assertion: 'contains:version' }],
    }, null, 2)}\n`);
    await ledger(['evidence', 'add', '--file', path]);
}

const codesOf = (output: Record<string, unknown>): string[] =>
    (output.reasons as Array<{ code: string }>).map((reason) => reason.code);

/** Answer every question the ledger currently asks, the way a reviewer would. */
async function answerEverything(): Promise<void> {
    const stored = await readLedger(root, changeId);
    const probes = JSON.parse(await readFile(join(root, '.kata', 'tasks', changeId, 'review', 'probes.json'), 'utf8')) as Array<{ id: string }>;
    for (const probe of probes) {
        await ledger(['answer', '--probe', probe.id, '--observed', 'exit 0']);
    }
    expect(stored.subject).not.toBeNull();
}

describe('a probe answer bound to the question it answers', () => {
    it('records the revision, the path and the expected fact beside the observation', async () => {
        await declareClaim();
        const asked = await ledger(['ask', '--per-claim', '2', '--seed', 'fixed']);
        const ids = asked.asked as string[];
        expect(ids.length).toBeGreaterThan(0);

        await ledger(['answer', '--probe', ids[0]!, '--observed', 'exit 0']);
        expect(process.exitCode).toBe(0);

        const answers = JSON.parse(await readFile(join(root, '.kata', 'tasks', changeId, 'review', 'probe-answers.json'), 'utf8')) as Array<Record<string, unknown>>;
        const answer = answers.find((entry) => entry.probeId === ids[0]);
        const subject = (await readLedger(root, changeId)).subject?.revision;
        expect(answer).toMatchObject({ subjectRevision: subject, path: 'src/a.ts' });
        expect(typeof answer?.expected).toBe('string');
    });

    it('counts a bound answer as an executed reading, and a repeated answer for the same question is refused', async () => {
        await declareClaim();
        const asked = await ledger(['ask', '--per-claim', '2', '--seed', 'fixed']);
        const ids = asked.asked as string[];
        await answerEverything();

        const decision = await ledger(['decide']);
        expect(codesOf(decision)).not.toContain('discovery_floor');
        expect(codesOf(decision)).not.toContain('discovery_unverified');

        // Write-once for one exact identity: the same question at the same revision cannot be answered twice.
        await ledger(['answer', '--probe', ids[0]!, '--observed', 'exit 0']);
        expect(process.exitCode).toBe(1);
    });

    it('does not let an answer written for the previous content count after the subject moves', async () => {
        await declareClaim();
        await ledger(['ask', '--per-claim', '2', '--seed', 'fixed']);
        await answerEverything();
        expect(codesOf(await ledger(['decide']))).not.toContain('discovery_floor');

        // The content moves: the same question ids come back asking about different content, so the stored question is
        // refreshed and the old answer no longer describes what this revision asks about.
        await writeFile(join(root, 'src', 'a.ts'), 'export const version = 2;\n');
        await ledger(['freeze']);
        await ledger(['ask', '--per-claim', '2', '--seed', 'fixed']);

        const decision = await ledger(['decide']);
        expect(codesOf(decision)).toContain('discovery_floor');
        expect(codesOf(decision)).not.toContain('discovery_unverified');
    });

    it('accepts a fresh answer for the moved subject, because it is a different question', async () => {
        await declareClaim();
        await ledger(['ask', '--per-claim', '2', '--seed', 'fixed']);
        await answerEverything();

        await writeFile(join(root, 'src', 'a.ts'), 'export const version = 2;\n');
        await ledger(['freeze']);
        await ledger(['ask', '--per-claim', '2', '--seed', 'fixed']);
        await answerEverything();

        const decision = await ledger(['decide']);
        expect(codesOf(decision)).not.toContain('discovery_floor');
        expect(codesOf(decision)).not.toContain('discovery_unverified');
    });

    it('refuses an answer that names a different command, and a blank observation', async () => {
        await declareClaim();
        const asked = await ledger(['ask', '--per-claim', '2', '--seed', 'fixed']);
        const id = (asked.asked as string[])[0]!;

        await ledger(['answer', '--probe', id, '--observed', 'exit 0', '--command', 'test -f src/b.ts']);
        expect(process.exitCode).toBe(1);

        await ledger(['answer', '--probe', id, '--observed', '   ']);
        expect(process.exitCode).toBe(1);

        // Nothing was written at all: a refused answer leaves no record behind.
        expect((await readLedger(root, changeId)).recordedFiles).not.toContain('probe-answers.json');
    });
});
