import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initLayout } from '../../src/core/layout.js';
import { createTask } from '../../src/core/task.js';
import { repairBriefing, renderRepairBriefing } from '../../src/quality/repair-briefing.js';

/**
 * The consumer `impact` and `classInstances` never had.
 *
 * Both were added to the finding contract and read by nothing, so a repair author decided how large its repair must be without
 * knowing what else the repair would reach or where else the class appears — which is how eight repairs on this line fixed one
 * instance of a class with several. The briefing renders the three questions before the repair, and this pins that it does: a
 * briefing that dropped them would read like a complete instruction.
 */
const roots: string[] = [];
afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('a repair author is told the three questions before it decides how large the repair is', () => {
    it('carries impact, classInstances and the class from the finding records', async () => {
        const root = await mkdtemp(join(tmpdir(), 'kata-briefing-'));
        roots.push(root);
        await initLayout(root);
        await createTask({ root, id: 'b-task', title: 'Briefing', acceptance: [{ id: 'AC-1', statement: 'x' }] });
        await mkdir(join(root, '.kata/tasks/b-task'), { recursive: true });
        await writeFile(join(root, '.kata/tasks/b-task/review.json'), `${JSON.stringify({
            revisionId: 'revision-x',
            findings: [{
                id: 'finding-one', taskId: 'b-task', severity: 'major', path: 'src/a.ts',
                message: 'a mechanism says one thing and does another',
                impact: 'the call sites in src/b.ts and the six fixtures that exercise them',
                classInstances: ['one-concept-several-derivations'],
                disposition: 'open',
            }],
        }, null, 2)}\n`, 'utf8');
        const briefing = await repairBriefing(root, 'b-task');
        expect(briefing.findings).toHaveLength(1);
        const [finding] = briefing.findings;
        // The three fields, each of which changes how large a correct repair is.
        expect(finding?.impact).toContain('src/b.ts');
        expect(finding?.classInstances).toEqual(['one-concept-several-derivations']);
        expect(finding?.classId).toBe('one-concept-several-derivations');
        // And the class section, which is the instruction that changes behaviour.
        expect(briefing.classes.map((entry) => entry.classId)).toEqual(['one-concept-several-derivations']);
        // **Assert the class section itself**, not the sentence in the header: the header would still print with the section
        // deleted, so an assertion on it cannot fail — the decorative-check class, caught by its own mutation.
        const rendered = renderRepairBriefing(briefing);
        expect(rendered).toContain('The classes in this batch:');
        expect(rendered).toContain('one-concept-several-derivations');
        expect(rendered).toContain('a concept is re-derived at each call site');
    });

    it('renders an empty briefing as nothing to repair rather than as an empty list', async () => {
        const root = await mkdtemp(join(tmpdir(), 'kata-briefing-'));
        roots.push(root);
        await initLayout(root);
        await createTask({ root, id: 'b-task', title: 'Briefing', acceptance: [{ id: 'AC-1', statement: 'x' }] });
        const briefing = await repairBriefing(root, 'b-task');
        expect(briefing.findings).toEqual([]);
        expect(renderRepairBriefing(briefing)).toContain('nothing to repair');
    });
});
