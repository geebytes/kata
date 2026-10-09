import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runLedgerCommand } from '../../src/cli/ledger.js';
import { readLedger, writePolicy } from '../../src/store/ledger.js';
import { defaultPolicy } from '../../src/kernel/policy.js';
import { buildReviewRequest } from '../../src/store/review-request.js';
import { writeTaskRecord } from '../helpers/task-fixture.js';

/**
 * **AC-4 — the identity question stays in the subject, and the trade-off is written where the identity is defined.**
 *
 * A claim's `statement` is part of what the subject hashes, so restating a claim moves the revision and invalidates the
 * readings taken against the old wording. That is deliberate and it was measured the other way first: with the statement out
 * of the question, a claim could be restated — the question changed, the code did not — and every consumer that compares
 * subjects kept treating an answer to the old question as an answer to the new one.
 *
 * The cost of that decision is real (a wording change costs a re-freeze and a re-verification), which is why the boundary a
 * claim declares lives in a **separate field**: refining where a claim stops is how it is made falsifiable, and it must not
 * cost what restating the claim costs. This case pins both halves, and the third: the reason is recorded where the identity
 * is defined, so the next reader meets the trade-off rather than the accident.
 */
const changeId = 'restated-claim';
const roots: string[] = [];

afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tempRoot(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'kata-restate-'));
    roots.push(root);
    await mkdir(join(root, '.kata', 'tasks', changeId), { recursive: true });
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src', 'a.ts'), 'export const holds = true;\n');
    // Through the store's own fixture writer: a hand-rolled record its reader refuses is a fixture defect, and this
    // selector needs a task the *sealer* accepts (it validates the record before it seals).
    await writeTaskRecord(root, {
        id: changeId,
        phase: 'hardVerify',
        acceptance: [{ id: 'AC-1', statement: 'The export holds.' }],
        ownedPaths: ['src/a.ts'],
    });
    await writePolicy(root, changeId, defaultPolicy());
    return root;
}

async function ledger(root: string, argv: string[]): Promise<Record<string, unknown>> {
    const chunks: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
        chunks.push(String(chunk));
        return true;
    });
    const previous = process.exitCode;
    process.exitCode = 0;
    try {
        await runLedgerCommand(argv, { root, changeId });
    } finally {
        spy.mockRestore();
        process.exitCode = previous;
    }
    const text = chunks.join('');
    const start = text.indexOf('{');
    return start < 0 ? {} : JSON.parse(text.slice(start)) as Record<string, unknown>;
}

/**
 * A frozen ledger, driven the way the workflow drives it: declare, plan, freeze.
 *
 * **The freeze has to hash the question.** `freezeSubject` takes the claims and the plan digest as optional inputs — optional
 * in the signature, required for the property — and a freeze without them produces a subject with no `claimsDigest`, which
 * every reader then treats as speaking for whatever is declared. Measured here first: the fixture froze without them, a
 * restate changed nothing, and the case failed for the fixture's reason rather than the code's.
 */
async function frozenRoot(): Promise<string> {
    const root = await tempRoot();
    expect((await ledger(root, ['claim', 'add', '--id', 'C-1', '--statement', 'the export holds', '--risk-class', 'consistency', '--severity', 'major', '--depends-on', 'path:src/a.ts'])).ok).toBe(true);
    expect((await ledger(root, ['plan'])).ok, 'the plan is what a request is derived from').toBe(true);
    const frozen = await ledger(root, ['freeze']);
    expect(frozen.ok, JSON.stringify(frozen)).toBe(true);
    const subject = (await readLedger(root, changeId)).subject;
    expect(subject?.claimsDigest, 'the freeze must hash the question, or a restate cannot move the subject').toBeDefined();
    // A request speaks for a sealed revision, so the fixture seals one: a request is what it is *for*.
    const { createTaskRevisionIfChanged } = await import('../../src/workflow/revision.js');
    await createTaskRevisionIfChanged({ root, taskId: changeId, ownedPaths: ['src/a.ts'], checkIds: [] });
    return root;
}

