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
 * The corruption the substring rewrite caused is invisible in the exit code of a check that ignores its arguments and shows up
 * only in the log, so this case makes the arguments themselves decide the outcome: the check insists that the reference it was
 * given exists in the snapshot it is running in, and that the longer name it was given is byte-for-byte what the declaration
 * wrote. Under `value.replaceAll(authorRoot, sandboxRoot)` the second assertion fails; with the path-segment rule both hold —
 * so the seal's own success is the evidence that a check ran with the arguments its declaration named.
 *
 * **Boundary (measured at implementation time).** Only the seal executes checks through the sandbox mapping: the single caller
 * is `collectEvidence(checksForExecutionSandbox(checksToRun, root, sandbox.root), …)` (`src/workflow/orchestrator.ts`).
 * `kata-cli verify` executes nothing — it reads recorded evidence and compares digests — so the "and for `verify`" half of
 * this criterion describes a path that does not exist. That is recorded in the design document and in the change's claim
 * rather than asserted here.
 */
describe('the executed argument is the one the check declared', () => {
    it('runs a check with the arguments the declaration wrote: the reference mapped, the longer name untouched', async () => {
        const taskId = 'the-executed-argument';
        const root = await repositoryWithTask(taskId);

        // Two arguments, one property each. The **reference** embeds the root as a path segment and must arrive mapped, pointing
        // at the snapshot copy of the same path (`src/thing.ts` is committed, so it exists there); the **longer name** merely
        // continues after the root and must arrive exactly as written — its expected value is read from a file outside the
        // repository, because a literal written inside it would be mapped by the same rule and the comparison would agree by
        // accident.
        const expectedPath = join(tmpdir(), `kata-expected-arg-${taskId}.txt`);
        roots.push(expectedPath);
        const longerName = `${root}backup/application`;
        await writeFile(expectedPath, longerName, 'utf8');

        const script = 'const fs=require("fs");'
            + 'const mapped=process.argv[1].slice("key=".length);'
            + 'if(!fs.existsSync(mapped)){console.error(`the reference did not point at the snapshot: ${mapped}`);process.exit(1)}'
            + 'const want=fs.readFileSync(process.argv[3],"utf8");'
            + 'if(process.argv[2]!==want){console.error(`the longer name arrived as ${process.argv[2]}, the declaration wrote ${want}`);process.exit(1)}';
        const sealed = await runCommand('build', taskId, root, {
            seal: true,
            ownedPaths: ['src/thing.ts'],
            checks: [{
                kind: 'test',
                command: process.execPath,
                args: ['-e', script, `key=${root}/src`, longerName, expectedPath],
                cwd: root,
            }],
        } as never);

        expect(sealed.success, JSON.stringify(sealed).slice(0, 400)).toBe(true);
    });
});
