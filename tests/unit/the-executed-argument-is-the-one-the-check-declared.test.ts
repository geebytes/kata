import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { initLayout } from '../../src/core/layout.js';
import { runCommand } from '../../src/workflow/orchestrator.js';

const run = promisify(execFile);
const roots: string[] = [];

async function repositoryWithTask(taskId: string): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'kata-executed-arg-'));
    roots.push(root);
    await run('git', ['init', '-q'], { cwd: root });
    await run('git', ['config', 'user.email', 'kata@example.test'], { cwd: root });
    await run('git', ['config', 'user.name', 'kata'], { cwd: root });
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src', 'thing.ts'), 'export const thing = 1;\n', 'utf8');
    await run('git', ['add', '-A'], { cwd: root });
    await run('git', ['commit', '-qm', 'fixture'], { cwd: root });
    await initLayout(root);
    // `initLayout` writes the workspace's own files (`.gitignore` among them); a seal refuses content the declaration does not
    // cover, so the fixture commits them before the task exists.
    await run('git', ['add', '-A'], { cwd: root });
    await run('git', ['commit', '-qm', 'layout'], { cwd: root });
    await runCommand('open', taskId, root, {
        isolationMode: 'current_worktree',
        developmentMode: 'tdd',
        reviewMode: 'strict',
        acceptance: [{ id: 'AC-1', statement: 'The declared argument is the executed argument.' }],
        ownedPaths: ['src/thing.ts'],
    } as never);
    // `build` starts implementation or a repair; a task that has just been opened is in `intake`, so the design step is what
    // moves it to where a seal can run.
    await runCommand('design', taskId, root);
    return root;
}

afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/**
 * **The argument the sandbox executes is the argument the check declared.**
 *
 * The corruption the substring rewrite caused is invisible in the exit code of a check that ignores its arguments and only
 * appears in the log, so this case makes the argument itself decide the outcome: the check compares the value it received
 * with the literal value the declaration wrote (read from a file outside the repository, so the expected value is not itself
 * rewritten), and exits non-zero when they differ. Under `value.replaceAll(authorRoot, sandboxRoot)` the check fails; with the
 * whole-value rule it passes — so the seal's own success is the evidence that a check really ran with its declared argument.
 *
 * **Boundary (measured at implementation time).** Only the seal executes checks through the sandbox mapping: the single caller
 * is `collectEvidence(checksForExecutionSandbox(checksToRun, root, sandbox.root), …)` (`src/workflow/orchestrator.ts`).
 * `kata-cli verify` executes nothing — it reads recorded evidence and compares digests — so the "and for `verify`" half of
 * this criterion describes a path that does not exist. That is recorded in the design document and in the change's claim
 * rather than asserted here.
 */
describe('the executed argument is the one the check declared', () => {
    it('runs a check with the argument the declaration wrote, not with a substring rewrite of it', async () => {
        const taskId = 'the-executed-argument';
        const root = await repositoryWithTask(taskId);

        // The declared argument embeds the repository root but does not begin with it — the shape the substring rewrite used to
        // corrupt. Its expected value lives in a file outside the repository, written before the check runs, because a value
        // written *inside* the repository would be rewritten by the same rule and the comparison would agree by accident.
        const expectedPath = join(tmpdir(), `kata-expected-arg-${taskId}.txt`);
        roots.push(expectedPath);
        // A value that embeds the root without beginning with it, and that `node` does not mistake for one of its own options.
        const declaredArgument = `root=${root}/src`;
        await writeFile(expectedPath, declaredArgument, 'utf8');

        const script = 'const fs=require("fs");const got=process.argv[1];const want=fs.readFileSync(process.argv[2],"utf8");'
            + 'if(got!==want){console.error(`the check received ${got}, the declaration wrote ${want}`);process.exit(1)}';
        const sealed = await runCommand('build', taskId, root, {
            seal: true,
            ownedPaths: ['src/thing.ts'],
            checks: [{ kind: 'test', command: process.execPath, args: ['-e', script, declaredArgument, expectedPath], cwd: root }],
        } as never);

        expect(sealed.success, JSON.stringify(sealed).slice(0, 400)).toBe(true);
    });
});
