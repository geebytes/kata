import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initLayout } from '../../src/core/layout.js';
import { createTask } from '../../src/core/task.js';
import { runCommand } from '../../src/workflow/orchestrator.js';

/**
 * C3, wired: a false sentence in an acceptance statement fails **the seal**, on the revision it describes.
 *
 * The measurement this exists for: twice in one day a claim about the code that was not true passed the seal *and* verify,
 * and was caught only by the next independent round — because prose had no test. Here it has one.
 */
describe('a claim fails the seal rather than waiting for the next round', () => {
    const roots: string[] = [];
    afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

    async function workspace(claims: Array<Record<string, unknown>>): Promise<string> {
        const root = await mkdtemp(join(tmpdir(), 'kata-claim-seal-'));
        roots.push(root);
        await initLayout(root);
        await createTask({
            root,
            id: 'claim-task',
            title: 'Claims',
            ownedPaths: ['src/'],
            acceptance: [{ id: 'AC-1', statement: 'the sentence under test', claims: claims as never }],
        });
        const { mkdir } = await import('node:fs/promises');
        await mkdir(join(root, 'src'), { recursive: true });
        await writeFile(join(root, 'src/a.py'), 'def f():\n    return 1\n', 'utf8');
        // The fixture declares its own checks, so the seal runs a set a real project would have (`discoverChecks` off and
        // one trivial check) rather than kata's defaults, which need a TypeScript project to pass.
        await writeFile(
            join(root, '.kata-config.json'),
            JSON.stringify({ quality: { discoverChecks: false, buildChecks: [{ id: 'noop', name: 'noop', kind: 'lint', command: 'true' }] } }),
            'utf8',
        );
        // The seal runs from `plan` onwards, so the fixture advances the task the way a real one arrives there.
        await runCommand('design', 'claim-task', root, {});
        return root;
    }

    it('refuses a claim whose check cannot fail, before running anything', async () => {
        const root = await workspace([{ id: 'decorative', statement: 'x holds', check: { command: 'true' } }]);

        const result = await runCommand('build', 'claim-task', root, { seal: true, checks: [{ kind: 'lint', command: 'true', args: [] }] });
        // The refusal is a preflight blocker with its own diagnostics, not a red run the reader has to interpret.
        expect(result).toMatchObject({ command: 'build', success: false });
        expect(JSON.stringify(result.diagnostics)).toContain('cannot fail');
    });

    it('passes the seal when the claim holds', async () => {
        const root = await workspace([
            { id: 'holds', statement: 'src/a.py returns 1', check: { command: 'node', args: ['-e', 'process.exit(0)'], expect: { exitCode: 0 } } },
        ]);

        const result = await runCommand('build', 'claim-task', root, { seal: true });
        expect(result.success).toBe(true);
        // Reported by claim id, so the sentence is visible in the seal's own output.
        expect(JSON.stringify(result.diagnostics?.claims ?? [])).toContain('claim:AC-1:holds');
        expect(result.diagnostics?.claimFailures).toBeUndefined();
    });

    it('fails the seal when the evidence contradicts the claim, naming the sentence and the command', async () => {
        const root = await workspace([
            {
                id: 'false-claim',
                statement: 'src/a.py returns 2',
                check: { command: 'node', args: ['-e', 'process.exit(3)'], expect: { exitCode: 0 } },
            },
        ]);

        const result = await runCommand('build', 'claim-task', root, { seal: true });
        expect(result.success).toBe(false);
        const failures = (result.diagnostics?.claimFailures ?? []) as Array<{ description?: string }>;
        expect(failures).toHaveLength(1);
        expect(failures[0]?.description).toContain('src/a.py returns 2');
        expect(failures[0]?.description).toContain('expected exit 0, got exit 3');
    });
});
