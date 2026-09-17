import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runProcess, runProcessSync } from '../../src/process/run.js';

/**
 * One facility, so that behaviour which should be invariant — a timeout, a captured log, an explicit environment, a
 * non-blocking wait — is not reinvented per call site. Eleven modules used to spawn directly; the differences only
 * surfaced when an environment exposed one.
 */
describe('process facility', () => {
    const roots: string[] = [];

    afterEach(async () => {
        await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
    });

    async function tempRoot(): Promise<string> {
        const root = await mkdtemp(join(tmpdir(), 'kata-process-'));
        roots.push(root);
        return root;
    }

    it('captures output, exit code and environment', async () => {
        const root = await tempRoot();

        const result = await runProcess(process.execPath, ['-e', 'process.stdout.write("out");process.stderr.write("err")'], { cwd: root });

        expect(result).toMatchObject({ ok: true, exitCode: 0, stdout: 'out', stderr: 'err' });
        expect(result.environment).toContain(`cwd=${root}`);
    });

    it('maps a timeout to exit code 124 and kills the process group', async () => {
        const root = await tempRoot();
        const pidFile = join(root, 'child.pid');

        const result = await runProcess('sh', ['-c', `trap '' TERM; echo $$ > ${pidFile}; sleep 30`], { cwd: root, timeoutMs: 300, killGraceMs: 200 });

        expect(result).toMatchObject({ ok: false, exitCode: 124, failure: 'timeout' });
        const pid = Number.parseInt((await (await import('node:fs/promises')).readFile(pidFile, 'utf8')).trim(), 10);
        // The child ignored SIGTERM; the group kill that follows must still stop it.
        const isAlive = (): boolean => {
            try {
                process.kill(pid, 0);
                return true;
            } catch {
                return false;
            }
        };
        const deadline = Date.now() + 5_000;
        while (isAlive() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
        expect(isAlive()).toBe(false);
    });

    it('cancels on an abort signal', async () => {
        const root = await tempRoot();
        const controller = new AbortController();
        setTimeout(() => controller.abort(), 150);

        const result = await runProcess(process.execPath, ['-e', 'setTimeout(()=>{}, 30000)'], { cwd: root, signal: controller.signal, killGraceMs: 100 });

        expect(result).toMatchObject({ ok: false, exitCode: 130, failure: 'aborted' });
    });

    it('reports a missing binary instead of throwing', async () => {
        const root = await tempRoot();

        const asyncResult = await runProcess('definitely-not-a-binary', [], { cwd: root });
        expect(asyncResult).toMatchObject({ ok: false, exitCode: 127, failure: 'spawn_failed' });

        const syncResult = runProcessSync('definitely-not-a-binary-xyz', [], { cwd: root });
        expect(syncResult.ok).toBe(false);
        // The platform decides whether a missing name is ENOENT or a PATH-entry refusal; both are "could not start".
        expect(['ENOENT', 'EACCES']).toContain(syncResult.error?.code);
    });

    it('runs synchronously for callers that cannot await, reporting rather than throwing', async () => {
        const root = await tempRoot();
        await writeFile(join(root, 'marker'), 'yes\n', 'utf8');

        const ok = runProcessSync(process.execPath, ['-e', 'process.exit(0)'], { cwd: root });
        expect(ok).toMatchObject({ ok: true, exitCode: 0 });

        const failing = runProcessSync(process.execPath, ['-e', 'process.stderr.write("bad");process.exit(3)'], { cwd: root });
        expect(failing).toMatchObject({ ok: false, exitCode: 3, stderr: 'bad' });

        const timedOut = runProcessSync(process.execPath, ['-e', 'setTimeout(()=>{}, 5000)'], { cwd: root, timeoutMs: 200 });
        expect(timedOut).toMatchObject({ ok: false, exitCode: 124, failure: 'timeout' });
    });
});
