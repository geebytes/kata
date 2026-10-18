import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { initLayout } from '../../src/core/layout.js';
import { createTask } from '../../src/core/task.js';
import { addKataRelation } from '../../src/core/relations.js';
import { createTaskRevisionIfChanged } from '../../src/workflow/revision.js';
import { dependencyIdentityFor } from '../../src/workflow/task-dependency.js';
import { speaksForDependency } from '../../src/workflow/verdict-binding.js';
import { judge } from '../../src/quality/judge.js';
import { evaluateJudgePass, evaluateReviewClearance } from '../../src/workflow/distill-gates.js';

/**
 * **The dependency identity is a different fact from the content identity, and both have to be stamped.**
 *
 * §6.2: *"不要将内容身份与依赖身份混为一个哈希 … 但 dependency edge/C revision/集成状态任何一个变化，旧的 D Review/Judge
 * 结论必须失效或进入具名需重验"*. The content half already existed (`revisionId`/`manifestHash`/`candidateFreezeSha256`); this
 * file is about the other half: it is stamped where a verdict is written, compared by one rule, and the comparison is asked
 * by the gate that clears a change — not re-implemented at each reader.
 */
const roots: string[] = [];

function write(root: string, relativePath: string, content: string): void {
    const target = join(root, relativePath);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
}

async function fixture(name: string, options: { edge?: boolean } = {}): Promise<string> {
    const root = mkdtempSync(join(tmpdir(), `kata-dependency-identity-${name}-`));
    roots.push(root);
    await initLayout(root);
    write(root, 'src/a.ts', 'export const holds = true;\n');
    await createTask({ root, id: 'dependent', title: 'd', acceptance: [{ id: 'AC-1', statement: 'x' }], ownedPaths: ['src/a.ts'] });
    await createTask({ root, id: 'corrective', title: 'c', acceptance: [{ id: 'AC-1', statement: 'x' }], ownedPaths: ['src/a.ts'] });
    if (options.edge !== false) {
        await addKataRelation({
            root,
            from: { type: 'task', id: 'dependent' },
            to: { type: 'task', id: 'corrective' },
            type: 'blocked_by',
            reason: 'the mechanism this change depends on',
        });
    }
    return root;
}

afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('the dependency identity is its own fact', () => {
    it('is absent when no edge claims the task, so an edge-less change is untouched', async () => {
        const root = await fixture('no-edge', { edge: false });
        expect(await dependencyIdentityFor(root, 'dependent')).toBeNull();
    });

    it('is stamped into the judge record beside the content binding, not instead of it', async () => {
        const root = await fixture('judge-stamp');
        const { revision } = await createTaskRevisionIfChanged({ root, taskId: 'dependent', ownedPaths: ['src/a.ts'], checkIds: [] });
        const identity = await dependencyIdentityFor(root, 'dependent');
        expect(identity).not.toBeNull();

        await judge({
            root,
            taskId: 'dependent',
            acceptance: [{ id: 'AC-1', statement: 'the judgement binds its dependency' }],
            evidence: [],
            currentDiffHash: 'a'.repeat(64),
            revisionRead: { kind: 'current', revision },
        });

        const stored = JSON.parse(readFileSync(join(root, '.kata/tasks/dependent/judge.json'), 'utf8')) as Record<string, unknown>;
        expect(stored.dependencyIdentity).toBe(identity);
        // Both halves are present: the dependency field did not replace the content binding.
        expect(stored.revisionId).toBe(revision.id);
        expect(typeof stored.manifestHash).toBe('string');
    });

    it('changes when the corrective action re-seals, and not when prose changes', async () => {
        const root = await fixture('moves');
        const first = await dependencyIdentityFor(root, 'dependent');

        // A corrective action's own re-seal is the fact the whole mechanism exists for: it must move the identity.
        write(root, 'src/a.ts', 'export const holds = "repaired";\n');
        const { revision } = await createTaskRevisionIfChanged({ root, taskId: 'corrective', ownedPaths: ['src/a.ts'], checkIds: [] });
        const second = await dependencyIdentityFor(root, 'dependent');
        expect(second).not.toBe(first);

        // Rewriting the edge's *reason* is governance prose, not a fact about what was certified: the identity holds.
        await addKataRelation({
            root,
            from: { type: 'task', id: 'dependent' },
            to: { type: 'task', id: 'corrective' },
            type: 'blocked_by',
            reason: 'the same edge, described differently',
        });
        expect(await dependencyIdentityFor(root, 'dependent'), 'prose must not expire a certification').toBe(second);
        expect(revision.id).toBeTruthy();
    });

    it('answers "was this verdict certified under this dependency" in one place', () => {
        // No edge: the question does not apply, so every verdict passes it and the older rules decide alone.
        expect(speaksForDependency({}, null)).toBe(true);
        expect(speaksForDependency({ dependencyIdentity: 'd1' }, null)).toBe(true);
        // An edge: the verdict must name it — and naming none is *not* a pass, because a record written before the edge
        // existed is exactly the state the design says must be re-validated rather than trusted.
        expect(speaksForDependency({ dependencyIdentity: 'd1' }, 'd1')).toBe(true);
        expect(speaksForDependency({ dependencyIdentity: 'd0' }, 'd1')).toBe(false);
        expect(speaksForDependency({}, 'd1')).toBe(false);
        expect(speaksForDependency(null, 'd1')).toBe(false);
    });
});

