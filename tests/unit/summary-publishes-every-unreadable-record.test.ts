import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readUpstreamSummary } from '../../src/workflow/navigation.js';

/**
 * The summary's own file reader answered `null` for every failure — ENOENT, a parse error, a permission error — so a record
 * that could not be read was indistinguishable from one nobody had written, at every surface that published it.
 *
 * `readValidatedOptional` is the contract this suite holds the summary to: only `ENOENT` is absent. Each case below is one
 * artefact, and each one is asserted twice — corrupt publishes a refusal, missing publishes nothing — because either half
 * alone can be satisfied by the wrong reader.
 */
const taskId = 'unreadable-records';
let root: string;

async function seed(): Promise<void> {
    root = await mkdtemp(join(tmpdir(), 'kata-unreadable-'));
    await mkdir(join(root, '.kata', 'tasks', taskId, 'review'), { recursive: true });
    await mkdir(join(root, '.kata', 'evidence'), { recursive: true });
    await writeFile(
        join(root, '.kata', 'tasks', taskId, 'task.json'),
        `${JSON.stringify({ id: taskId, title: 'T', phase: 'review', acceptance: [], ownedPaths: [] })}\n`,
    );
    await writeFile(
        join(root, '.kata', 'tasks', taskId, 'current-state.json'),
        `${JSON.stringify({ taskId, phase: 'review' })}\n`,
    );
}

function fieldOf(upstream: unknown, field: string): string | undefined {
    return (upstream as Record<string, string | undefined>)[field];
}

describe('every record the summary reads separates absence from unreadable', () => {
    beforeEach(seed);
    afterEach(async () => {
        await rm(root, { recursive: true, force: true });
    });

    const records = [
        { file: 'judge.json', field: 'judgeUnreadable' },
        { file: 'verify.json', field: 'verifyUnreadable' },
        { file: 'task.json', field: 'taskUnreadable' },
    ] as const;

    for (const { file, field } of records) {
        it(`publishes a corrupt ${file} instead of reading it as absent`, async () => {
            await writeFile(join(root, '.kata', 'tasks', taskId, file), '{ this is not JSON\n');

            const upstream = await readUpstreamSummary(root, taskId);

            expect(fieldOf(upstream, field)).toContain(file);
            // A refusal nobody counts is a refusal the ladder cannot act on.
            expect(upstream.reviewFindings).toBeGreaterThanOrEqual(1);
            expect(upstream.blockingFindings).toBeGreaterThanOrEqual(1);
        });

        it(`publishes nothing for a missing ${file}`, async () => {
            const upstream = await readUpstreamSummary(root, taskId);

            expect(fieldOf(upstream, field)).toBeUndefined();
            expect(upstream.reviewFindings).toBe(0);
        });
    }

    for (const { file, field } of [
        { file: 'judge.json', field: 'judgeUnreadable' },
        { file: 'verify.json', field: 'verifyUnreadable' },
    ] as const) {
        it(`publishes ${file} whose acceptance is not a record array as unreadable`, async () => {
            await writeFile(join(root, '.kata', 'tasks', taskId, file), `${JSON.stringify({ acceptance: 'not-an-array' })}\n`);

            const upstream = await readUpstreamSummary(root, taskId);

            expect(fieldOf(upstream, field)).toContain(file);
            expect(upstream.reviewFindings).toBeGreaterThanOrEqual(1);
        });

        it(`publishes ${file} whose acceptance member is not a record as unreadable`, async () => {
            await writeFile(join(root, '.kata', 'tasks', taskId, file), `${JSON.stringify({ acceptance: [null] })}\n`);

            const upstream = await readUpstreamSummary(root, taskId);

            expect(fieldOf(upstream, field)).toContain(file);
            expect(upstream.reviewFindings).toBeGreaterThanOrEqual(1);
        });
    }

    it('keeps an evidence file it cannot read and names it, instead of dropping it', async () => {
        await writeFile(join(root, '.kata', 'evidence', `${taskId}-hard.json`), '{ this is not JSON\n');

        const upstream = await readUpstreamSummary(root, taskId);

        // Dropping it was the same defect one layer up: the file exists, it is this task's by name, and the summary said
        // nothing about it — so `failingEvidence` counted a set the operator could not reconcile with the directory.
        expect(upstream.evidenceFiles).toContain(`${taskId}-hard.json`);
        expect(fieldOf(upstream, 'evidenceUnreadable')).toContain(`${taskId}-hard.json`);
        expect(upstream.reviewFindings).toBeGreaterThanOrEqual(1);
    });
});
