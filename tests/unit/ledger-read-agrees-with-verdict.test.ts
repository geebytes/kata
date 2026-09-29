import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * **One ledger, one read, one answer about whether it can be read.**
 *
 * Two defects met here. The reader that publishes the problems re-derived the readability predicate instead of asking the
 * verdict for it, so the two could answer differently — measured with `subject.json` removed: the reader said `read` and
 * published the claims as problems while the verdict said `unreadable`. And the reader called the verdict first and then
 * read the ledger *again* to count, so a second read that failed produced `openProblems: 0` for a ledger the verdict had
 * just refused — the `0` meaning "no problems" for a ledger that said nothing of the kind.
 *
 * The predicate lives in one pure function both call on a ledger they already hold, so the answers agree by construction
 * and neither needs a second read.
 */
const readLedgerCalls = vi.hoisted(() => ({ count: 0 }));
vi.mock('../../src/store/ledger.js', async (importOriginal) => {
    const original = await importOriginal<typeof import('../../src/store/ledger.js')>();
    return {
        ...original,
        readLedger: async (...args: Parameters<typeof original.readLedger>) => {
            readLedgerCalls.count += 1;
            return original.readLedger(...args);
        },
    };
});

const { openLedgerProblems, ledgerVerdict } = await import('../../src/store/verdict.js');
const { appendClaim, ensureAssurance, freezeSubject, writeSubject } = await import('../../src/store/ledger.js');

const NOW = '2026-09-29T00:00:00.000Z';
let root: string;
const changeId = 'read-agreement';

async function seed(): Promise<void> {
    root = await mkdtemp(join(tmpdir(), 'kata-ledger-read-'));
    await mkdir(join(root, '.kata', 'tasks', changeId, 'review'), { recursive: true });
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src', 'subject.ts'), 'export const subject = true;\n');
    await ensureAssurance(root, changeId, 'observed');
}

async function withSubjectAndClaim(): Promise<void> {
    const frozen = await freezeSubject({ root, paths: ['src/subject.ts'] });
    if (!frozen.ok) throw new Error('fixture subject did not freeze');
    await writeSubject(root, changeId, frozen.subject);
    await appendClaim(root, changeId, {
        id: 'C-1', statement: 'a claim', riskClass: 'consistency', severity: 'major',
        dependsOn: [], evidenceIds: [], challengeIds: [], status: 'open', at: NOW, reopens: 0,
    });
}

/** Whether the two surfaces agree about readability — the only thing that has to hold in every state. */
async function agree(): Promise<{ problems: string; verdict: string; agree: boolean }> {
    const problems = await openLedgerProblems(root, changeId);
    const verdict = await ledgerVerdict({ root, changeId });
    const p = problems.kind === 'unreadable' ? 'unreadable' : 'readable';
    const v = verdict.kind === 'unreadable' ? 'unreadable' : 'readable';
    return { problems: p, verdict: v, agree: p === v };
}

describe('the two readers of a ledger agree', () => {
    beforeEach(async () => {
        await seed();
    });

    afterEach(async () => {
        await rm(root, { recursive: true, force: true });
    });

    it('agrees when nothing has been recorded', async () => {
        expect(await agree()).toMatchObject({ agree: true });
    });

    it('agrees when records exist but no claim does', async () => {
        await writeFile(join(root, '.kata', 'tasks', changeId, 'review', 'evidence.json'), '[]\n');
        expect(await agree()).toMatchObject({ agree: true });
    });

    it('agrees when a record cannot be parsed', async () => {
        await withSubjectAndClaim();
        await writeFile(join(root, '.kata', 'tasks', changeId, 'review', 'claims.json'), '{}\n');
        const result = await agree();
        expect(result).toMatchObject({ problems: 'unreadable', verdict: 'unreadable', agree: true });
    });

    it('agrees when claims exist without a frozen subject', async () => {
        await appendClaim(root, changeId, {
            id: 'C-1', statement: 'a claim', riskClass: 'consistency', severity: 'major',
            dependsOn: [], evidenceIds: [], challengeIds: [], status: 'open', at: NOW, reopens: 0,
        });
        const result = await agree();
        expect(result).toMatchObject({ problems: 'unreadable', verdict: 'unreadable', agree: true });
        // The sentence comes from the verdict, so an operator reading either surface reads the same refusal.
        const problems = await openLedgerProblems(root, changeId);
        expect(problems.kind === 'unreadable' ? problems.detail : '').toContain('frozen subject');
    });

    it('agrees when the ledger is whole', async () => {
        await withSubjectAndClaim();
        expect(await agree()).toMatchObject({ problems: 'readable', verdict: 'readable', agree: true });
    });

    it('reads the ledger once per decision, so a second read cannot answer differently', async () => {
        await withSubjectAndClaim();
        readLedgerCalls.count = 0;
        await openLedgerProblems(root, changeId);
        const problems = readLedgerCalls.count;
        readLedgerCalls.count = 0;
        await ledgerVerdict({ root, changeId });
        const verdict = readLedgerCalls.count;
        // One read each: the reader used to ask the verdict (one read) and then read again for the count.
        expect({ problems, verdict }).toEqual({ problems: 1, verdict: 1 });
    });
});