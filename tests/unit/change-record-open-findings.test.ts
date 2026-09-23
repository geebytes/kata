import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initLayout } from '../../src/core/layout.js';
import { createTask } from '../../src/core/task.js';
import { createTaskRevision } from '../../src/workflow/revision.js';

/**
 * AC-6's actual subject, which its declared selector never touched (`kgs-f5`): the change record's `openFindings`
 * derivation. The selector asserted that `readTrackedFindings` keeps an id the next pass did not re-raise — the upstream
 * source — while the criterion is about **the record**. It never built a record, never read one, and asserted nothing about
 * a finding's disposition.
 *
 * What the criterion requires, in three parts, and this locks the first two:
 *
 *  1. `openFindings` is derived rather than copied — it is the input filtered by disposition, not the base record's list;
 *  2. a finding raised between two seals appears in it;
 *  3. no record states `answered` for a finding the record itself lists as open.
 *
 * Part 3 is about the **repair batch** record rather than the change record — `answered` lives there — and **no test in the
 * repository asserts it**. That is recorded rather than papered over: a check nobody exercises is the class this change
 * exists to remove, and inventing one here would be the same mistake in a new place.
 */
const cleanup: string[] = [];

async function fixture(id: string): Promise<{ root: string; revisionId: string }> {
    const root = await mkdtemp(join(tmpdir(), `kata-open-findings-${id}-`));
    cleanup.push(root);
    await initLayout(root);
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src/one.ts'), 'export const one = 1;\n', 'utf8');
    await createTask({
        root,
        id,
        title: id,
        ownedPaths: ['src/one.ts', 'src/two.ts'],
        acceptance: [{ id: 'AC-1', statement: 'the record derives what is still open' }],
    } as never);
    const revision = await createTaskRevision({ root, taskId: id, ownedPaths: ['src/one.ts', 'src/two.ts'], checkIds: [] });
    return { root, revisionId: revision.id };
}

async function recordWith(
    root: string,
    id: string,
    revisionId: string,
    findings: Array<{ id: string; severity: string; disposition: string }>,
): Promise<{ openFindings: Array<{ id: string }>; counts: { openFindings: number } }> {
    const { buildChangeRecord } = await import('../../src/quality/change-record.js');
    return buildChangeRecord({
        root,
        taskId: id,
        revisionId,
        ownedPaths: ['src/one.ts', 'src/two.ts'],
        evidence: [],
        claimFailures: [],
        findings,
        contentDigests: { 'src/one.ts': 'aaa', 'src/two.ts': 'bbb' },
        baseContentDigests: { 'src/one.ts': 'aaa' },
    }) as never;
}

describe('the change record derives what is still open', () => {
    afterEach(async () => {
        await Promise.all(cleanup.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
    });

    it('lists a raised finding and leaves out one that is fixed', async () => {
        const { root, revisionId } = await fixture('open-findings');
        const record = await recordWith(root, 'open-findings', revisionId, [
            { id: 'raised-and-open', severity: 'major', disposition: 'open' },
            { id: 'raised-and-fixed', severity: 'major', disposition: 'fixed' },
            { id: 'raised-and-routed', severity: 'major', disposition: 'routed' },
        ]);

        const ids = record.openFindings.map((finding) => finding.id);
        expect(ids).toContain('raised-and-open');
        // Derived from the disposition, not from the input list: a fixed finding is not open, and a routed one still is —
        // it left this change, it was not repaired here.
        expect(ids).not.toContain('raised-and-fixed');
        expect(ids).toContain('raised-and-routed');
        // The count is the same fact, so it cannot disagree with the list it counts.
        expect(record.counts.openFindings).toBe(record.openFindings.length);
    });
});
