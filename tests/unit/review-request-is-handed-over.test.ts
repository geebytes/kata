import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildReviewRequest, verifyAgainstRequest } from '../../src/store/review-request.js';
import { appendClaim, appendEvidence, ensureAssurance, freezeSubject, writePolicy, writeSubject, recordVerdicts, writePlan } from '../../src/store/ledger.js';
import { createTaskRevisionIfChanged } from '../../src/workflow/revision.js';
import { createTask } from '../../src/core/task.js';
import { initLayout } from '../../src/core/layout.js';
import { defaultPolicy } from '../../src/kernel/policy.js';
import { makeEvidence, makeVerdict } from '../helpers/review.js';
import type { Claim } from '../../src/kernel/types.js';

/**
 * **The action the plan was missing.**
 *
 * `plan` computed the reading sets, the required evidence and the deadline, and wrote them to `plan.json` — and nothing
 * consumed it. A review was dispatched by a human writing a prompt from memory, which is how the same requirement had to be
 * carried by hand while twenty-eight rounds produced no record. These cases pin the two halves of the action: the request
 * that hands the plan over, and the check that compares it with what came back.
 *
 * What the request must not contain is as load-bearing as what it must: no platform, no session, no model, no receipt.
 * Those are the assurance axis, and a request that named them would put the process back inside the criteria.
 */
let root: string;
const changeId = 'request-fixture';

async function scratch(): Promise<string> {
    root = await mkdtemp(join(tmpdir(), 'kata-request-'));
    await initLayout(root);
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src', 'a.ts'), 'export const holds = true;\n');
    // A real task record, not a hand-written stub: the request now reads the sealed revision's status, which validates
    // the task, so a partial `task.json` fails the reader rather than being tolerated as "close enough".
    await createTask({
        root,
        id: changeId,
        title: 'Review request fixture',
        acceptance: [{ id: 'AC-1', statement: 'the request speaks for the sealed revision' }],
        ownedPaths: ['src/a.ts'],
    });
    return root;
}

const claim = (): Claim => ({
    id: 'C1',
    statement: 'the export is present',
    riskClass: 'consistency' as const,
    severity: 'major' as const,
    dependsOn: ['path:src/a.ts'] as ['path:src/a.ts'],
    evidenceIds: ['E1'],
    challengeIds: [],
    status: 'open' as const,
    at: '2026-09-27T00:00:00.000Z',
    reopens: 0,
});

async function planned(): Promise<{ subjectRevision: string }> {
    const dir = await scratch();
    await writePolicy(dir, changeId, defaultPolicy());
    // **Sealed, because a request now speaks for the sealed revision.** An unsealed fixture would be refused before the
    // assertions this file exists for — the binding is a precondition of handing a brief over, not part of those claims.
    const frozen = await freezeSubject({ root: dir, paths: ['src/a.ts'] });
    if (!frozen.ok) throw new Error(frozen.error);
    await writeSubject(dir, changeId, frozen.subject);
    // **Sealed after the freeze**, so the two describe the same content: a seal fixes the revision identity, and the
    // subject's own revision must match it or the request is refused as stale.
    await createTaskRevisionIfChanged({ root: dir, taskId: changeId, ownedPaths: ['src/a.ts'], checkIds: [] });
    await ensureAssurance(dir, changeId, 'observed');
    await appendClaim(dir, changeId, claim());
    const { readLedger } = await import('../../src/store/ledger.js');
    const subjectRevision = (await readLedger(dir, changeId)).subject?.revision ?? '';
    await appendEvidence(dir, changeId, makeEvidence({
        id: 'E1',
        type: 'executable_falsifier',
        command: 'grep -q holds src/a.ts',
        mutation: { file: 'src/a.ts', find: 'holds', replace: 'broken' },
    }));
    await writePlan(dir, changeId, {
        tier: 'standard',
        readingSets: [{ claimId: 'C1', paths: ['src/a.ts'], truncated: false }],
        requiredEvidence: [{ claimId: 'C1', types: ['executable_falsifier'], minimumStrength: 3 }],
        discovery: { deadlineToolCalls: 200 },
    });
    return { subjectRevision };
}

