import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initLayout, reviewPath } from '../../src/core/layout.js';
import { createTask } from '../../src/core/task.js';
import { writeCurrentState } from '../../src/core/state.js';
import { appendClaim, freezeSubject, writePlan, writePolicy, writeSubject } from '../../src/store/ledger.js';
import { defaultPolicy } from '../../src/kernel/policy.js';
import { runCommand } from '../../src/workflow/orchestrator.js';
import { createTaskRevisionIfChanged } from '../../src/workflow/revision.js';
import { DEFECT_CLASSES, defectClasses, requireDefectClass } from '../../src/quality/defect-classes.js';

/**
 * **A finding says which class of defect it is, because that is the number the loop is missing.** This repository holds 102
 * review rounds and 56 findings: a round record keeps ids and a count, `review.json` is overwritten each round, so "which
 * class of defect keeps recurring" is not a question the store can answer — while the reading that would answer it (blocking
 * findings per round) is flat rather than falling, which is the signature of sampling rather than of convergence.
 */
let root: string;
const changeId = 'a-finding-carries-its-class';

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'kata-finding-class-'));
    await initLayout(root);
    await createTask({
        root,
        id: changeId,
        title: 'A finding carries its class',
        acceptance: [{ id: 'AC-1', statement: 'The class is recorded.' }],
        ownedPaths: ['src/a.ts'],
    });
    await mkdir(join(root, 'src'), { recursive: true });
    await mkdir(join(root, 'tmp'), { recursive: true });
    await writeFile(join(root, 'src', 'a.ts'), 'export const holds = true;\n');
});

afterEach(async () => {
    await rm(root, { recursive: true, force: true });
});

async function prepareRequest(): Promise<void> {
    await writePolicy(root, changeId, defaultPolicy());
    const frozen = await freezeSubject({ root, paths: ['src/a.ts'] });
    if (!frozen.ok) throw new Error(frozen.error);
    await writeSubject(root, changeId, frozen.subject);
    await appendClaim(root, changeId, {
        id: 'C-1',
        statement: 'The export is present.',
        riskClass: 'consistency',
        severity: 'major',
        dependsOn: ['path:src/a.ts'],
        evidenceIds: [],
        challengeIds: [],
        status: 'open',
        at: '2026-09-30T00:00:00.000Z',
        reopens: 0,
    });
    await writePlan(root, changeId, {
        tier: 'strict',
        readingSets: [{ claimId: 'C-1', paths: ['src/a.ts'], truncated: false }],
        requiredEvidence: [{ claimId: 'C-1', types: [], minimumStrength: 0 }],
        discovery: { deadlineToolCalls: null },
    });
    await createTaskRevisionIfChanged({ root, taskId: changeId, ownedPaths: ['src/a.ts'], checkIds: [] });
    await writeCurrentState(root, {
        taskId: changeId,
        phase: 'review',
        actor: { id: 'kata-reviewer', role: 'reviewer' },
        updatedAt: '2026-09-30T00:00:00.000Z',
    });
}

function finding(extra: Record<string, unknown> = {}): Record<string, unknown> {
    return { id: 'R-1', taskId: changeId, severity: 'blocking', acceptanceId: 'AC-1', message: 'the requested input was not produced', ...extra };
}

async function record(payload: unknown, file = 'tmp/result.json'): Promise<{ success?: boolean; error?: string; diagnostics?: Record<string, unknown> }> {
    await writeFile(join(root, file), JSON.stringify(payload, null, 2));
    return runCommand('review', changeId, root, { reviewResultFile: file }) as Promise<{ success?: boolean; error?: string; diagnostics?: Record<string, unknown> }>;
}

describe('a finding carries its defect class', () => {
    it('says which class an entry is, and which kind of oracle that class has', () => {
        // The vocabulary is the point of the register: a class without an oracle type cannot say whether the next round is the
        // right instrument for it, and a class without a definition is a word two people fill differently.
        const classes = defectClasses();
        expect(classes.length).toBeGreaterThanOrEqual(6);
        for (const entry of classes) {
            expect(entry.definition.length, entry.class).toBeGreaterThan(20);
            expect(['mechanizable', 'judgment'], entry.class).toContain(entry.oracle);
        }
        // Both kinds exist, because both exist in this repository's history: the seal hashing the sandbox while verify hashed
        // the author tree is mechanizable; "the requirement says X and nothing does X" is not.
        expect(classes.some((entry) => entry.oracle === 'mechanizable')).toBe(true);
        expect(classes.some((entry) => entry.oracle === 'judgment')).toBe(true);
        // And the two classes this change's own rounds produced most often are in it.
        expect(Object.keys(DEFECT_CLASSES)).toContain('one-fact-derived-twice');
        expect(Object.keys(DEFECT_CLASSES)).toContain('refusal-cannot-be-executed');
    });

    it('refuses a class that is not in the vocabulary, by name', () => {
        expect(() => requireDefectClass('walked-in-by-hand', 'finding R-9')).toThrow(/walked-in-by-hand/);
        expect(() => requireDefectClass('walked-in-by-hand', 'finding R-9')).toThrow(/one-fact-derived-twice/);
        expect(requireDefectClass('instrument-unsound', 'finding R-1')).toBe('instrument-unsound');
    });

    it('records the class, the origin, the axis and the instrument with the finding', async () => {
        await prepareRequest();
        const result = await record({
            findings: [finding({ class: 'one-fact-derived-twice', origin: 'repair', axis: 'declared link targets', instrument: 'differential comparison of the two streams' })],
            declaredCoverage: ['C-1'],
        });
        expect(result.success, JSON.stringify(result).slice(0, 300)).toBe(true);

        const record_ = JSON.parse(await readFile(reviewPath(root, changeId), 'utf8')) as {
            findings: Array<Record<string, unknown>>;
        };
        expect(record_.findings[0]).toMatchObject({
            class: 'one-fact-derived-twice',
            origin: 'repair',
            axis: 'declared link targets',
            instrument: 'differential comparison of the two streams',
        });
    });

    it('refuses a finding whose class is unknown rather than filing it under a neighbouring word', async () => {
        await prepareRequest();
        const result = await record({ findings: [finding({ class: 'kind-of-racy' })], declaredCoverage: ['C-1'] });
        expect(result.success).toBe(false);
        expect(String(result.error)).toContain('kind-of-racy');
        expect(String(result.error)).toMatch(/one-fact-derived-twice/);
    });

    it('records a finding without a class, and names it in the diagnostics', async () => {
        // **Legacy stays readable, and the gap stays visible.** Records written before the field existed must still record —
        // and the round that omits it is reported, so the absence is a measured fact rather than a silent hole.
        await prepareRequest();
        const result = await record({ findings: [finding()], declaredCoverage: ['C-1'] });
        expect(result.success, JSON.stringify(result).slice(0, 300)).toBe(true);

        const record_ = JSON.parse(await readFile(reviewPath(root, changeId), 'utf8')) as {
            findings: Array<Record<string, unknown>>;
            findingsWithoutClass?: string[];
        };
        expect(record_.findings[0].class).toBeUndefined();
        expect(record_.findingsWithoutClass).toEqual(['R-1']);
    });
});
