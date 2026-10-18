import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { CERTIFICATION_MACHINERY, certificationMachineryFor, certificationSurfaceFor } from '../../src/quality/certification-surface.js';
import { initLayout } from '../../src/core/layout.js';
import { createTask } from '../../src/core/task.js';
import { addKataRelation } from '../../src/core/relations.js';
import { createTaskRevisionIfChanged } from '../../src/workflow/revision.js';
import { dependencyRefusal, readTaskDependency, recordDependencyReturn } from '../../src/workflow/task-dependency.js';
import { runDependencyCommand } from '../../src/cli/dependency.js';

/**
 * **A change that edits the machinery judging it cannot be its own evidence.**
 *
 * The hazard: a corrective action C may modify the modules that certify C, and then C's PASS is the only evidence the rules
 * are sound — self-certification, the shape this repository refuses at every other layer. No trustworthy evaluator exists
 * to take that place, so the design's answer is that C's qualification is `undetermined`, and this file is where that answer
 * is measured.
 *
 * The list is itself the risk: a hand-written surface rots, and a surface that silently stops matching is a gate that
 * silently stops gating. So the first two cases are about the list rather than about any change.
 */
const roots: string[] = [];

function write(root: string, relativePath: string, content: string): void {
    const target = join(root, relativePath);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
}

async function fixture(name: string, correctiveOwnedPaths: string[]): Promise<{ root: string; relationId: string }> {
    const root = mkdtempSync(join(tmpdir(), `kata-certifier-${name}-`));
    roots.push(root);
    await initLayout(root);
    write(root, 'src/deliverable.ts', 'export const holds = true;\n');
    await createTask({ root, id: 'dependent', title: 'd', acceptance: [{ id: 'AC-1', statement: 'x' }], ownedPaths: ['src/deliverable.ts'] });
    write(root, 'src/dependent.ts', 'export const d = true;\n');
    await createTask({ root, id: 'corrective', title: 'c', acceptance: [{ id: 'AC-1', statement: 'x' }], ownedPaths: correctiveOwnedPaths });
    for (const path of correctiveOwnedPaths) write(root, path, 'export const held = true;\n');
    const { revision } = await createTaskRevisionIfChanged({ root, taskId: 'corrective', ownedPaths: correctiveOwnedPaths });
    // A fully certified corrective action: judged, reviewed and approved — the strongest state C can be in. The point of
    // this file is that even *this* is not enough when C edited the certifier.
    write(root, '.kata/tasks/corrective/judge.json', `${JSON.stringify({ taskId: 'corrective', result: 'PASS', revisionId: revision.id, acceptance: [{ id: 'AC-1', result: 'PASS' }] })}\n`);
    write(root, '.kata/tasks/corrective/review.json', `${JSON.stringify({
        revisionId: revision.id, manifestHash: revision.manifestHash, reviewedRevisionId: revision.id,
        recordedAt: '2026-01-01T00:00:00.000Z', reviewEvidence: 'the independent round', findings: [], status: 'approved',
    })}\n`);
    const graph = await addKataRelation({
        root,
        from: { type: 'task', id: 'dependent' },
        to: { type: 'task', id: 'corrective' },
        type: 'blocked_by',
        reason: 'the mechanism this change depends on',
    });
    return { root, relationId: graph.relations.find((entry) => entry.from.id === 'dependent')?.id ?? '' };
}

