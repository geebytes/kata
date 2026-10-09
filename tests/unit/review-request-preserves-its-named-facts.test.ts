import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { initLayout } from '../../src/core/layout.js';
import { runLedgerCommand } from '../../src/cli/ledger.js';
import { readLedger, writePlan, writePolicy } from '../../src/store/ledger.js';
import { buildReviewRequest, verifyAgainstRequest } from '../../src/store/review-request.js';
import { defaultPolicy } from '../../src/kernel/policy.js';
import { MIN_STRENGTH_BY_SEVERITY } from '../../src/kernel/evidence.js';
import { writeTaskRecord } from '../helpers/task-fixture.js';

/**
 * **AC-19 — a request and its advisory answers preserve their named facts, and the assertions prove the values.**
 *
 * Four facts that were asserted by *existence* rather than by value, which is how a request can keep its shape while handing
 * over different content: the plan's numbers (a `tier` and a deadline that must be the stored plan's, not merely present), the
 * reading set per claim, the strength the claim's severity demands, and every gap's claim id. The fifth is the one the answers
 * are about: an advisory answer is history, so a request may never present it as the proof of anything.
 */
const changeId = 'request-facts';
const roots: string[] = [];

afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tempRoot(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'kata-request-facts-'));
    roots.push(root);
    await initLayout(root);
    await mkdir(join(root, 'src'), { recursive: true });
    await mkdir(join(root, '.kata', 'tasks', changeId), { recursive: true });
    await writeFile(join(root, 'src', 'a.ts'), 'export const holds = true;\n');
    await writeFile(join(root, 'src', 'b.ts'), 'export const alsoHolds = true;\n');
    await writeTaskRecord(root, {
        id: changeId,
        phase: 'hardVerify',
        acceptance: [{ id: 'AC-1', statement: 'The thing holds.' }],
        ownedPaths: ['src/a.ts', 'src/b.ts'],
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

/** A frozen ledger with two claims and a stored plan, declared and sealed the way the workflow does it. */
async function declaredRoot(): Promise<string> {
    const root = await tempRoot();
    expect((await ledger(root, ['claim', 'add', '--id', 'C-1', '--statement', 'a.ts holds', '--risk-class', 'consistency', '--severity', 'major', '--depends-on', 'path:src/a.ts'])).ok).toBe(true);
    expect((await ledger(root, ['claim', 'add', '--id', 'C-2', '--statement', 'b.ts holds', '--risk-class', 'boundary', '--severity', 'minor', '--depends-on', 'path:src/b.ts'])).ok).toBe(true);
    expect((await ledger(root, ['plan'])).ok).toBe(true);
    // **Distinctive plan values, so the assertions can tell "read the plan" from "returned a plausible constant".** With the
    // generated plan every field held the default the builder would have produced anyway — measured: mutating the builder to
    // return a constant tier did not redden this case, which makes it decorative. These values appear nowhere else.
    await writePlan(root, changeId, {
        tier: 'standard',
        readingSets: [{ claimId: 'C-1', paths: ['src/a.ts', 'src/b.ts'], truncated: false }, { claimId: 'C-2', paths: ['src/b.ts'], truncated: false }],
        // The requirement is real, so the gap reporting below has something to report: with an empty requirement set the
        // request is satisfied by construction and the "every gap names its claim" case would be vacuous (measured while
        // making these values distinctive — the case passed for the wrong reason).
        requiredEvidence: [
            { claimId: 'C-1', types: ['executable_falsifier'], minimumStrength: 3 },
            { claimId: 'C-2', types: ['static_witness'], minimumStrength: 1 },
        ],
        discovery: { deadlineToolCalls: 7 },
    });
    expect((await ledger(root, ['freeze'])).ok).toBe(true);
    const { createTaskRevisionIfChanged } = await import('../../src/workflow/revision.js');
    await createTaskRevisionIfChanged({ root, taskId: changeId, ownedPaths: ['src/a.ts', 'src/b.ts'], checkIds: [] });
    return root;
}

describe('the request hands over the values it names', () => {
    it('hands over the stored plan’s own numbers, not merely a value of the right shape', async () => {
        const root = await declaredRoot();
        const ledgerState = await readLedger(root, changeId);
        const plan = JSON.parse(await (await import('node:fs/promises')).readFile(join(root, '.kata', 'tasks', changeId, 'review', 'plan.json'), 'utf8')) as {
            tier: string;
            readingSets: Array<{ claimId: string; paths: string[] }>;
            discovery?: { deadlineToolCalls: number | null };
        };

        const built = await buildReviewRequest({ root, changeId });

        expect(built.ok, JSON.stringify(built)).toBe(true);
        if (!built.ok) return;
        // Values, compared against the artefact they come from — a tier the plan does not name would pass an existence check.
        expect(built.request.tier).toBe(plan.tier);
        // And the plan really holds the distinctive values, so these assertions are not comparing two defaults.
        expect(plan.tier).toBe('standard');
        expect(built.request.deadlineToolCalls).toBe(7);
        expect(built.request.deadlineToolCalls).toBe(plan.discovery?.deadlineToolCalls ?? null);
        for (const entry of built.request.claims) {
            const stored = plan.readingSets.find((set) => set.claimId === entry.claimId);
            expect(entry.readingSet).toEqual(stored?.paths ?? []);
        }
        // And the strength is the kernel's own answer for the claim's severity, not a number the request invents.
        for (const entry of built.request.claims) {
            const claim = ledgerState.claims.find((candidate) => candidate.id === entry.claimId);
            expect(entry.requiredEvidence.minimumStrength).toBe(MIN_STRENGTH_BY_SEVERITY[claim!.severity]);
        }
    });

    it('names every gap by a claim that exists, and reserves the unnamed gap for a request that could not be built', async () => {
        const root = await declaredRoot();

        const { gaps } = await verifyAgainstRequest({ root, changeId });
        const known = new Set((await readLedger(root, changeId)).claims.map((claim) => claim.id));

        // Gaps now exist (nothing has been verified), and each names a claim the ledger holds: a gap an operator cannot act on
        // is the same defect as a refusal that names no remedy.
        expect(gaps.length).toBeGreaterThan(0);
        for (const gap of gaps) {
            expect(gap.claimId, `gap by claim: ${gap.what}`).not.toBeNull();
            expect(known.has(gap.claimId as string), `gap names a stored claim: ${String(gap.claimId)}`).toBe(true);
            expect(gap.what.trim().length).toBeGreaterThan(0);
        }

        // The unnamed gap is the one whose sentence is about the request itself, and it says so.
        const requestLevel = await verifyAgainstRequest({ root: 'nonexistent-root', changeId });
        expect(requestLevel.gaps).toHaveLength(1);
        expect(requestLevel.gaps[0]?.claimId).toBeNull();
        expect(requestLevel.gaps[0]?.what).toMatch(/plan|request|ledger|not/i);
    });

    it('gives every generated question a non-blank expected fact, and never an empty comparison', async () => {
        const root = await declaredRoot();
        expect((await ledger(root, ['ask', '--per-claim', '2'])).ok).toBe(true);
        const { readProbesState } = await import('../../src/store/ledger.js');
        const probesRead = await readProbesState(root, changeId);
        expect(probesRead.kind, JSON.stringify(probesRead)).toBe('usable');
        if (probesRead.kind !== 'usable') return;
        const probes = probesRead.value;

        expect(probes.length).toBeGreaterThan(0);
        for (const probe of probes) {
            // A probe asks about content of one path the claim rests on. Its expected fact is stated on the record — a prefix
            // for a digest question, an existence question otherwise — and it is never the empty string: `test "$(…)" = ""`
            // is a question whose expected answer is nothing, which no review can answer.
            const expectedFact = probe.kind === 'digest-prefix' ? probe.prefix : 'exists';
            expect(expectedFact, `${probe.id} expected fact`).toBeTruthy();
            expect(String(expectedFact).trim().length).toBeGreaterThan(0);
            if (probe.kind === 'digest-prefix') expect(probe.command).not.toContain('= ""');
        }
    });

    it('keeps an answer as advisory history, and withholds the question once its content moves', async () => {
        const root = await declaredRoot();
        expect((await ledger(root, ['ask', '--per-claim', '1'])).ok).toBe(true);
        const { readProbesState } = await import('../../src/store/ledger.js');
        const askedRead = await readProbesState(root, changeId);
        expect(askedRead.kind).toBe('usable');
        if (askedRead.kind !== 'usable') return;
        const asked = askedRead.value[0]!;
        const answered = await ledger(root, ['answer', '--probe', asked.id, '--observed', 'the file is there']);
        expect(answered.ok, JSON.stringify(answered)).toBe(true);

        const before = await buildReviewRequest({ root, changeId });
        expect(before.ok).toBe(true);
        if (!before.ok) return;
        // The answer is history: it is not the proof of anything, so it appears nowhere in the request's obligations.
        expect(before.request.probes.map((probe) => probe.id)).toContain(asked.id);
        expect(JSON.stringify(before.request)).not.toContain('the file is there');
        // And the request's note says what the request is and is not, so a reader is not left to infer it from the missing key.
        expect(before.request.note).toContain('probes');

        // The content moves: the question was asked about the old subject, so it is withheld and named, not handed over.
        await writeFile(join(root, 'src', 'a.ts'), 'export const holds = false;\n');
        const refrozen = await ledger(root, ['plan']);
        expect(refrozen.ok, JSON.stringify(refrozen)).toBe(true);
        expect((await ledger(root, ['freeze'])).ok).toBe(true);
        // Re-sealed first, because a request derived against a superseded revision is refused — and that refusal is right: it
        // would name content a reviewer could not bind a result to (`measured: the first version of this case asked for the
        // request without re-sealing and got exactly that refusal`).
        const { createTaskRevisionIfChanged } = await import('../../src/workflow/revision.js');
        await createTaskRevisionIfChanged({ root, taskId: changeId, ownedPaths: ['src/a.ts', 'src/b.ts'], checkIds: [] });
        const after = await buildReviewRequest({ root, changeId });
        expect(after.ok, JSON.stringify(after)).toBe(true);
        if (!after.ok) return;
        if (after.request.withheldProbes !== undefined) {
            expect(after.request.withheldProbes.map((probe) => probe.id)).toContain(asked.id);
            expect(after.request.probes.map((probe) => probe.id)).not.toContain(asked.id);
        } else {
            throw new Error('the moved subject kept the old question in the request without withholding it');
        }
    });
});
