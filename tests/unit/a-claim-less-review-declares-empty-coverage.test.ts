import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initLayout, reviewPath } from '../../src/core/layout.js';
import { writeCurrentState } from '../../src/core/state.js';
import { runCommand } from '../../src/workflow/orchestrator.js';
import { createTaskRevisionIfChanged } from '../../src/workflow/revision.js';
import { appendClaim, freezeSubject, writePlan, writePolicy, writeSubject } from '../../src/store/ledger.js';
import { defaultPolicy } from '../../src/kernel/policy.js';
import { writeTaskRecord } from '../helpers/task-fixture.js';

/**
 * **AC-13 — a claim-less ledger can say what it covered, and saying nothing is not the same as saying nothing was there.**
 *
 * A review round that read the change and found no problem has to publish the set it read. The guard that keeps a
 * four-byte `{ "findings": [] }` from counting as a round requires `declaredCoverage`, and the same guard required it to be
 * *non-empty* — so on a ledger that holds no claims (a change whose declared paths are governance text, an instrument, a
 * brand-new change before any claim is declared) the only honest answer was refused, and a round that read everything had
 * no way to record it.
 *
 * The distinction this pins: `declaredCoverage: []` is a declaration that nothing was covered, is retained as such, and is
 * only legal where there is nothing to cover. A ledger that holds claims still refuses it, and an id the ledger does not
 * hold is refused either way — the empty list is not a wildcard.
 */
const roots: string[] = [];
const taskId = 'claim-less-review';

async function tempRoot(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'kata-claim-less-review-'));
    roots.push(root);
    await initLayout(root);
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src', 'thing.ts'), 'export const holds = true;\n');
    await mkdir(join(root, '.kata', 'tasks', taskId), { recursive: true });
    await writeTaskRecord(root, {
        id: taskId,
        phase: 'review',
        acceptance: [{ id: 'AC-1', statement: 'The thing holds.' }],
        ownedPaths: ['src/thing.ts'],
    });
    return root;
}

async function seedLedger(root: string, options: { claims: number }): Promise<string> {
    await writePolicy(root, taskId, defaultPolicy());
    const frozen = await freezeSubject({ root, paths: ['src/thing.ts'] });
    if (!frozen.ok) throw new Error(frozen.error);
    await writeSubject(root, taskId, frozen.subject);
    const readingSets: Array<{ claimId: string; paths: string[]; truncated: boolean }> = [];
    const requiredEvidence: Array<{ claimId: string; types: string[]; minimumStrength: number }> = [];
    for (let index = 0; index < options.claims; index += 1) {
        const id = `C-${index + 1}`;
        await appendClaim(root, taskId, {
            id,
            statement: `claim ${id} holds`,
            riskClass: 'consistency',
            severity: 'major',
            dependsOn: ['path:src/thing.ts'],
            evidenceIds: [],
            challengeIds: [],
            status: 'open',
            at: '2026-10-09T00:00:00.000Z',
            reopens: 0,
        });
        readingSets.push({ claimId: id, paths: ['src/thing.ts'], truncated: false });
        requiredEvidence.push({ claimId: id, types: [], minimumStrength: 0 });
    }
    await writePlan(root, taskId, { tier: 'strict', readingSets, requiredEvidence, discovery: { deadlineToolCalls: null } });
    const sealed = await createTaskRevisionIfChanged({ root, taskId, ownedPaths: ['src/thing.ts'], checkIds: [] });
    await writeCurrentState(root, {
        taskId,
        phase: 'review',
        actor: { id: 'kata-reviewer', role: 'reviewer' },
        updatedAt: '2026-10-09T00:00:00.000Z',
    });
    return sealed.revision.id;
}

async function record(root: string, payload: unknown, name: string): Promise<{ success: boolean; error?: string }> {
    await mkdir(join(root, 'tmp'), { recursive: true });
    await writeFile(join(root, 'tmp', name), `${JSON.stringify(payload)}\n`);
    const result = await runCommand('review', taskId, root, { reviewResultFile: `tmp/${name}` });
    return { success: result.success, error: result.error };
}

afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('a claim-less ledger can declare empty coverage', () => {
    it('records an empty round with an explicit empty declaration, and keeps the declaration', async () => {
        const root = await tempRoot();
        await seedLedger(root, { claims: 0 });

        const recorded = await record(root, { findings: [], declaredCoverage: [] }, 'empty-coverage.json');

        expect(recorded.error, JSON.stringify(recorded)).toBeUndefined();
        expect(recorded.success).toBe(true);
        const review = JSON.parse(await readFile(reviewPath(root, taskId), 'utf8')) as Record<string, unknown>;
        // Retained as a fact, and distinguishable from "the reviewer said nothing about coverage" — which is the whole
        // reason the field exists.
        expect(review).toHaveProperty('declaredCoverage');
        expect(review.declaredCoverage).toEqual([]);
    });

    it('still refuses an empty findings array that declares nothing at all', async () => {
        const root = await tempRoot();
        await seedLedger(root, { claims: 0 });

        const recorded = await record(root, { findings: [] }, 'no-coverage.json');

        expect(recorded.success).toBe(false);
        expect(String(recorded.error)).toContain('declares coverage');
        await expect(readFile(reviewPath(root, taskId), 'utf8')).rejects.toThrow();
    });

    it('refuses empty coverage where the ledger does hold claims, and refuses ids it does not hold', async () => {
        const root = await tempRoot();
        await seedLedger(root, { claims: 1 });

        const empty = await record(root, { findings: [], declaredCoverage: [] }, 'claimed-empty.json');
        expect(empty.success).toBe(false);
        expect(String(empty.error)).toContain('non-empty');
        await expect(readFile(reviewPath(root, taskId), 'utf8')).rejects.toThrow();

        const invented = await record(root, { findings: [], declaredCoverage: ['C-99'] }, 'invented.json');
        expect(invented.success).toBe(false);
        expect(String(invented.error)).toContain('C-99');
    });
});