describe('a review request is handed over and checked, rather than hoped for', () => {
    it('carries the plan, the deadline and the probes — and none of the assurance axis', async () => {
        const { subjectRevision } = await planned();
        const built = await buildReviewRequest({ root, changeId });
        expect(built.ok).toBe(true);
        if (!built.ok) return;
        // What it must carry: the claim's own reading set, the tier's evidence requirement, the number, and the questions.
        expect(built.request.claims[0]?.readingSet).toEqual(['src/a.ts']);
        expect(built.request.claims[0]?.requiredEvidence.types).toEqual(['executable_falsifier']);
        expect(built.request.deadlineToolCalls).toBe(200);
        // What it must not: the assurance axis as **fields**. A substring check on the document would find these words in
        // the note that denies them, so the assertion is over the key set — which is what a reader of the request acts on.
        const keys = new Set<string>();
        const walk = (value: unknown): void => {
            if (Array.isArray(value)) { for (const item of value) walk(item); return; }
            if (value !== null && typeof value === 'object') {
                for (const [key, entry] of Object.entries(value as Record<string, unknown>)) { keys.add(key.toLowerCase()); walk(entry); }
            }
        };
        walk(built.request);
        for (const word of ['platform', 'sessionid', 'model', 'receipt', 'executor', 'provenance']) {
            expect([...keys], `a request naming ${word} puts the process back inside the criteria`).not.toContain(word);
        }
    });

    it('refuses to hand over anything when no plan has been stored', async () => {
        const dir = await scratch();
        await writePolicy(dir, changeId, defaultPolicy());
        const frozen = await freezeSubject({ root: dir, paths: ['src/a.ts'] });
        if (frozen.ok) await writeSubject(dir, changeId, frozen.subject);
        const built = await buildReviewRequest({ root: dir, changeId });
        expect(built.ok).toBe(false);
        if (built.ok) return;
        expect(built.why).toContain('no plan has been stored');
    });

    it('names each gap on the way back, by claim, instead of scoring them', async () => {
        const { subjectRevision } = await planned();
        // An unanswered probe is advisory history; only the missing claim evidence is a gap.
        const before = await verifyAgainstRequest({ root, changeId });
        // The gap now names the kernel's own state and reason rather than "no supported verdict", so a reader can tell
        // "nothing was checked" from "checked and not enough" — the two instructions these used to conflate.
        expect(before.gaps.map((gap) => gap.what).join(' | ')).toContain('the claim is');

        // Verify the evidence: no gaps, which is the only reading of "the request was satisfied".
        // Answers are audit history only; their absence cannot decide request completion.
        // **A verdict the kernel accepts, not one that merely exists.** The fixture used to record a `static_witness`
        // verdict for a claim whose severity requires an executable falsifier, bound to `rev:unknown` rather than to the
        // frozen subject — and the check it was written against asked only whether a supported verdict existed, so the
        // claim read as satisfied while the kernel judged it `stale`. Both fields are what the real flow writes.
        await recordVerdicts(root, changeId, [makeVerdict({
            evidenceId: 'E1',
            evidenceType: 'executable_falsifier',
            subjectRevision,
            verdict: 'supported',
            verifier: 'test',
        })]);
        const after = await verifyAgainstRequest({ root, changeId });
        expect(after.gaps).toEqual([]);
    });

    it('refuses a lower strength where the plan asked for a higher one', async () => {
        const { subjectRevision } = await planned();
        // The claim holds only a static witness while the plan requires a falsifier: a gap, named with both sides.
        await appendEvidence(root, changeId, makeEvidence({ id: 'E2', type: 'static_witness', ref: 'src/a.ts', assertion: 'contains:holds' }));
        const dir = root;
        await writePlan(dir, changeId, {
            tier: 'standard',
            readingSets: [{ claimId: 'C1', paths: ['src/a.ts'], truncated: false }],
            requiredEvidence: [{ claimId: 'C1', types: ['executable_falsifier'], minimumStrength: 3 }],
            discovery: { deadlineToolCalls: 200 },
        });
        // The claim's own evidence is the falsifier, so this fixture satisfies it; the case asserts the *predicate* by
        // removing it instead of by reading the code.
        await appendClaim(dir, changeId, { ...claim(), evidenceIds: ['E2'] });
        const { gaps } = await verifyAgainstRequest({ root: dir, changeId });
        expect(gaps.map((gap) => gap.what).join(' | ')).toContain('no evidence of executable_falsifier or stronger');
    });
});
