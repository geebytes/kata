import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initLayout } from '../../src/core/layout.js';
import { createTask } from '../../src/core/task.js';
import { createTaskRevision } from '../../src/workflow/revision.js';
import { runFindingsCommand } from '../../src/cli/findings.js';

/**
 * `findings add` is the production path for a review finding.
 *
 * Measured before this: `recordFinding` — which validates the finding, takes the task lock and binds the revision — had
 * **two callers, both non-production** (`src/eval/fixtures.ts`, `tests/e2e/quality-gates.test.ts`), and the CLI offered
 * only `list|defer|accept|carry`. So `review.json` could never become non-empty, and `review --approve` refused every
 * change with "Review approval requires non-empty review evidence": a mechanism with no consumer, in the one place where
 * the consumer is the gate.
 */
const cleanup: string[] = [];

async function fixture(id: string): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), `kata-findings-${id}-`));
    cleanup.push(root);
    await initLayout(root);
    await createTask({ root, id, title: id, ownedPaths: ['src/x.ts'], acceptance: [{ id: 'AC-1', statement: 'x' }] } as never);
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src/x.ts'), 'export const x = 1;\n', 'utf8');
    await createTaskRevision({ root, taskId: id, ownedPaths: ['src/x.ts'], checkIds: [] });
    return root;
}

async function at<T>(root: string, run: () => Promise<T>): Promise<T> {
    const before = process.cwd();
    process.chdir(root);
    try {
        return await run();
    } finally {
        process.chdir(before);
    }
}

describe('a review finding can be recorded from the command line', () => {
    afterEach(async () => {
        await Promise.all(cleanup.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
    });

    it('writes the finding into the review record, which is what the approval gate reads', async () => {
        const root = await fixture('add-ok');
        const result = await at(root, () => runFindingsCommand(['add', '--change', 'add-ok', '--severity', 'major', '--message', 'the guard is decorative', '--path', 'src/x.ts']));

        expect(result.severity).toBe('major');
        // Asserted on disk, not on the return value: the gate reads the file.
        const record = JSON.parse(await readFile(join(root, '.kata', 'tasks', 'add-ok', 'review.json'), 'utf8')) as {
            findings: Array<{ id?: string; severity?: string; message?: string; path?: string }>;
        };
        expect(record.findings).toHaveLength(1);
        expect(record.findings[0]).toMatchObject({ severity: 'major', message: 'the guard is decorative', path: 'src/x.ts' });
        expect(result.findingId).toBe(record.findings[0]?.id);
    });

    it('names the vocabulary rather than reporting a schema path', async () => {
        const root = await fixture('add-bad-severity');
        await expect(at(root, () => runFindingsCommand(['add', '--change', 'add-bad-severity', '--severity', 'nit', '--message', 'x'])))
            .rejects.toThrow(/Unknown severity 'nit'.*blocking, major, minor/s);
    });

    it('refuses a finding with no message, since a finding without a defect says nothing', async () => {
        const root = await fixture('add-no-message');
        await expect(at(root, () => runFindingsCommand(['add', '--change', 'add-no-message', '--severity', 'minor'])))
            .rejects.toThrow(/Usage: kata-cli findings add/);
    });
});

/**
 * AC-4 of `kata-gate-surface`: the routed terminal disposition.
 *
 * Until this existed, a finding whose repair lay outside the change that raised it had two exits: repair it (the loop that
 * `wiring-coverage-check` measured over three rounds) or `adversarial waive`, which replaces the node record with one that
 * says it makes no claim to have looked — an erasure, not a resolution. `defer` and `accept` refuse `blocking` and `major`
 * outright, so the middle route did not exist.
 */
describe('a finding can be routed to the change that will carry it', () => {
    afterEach(async () => {
        await Promise.all(cleanup.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
    });

    it('routes a major finding, and refuses a target that does not exist', async () => {
        const root = await fixture('rout-ok');
        await at(root, () => runFindingsCommand(['add', '--change', 'rout-ok', '--severity', 'major', '--message', 'repair lives elsewhere']));
        const findingId = (JSON.parse(await readFile(join(root, '.kata', 'tasks', 'rout-ok', 'review.json'), 'utf8')) as {
            findings: Array<{ id: string }>;
        }).findings[0]!.id;

        // A target that exists: the routed finding leaves this change and names where it goes.
        await mkdir(join(root, '.kata', 'tasks', 'carrier-change'), { recursive: true });
        const routed = await at(root, () => runFindingsCommand(['rout', '--change', 'rout-ok', '--id', findingId, '--to', 'carrier-change']));
        expect(routed.to).toBe('carrier-change');

        const record = JSON.parse(await readFile(join(root, '.kata', 'tasks', 'rout-ok', 'review.json'), 'utf8')) as {
            findings: Array<{ id: string; disposition?: string }>;
        };
        // Dispositioned, not deleted: the finding is still there and says where it went.
        expect(record.findings.find((finding) => finding.id === findingId)?.disposition).toBe('routed');

        // A target nobody opened is a disappearance with a nicer name, so it is refused.
        await expect(at(root, () => runFindingsCommand(['rout', '--change', 'rout-ok', '--id', findingId, '--to', 'nowhere'])))
            .rejects.toThrow(/no such change exists/);
    });

    it('requires a reason, so a finding may leave but not leave unnamed', async () => {
        const { dispositionDenial } = await import('../../src/quality/finding-disposition.js');
        const finding = { id: 'f-major', source: 'review', severity: 'major', disposition: 'open' } as never;
        expect(dispositionDenial(finding, 'routed', undefined, null)).toMatch(/requires --reason naming the change/);
        expect(dispositionDenial(finding, 'routed', 'carried by kata-gate-surface', null)).toBeNull();
        // And the refusal that made this disposition necessary is still in force for the other two.
        expect(dispositionDenial(finding, 'deferred', 'later', null)).toMatch(/must be repaired/);
    });
});