describe('the certification surface is a declaration under test', () => {
    it('names only paths that exist, each with a reason', () => {
        expect(CERTIFICATION_MACHINERY.length, 'an empty surface would make the rule vacuous').toBeGreaterThan(0);
        for (const entry of CERTIFICATION_MACHINERY) {
            expect(entry.why.trim().length, `${entry.path} must say why it is on the surface`).toBeGreaterThan(20);
            // A directory entry names a real directory; a file entry names a real file. Either way the path is here.
            expect(existsSync(entry.path.replace(/\/$/, '')), `${entry.path} does not exist in this repository`).toBe(true);
        }
    });

    it('matches files exactly and directories by prefix, and reports the entries rather than a boolean', () => {
        expect(certificationMachineryFor('src/quality/review-ladder.ts')?.path).toBe('src/quality/review-ladder.ts');
        expect(certificationMachineryFor('src/kernel/decide.ts')?.path).toBe('src/kernel/');
        expect(certificationMachineryFor('./src/store/verdict.ts')?.path, 'a leading ./ is the same path').toBe('src/store/verdict.ts');
        // Not a prefix match on a file entry, and not a near-miss: `src/quality/` is deliberately not on the surface.
        expect(certificationMachineryFor('src/quality/review-ladder.ts.bak')).toBeUndefined();
        expect(certificationMachineryFor('src/quality/evidence.ts')).toBeUndefined();
        expect(certificationMachineryFor('src/workflow/orchestrator.ts')).toBeUndefined();

        const matched = certificationSurfaceFor(['src/deliverable.ts', 'src/store/verdict.ts', 'src/kernel/quorum.ts']);
        expect(matched.map((entry) => entry.path)).toEqual(['src/store/verdict.ts', 'src/kernel/']);
    });
});

describe('a certifier cannot certify itself', () => {
    it('is undetermined when the corrective action edits the machinery, however certified it is', async () => {
        const { root, relationId } = await fixture('touches', ['src/quality/review-ladder.ts']);

        const decision = await readTaskDependency(root, 'dependent');
        expect(decision.state).toBe('undetermined');
        expect(decision.blockers[0]?.reason).toBe('corrective_changes_the_certifier');
        // The refusal names the module, so the operator can see what put it there.
        expect(decision.blockers[0]?.detail).toContain('src/quality/review-ladder.ts');
        // And the roads are commands that exist: separating the work, or stopping this change.
        expect(decision.blockers[0]?.road).toContain('kata-cli completion stop');
        expect(decision.blockers[0]?.road).toContain('kata-cli scope change');

        // `undetermined` refuses the same entries `pending` does — the design's table, not a weaker reading. Asked of the
        // refusal function the gates use, so this is the answer every entry would get.
        for (const entry of ['seal', 'verify', 'review', 'judge', 'archive'] as const) {
            expect(dependencyRefusal(decision, entry), `${entry} must be refused`).not.toBeNull();
        }

        // The writer refuses too: the receipt that unblocks the dependent change cannot be signed.
        await expect(recordDependencyReturn({ root, taskId: 'dependent', relationId }))
            .rejects.toThrow(/edits the machinery that decides whether it is certified/u);

        // And the CLI reports the same thing, because it asks the same decision.
        const status = await runDependencyCommand(['status', '--change', 'dependent', '--root', root]);
        expect(status.state).toBe('undetermined');
    });

    it('leaves an ordinary corrective action alone, so the surface is not a gate on all repair work', async () => {
        const { root, relationId } = await fixture('ordinary', ['src/corrective.ts']);

        const decision = await readTaskDependency(root, 'dependent');
        expect(decision.state).toBe('pending');
        expect(decision.blockers[0]?.reason).toBe('return_not_recorded');

        // And it returns normally: certified, reviewed, integrated content recorded.
        await recordDependencyReturn({ root, taskId: 'dependent', relationId });
        expect((await readTaskDependency(root, 'dependent')).state).toBe('ready_to_revalidate');
    });

    it('reads the surface from the certified revision, not from a later task declaration', async () => {
        // The revision is the content that would be certified. A task that later widened its own scope must not be able to
        // move itself off the surface (or onto it) after the fact.
        const { root } = await fixture('frozen', ['src/corrective.ts']);
        write(root, '.kata/tasks/corrective/task.json', `${JSON.stringify({
            id: 'corrective', title: 'c', acceptance: [{ id: 'AC-1', statement: 'x' }],
            ownedPaths: ['src/corrective.ts'], instruments: ['src/quality/review-ladder.ts'],
        }, null, 2)}\n`);
        expect((await readTaskDependency(root, 'dependent')).state, 'a declared instrument is not the same list').toBe('pending');
    });
});

describe('the refusal is reachable through the CLI', () => {
    it('refuses a return through the command an operator actually runs', async () => {
        const { root, relationId } = await fixture('cli', ['src/kernel/quorum.ts']);
        await expect(runDependencyCommand(['record', '--change', 'dependent', '--relation', relationId, '--root', root]))
            .rejects.toThrow(/edits the machinery/u);
    });
});

process.on('exit', () => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
});
