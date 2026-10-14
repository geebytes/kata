import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { initLayout } from '../../src/core/layout.js';
import { runWorkflowCommand } from '../../src/cli/workflow.js';
import { classifyLaneAndDeclaration } from '../../src/quality/classification.js';
import { defaultPolicy } from '../../src/kernel/policy.js';

describe('the lane and declaration classification are reported together', () => {
    const roots: string[] = [];
    afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

    it('names a below-floor lane at open and records the facts on the task', async () => {
        const root = await mkdtemp(join(tmpdir(), 'kata-lane-classification-'));
        roots.push(root);
        await initLayout(root);
        execFileSync('git', ['init', '--quiet'], { cwd: root });
        execFileSync('git', ['config', 'user.email', 'kata@example.test'], { cwd: root });
        execFileSync('git', ['config', 'user.name', 'Kata Test'], { cwd: root });

        const changeId = 'lane-classification';
        const agentFile = join(root, 'agent-classification.json');
        await writeFile(agentFile, `${JSON.stringify({ tier: 'standard', reasons: ['questions 1-5 found no gate, identity, schema, trust-boundary or external-contract change'], riskClasses: ['consistency'] })}\n`);
        const result = await runWorkflowCommand('open', changeId, root, 'pi', [
            'open', changeId, '--isolation', 'current_worktree', '--development', 'tdd', '--review', 'std', '--owned-path', 'src/kernel/risk.ts', '--classification-file', agentFile,
        ]);
        expect(result.success).toBe(true);

        const diagnostics = result.diagnostics as Record<string, unknown>;
        const classification = diagnostics.classification as Record<string, unknown>;
        expect(classification.tier).toBe('security');
        expect(classification.floor).toBe('high');
        expect(classification.matched).toEqual(expect.arrayContaining([
            expect.objectContaining({ path: 'src/kernel/risk.ts', floor: 'high' }),
        ]));
        expect(diagnostics.lane).toBe('std');
        expect(diagnostics.laneTier).toBe('standard');
        expect(diagnostics.laneBelow).toBe(true);
        expect(String(diagnostics.laneBelowNote)).toContain(changeId);
        expect(String(diagnostics.laneBelowNote)).toContain('src/kernel/risk.ts');

        // AC-7's record is not reconstructed later from a fresh policy read: the same facts are durably attached to this task.
        const stored = JSON.parse(await readFile(join(root, '.kata', 'tasks', changeId, 'classification.json'), 'utf8')) as Record<string, unknown>;
        expect(stored).toMatchObject({
            version: 1,
            by: 'floor',
            tier: 'security',
            floor: 'high',
            lane: 'std',
            laneTier: 'standard',
            laneBelow: true,
        });
        expect(stored.reasons).toEqual(expect.arrayContaining([
            'questions 1-5 found no gate, identity, schema, trust-boundary or external-contract change',
            expect.stringContaining('Raised from standard to the path floor security'),
        ]));
        expect(stored.riskClasses).toEqual(expect.arrayContaining(['consistency', 'privilege']));
        expect(stored.facts).toMatchObject({ declaredPaths: ['src/kernel/risk.ts'], wideChange: false });
    });

    it('does not report a lane below the classification it equals', () => {
        // **The pair a comparison written `<` versus `<=` flips, and the pair a second ordering can still get wrong.** The
        // case that used to stand here scanned the source for the word `TIER_RANK` and was fooled by a comment: an
        // independent round put a hand-written ordering on the line and left `TIER_RANK` in a comment, and it stayed green.
        // What is decidable is the *value*: a lane whose tier equals the classification's tier is not below it.
        const answer = classifyLaneAndDeclaration({ paths: ['src/anything.ts'], policy: defaultPolicy(), reviewMode: 'std' });
        expect(answer.laneTier).toBe(answer.classification.tier);
        expect(answer.laneBelow, 'a lane that equals the classification is not below it').toBe(false);
    });
});