const declaredSubject = async (root: string): Promise<string> => (await readLedger(root, changeId)).subjectAsDeclared?.revision ?? '';

describe('a restated claim answers a different question', () => {
    it('moves the subject when the statement changes, and counts it as a reopen', async () => {
        const root = await frozenRoot();
        const before = await declaredSubject(root);

        const restated = await ledger(root, ['claim', 'restate', '--id', 'C-1', '--statement', 'the export holds for every exported symbol']);

        expect(restated.ok, JSON.stringify(restated)).toBe(true);
        const after = await declaredSubject(root);
        // A wording change is a different question, so every reading bound to the old one is correctly stale.
        expect(after).not.toBe(before);
        const claim = (await readLedger(root, changeId)).claims.find((entry) => entry.id === 'C-1');
        expect(claim?.statement).toBe('the export holds for every exported symbol');
        expect(claim?.reopens).toBe(1);
    });

    it('leaves the subject alone when only the declared boundary is refined', async () => {
        const root = await frozenRoot();
        expect((await ledger(root, ['claim', 'restate', '--id', 'C-1', '--boundary', 'the exports under src/ that the matrix names'])).ok).toBe(true);
        const before = await declaredSubject(root);

        const refined = await ledger(root, ['claim', 'restate', '--id', 'C-1', '--boundary', 'the exports under src/ that the matrix names, and the fixture helpers they import']);

        expect(refined.ok, JSON.stringify(refined)).toBe(true);
        // **The point of keeping the boundary out of the question.** Narrowing where a claim stops is how it is made
        // falsifiable; if that cost a re-freeze and a re-verification of every reading, authors would not refine it — which is
        // how the edge ended up in prose with a severity number standing in for it.
        expect(await declaredSubject(root)).toBe(before);
        const claim = (await readLedger(root, changeId)).claims.find((entry) => entry.id === 'C-1');
        expect(claim?.boundary).toContain('fixture helpers');
        // The statement did not move, so nothing was reopened: the reopen count measures wording changes, not refinements.
        expect(claim?.reopens).toBe(0);
    });

    it('carries the refined boundary to the reviewer, so the edge is read from the claim and not from its wording', async () => {
        const root = await frozenRoot();
        expect((await ledger(root, ['claim', 'restate', '--id', 'C-1', '--boundary', 'the exports under src/ that the matrix names'])).ok).toBe(true);

        const built = await buildReviewRequest({ root, changeId });

        expect(built.ok, JSON.stringify(built)).toBe(true);
        if (!built.ok) return;
        const entry = built.request.claims.find((claim) => claim.claimId === 'C-1');
        expect(entry?.boundary).toBe('the exports under src/ that the matrix names');
        // And the wording is still handed over as well: the reviewer reads both, and the boundary is the field that says
        // where the claim stops.
        expect(entry?.statement).toBe('the export holds');
    });

    it('records the reason where the identity is defined, so the trade-off is met rather than rediscovered', async () => {
        const source = await readFile(join(process.cwd(), 'src', 'kernel', 'subject.ts'), 'utf8');

        // The reason lives with the derivation it constrains. A comment somewhere else would be a note, and notes are what
        // the next reader does not open.
        expect(source).toContain('**A subject is about a question, not only about content.**');
        expect(source).toContain('hashed the path digests alone');
        // And the decision itself is asserted, not just described: the statement is in the canonical question.
        expect(source).toContain('claim.statement');
        // The *boundary* is deliberately not in it, and the file says so where a reader would otherwise add it.
        expect(source).not.toMatch(/questionOf[\s\S]{0,400}boundary/);
    });

    it('documents the trade-off where operators read it', async () => {
        const operations = await readFile(join(process.cwd(), 'docs', 'operations.md'), 'utf8');

        // The operator-facing consequence: what costs a re-freeze and what does not.
        expect(operations).toContain('restate');
        expect(operations).toContain('--boundary');
    });
});