describe('the gate that clears a change asks the dependency half too', () => {
    it('refuses a review approved under an older dependency, and names that reason rather than staleness of content', async () => {
        const root = await fixture('review-clearance');
        const { revision } = await createTaskRevisionIfChanged({ root, taskId: 'dependent', ownedPaths: ['src/a.ts'], checkIds: [] });
        const identity = await dependencyIdentityFor(root, 'dependent');
        expect(identity).not.toBeNull();

        const approval = (dependencyIdentity: string): string => `${JSON.stringify({
            revisionId: revision.id,
            manifestHash: revision.manifestHash,
            reviewEvidence: 'the independent round this change was approved on',
            findings: [],
            status: 'approved',
            dependencyIdentity,
        })}\n`;

        // Bound to the dependency as it stands: cleared. The content binding is identical in both cases, so the only thing
        // that moves the answer is the dependency half.
        write(root, '.kata/tasks/dependent/review.json', approval(identity as string));
        expect(await evaluateReviewClearance(root, 'dependent', revision.id)).toMatchObject({ cleared: true });

        // Approved under a dependency that has since moved: the content still matches, and the clearance still refuses —
        // with its own reason, because the remedy is to re-run the certification rather than to re-read the round.
        write(root, '.kata/tasks/dependent/review.json', approval('a-dependency-that-has-moved'));
        expect(await evaluateReviewClearance(root, 'dependent', revision.id))
            .toMatchObject({ cleared: false, reason: 'stale_dependency' });
    });

    it('refuses a judgement certified under an older dependency, and lets the same record through under the current one', async () => {
        const root = await fixture('judge-clearance');
        const identity = await dependencyIdentityFor(root, 'dependent');
        expect(identity).not.toBeNull();
        const record = (dependencyIdentity: string): string => `${JSON.stringify({
            taskId: 'dependent',
            result: 'PASS',
            diffHash: 'a'.repeat(64),
            acceptance: [{ id: 'AC-1', result: 'PASS' }],
            dependencyIdentity,
        })}\n`;

        // The two calls differ only in the identity the record names, and they must not give the same answer. `no_evidence`
        // is the answer that means the dependency question was passed — this fixture has no fresh evidence on purpose, so
        // that reason is the proof the identity matched.
        write(root, '.kata/tasks/dependent/judge.json', record('a-dependency-that-has-moved'));
        expect((await evaluateJudgePass({ root, taskId: 'dependent', currentDiffHash: 'a'.repeat(64), freshEvidence: null })).reason)
            .toBe('stale_judgement');

        write(root, '.kata/tasks/dependent/judge.json', record(identity as string));
        expect((await evaluateJudgePass({ root, taskId: 'dependent', currentDiffHash: 'a'.repeat(64), freshEvidence: null })).reason)
            .toBe('no_evidence');
    });
});
