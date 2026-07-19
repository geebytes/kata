import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { execFileSync, execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initLayout } from '../../src/core/layout.js';
import { runCommand } from '../../src/workflow/orchestrator.js';
import { collectEvidence, type CheckProgressEvent, type CheckCommand } from '../../src/quality/evidence.js';

describe('Seal progress and ownership scope', () => {
  const roots: string[] = [];

  async function tempRoot(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'kata-seal-scope-'));
    roots.push(root);
    await initLayout(root);
    execFileSync('git', ['init', '--quiet'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 'kata@example.test'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 'Kata Test'], { cwd: root });
    return root;
  }

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
  });

  // AC-1: No ownedPaths → fast failure before revision/evidence/workspace scan
  it('AC-1: fails fast when no ownedPaths and no --owned-path', async () => {
    const root = await tempRoot();
    await writeFile(join(root, 'tracked.txt'), 'content\n', 'utf8');
    execFileSync('git', ['add', 'tracked.txt'], { cwd: root });
    execFileSync('git', ['commit', '--quiet', '-m', 'baseline'], { cwd: root });
    await writeFile(join(root, 'untracked.txt'), 'drift\n', 'utf8');

    await runCommand('open', 'fast-fail-test', root, {
      title: 'Fast fail',
      acceptance: [{ id: 'AC-1', statement: 'Fail without ownedPaths.' }],
    });
    await runCommand('design', 'fast-fail-test', root);

    const result = await runCommand('build', 'fast-fail-test', root, {
      seal: true,
      checks: [{ kind: 'test', command: process.execPath, args: ['-e', 'process.exit(0)'], cwd: root }],
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('--owned-path');
    expect(result.diagnostics?.missingOwnedPaths).toBe(true);
    const taskRaw = JSON.parse(await readFile(join(root, '.kata/tasks/fast-fail-test/task.json'), 'utf8')) as { ownedPaths?: string[] };
    expect(taskRaw.ownedPaths).toBeUndefined();
    expect(() => execFileSync('ls', [join(root, '.kata/evidence/fast-fail-test-hard.json')], { stdio: 'pipe' })).toThrow();
  });

  // AC-1: Explicit --owned-path still works normally
  it('AC-1: explicit --owned-path seals successfully', async () => {
    const root = await tempRoot();
    await writeFile(join(root, 'owned.txt'), 'owned\n', 'utf8');
    execFileSync('git', ['add', 'owned.txt'], { cwd: root });
    execFileSync('git', ['commit', '--quiet', '-m', 'baseline'], { cwd: root });

    await runCommand('open', 'explicit-path-test', root, {
      title: 'Explicit path',
      acceptance: [{ id: 'AC-1', statement: 'Seal with explicit path.' }],
    });
    await runCommand('design', 'explicit-path-test', root);

    const result = await runCommand('build', 'explicit-path-test', root, {
      seal: true,
      ownedPaths: ['owned.txt'],
      checks: [{ kind: 'test', command: process.execPath, args: ['-e', 'process.exit(0)'], cwd: root }],
    });

    expect(result.success).toBe(true);
    expect(result.phase).toBe('hardVerify');
    expect(result.diagnostics?.ownedPaths).toEqual(['owned.txt']);
    expect(result.diagnostics?.ownedPathsSource).toBe('build-option');
  });

  // AC-2: Progress events emitted with correct structure
  it('AC-2: emits started and finished progress events for each check', async () => {
    const root = await tempRoot();
    await writeFile(join(root, 'tracked.txt'), 'content\n', 'utf8');
    execFileSync('git', ['add', 'tracked.txt'], { cwd: root });
    execFileSync('git', ['commit', '--quiet', '-m', 'baseline'], { cwd: root });

    const events: CheckProgressEvent[] = [];
    const checks: CheckCommand[] = [
      { kind: 'test', name: 'check-a', command: process.execPath, args: ['-e', 'process.exit(0)'], cwd: root },
      { kind: 'test', name: 'check-b', command: process.execPath, args: ['-e', 'process.exit(0)'], cwd: root },
    ];

    await collectEvidence('progress-test', checks, {
      onProgress: (event) => { events.push(event); },
    });

    expect(events.length).toBe(4);
    expect(events[0]).toMatchObject({ type: 'quality_check_progress', check: 'check-a', state: 'started' });
    expect(events[1]).toMatchObject({ type: 'quality_check_progress', check: 'check-a', state: 'passed', exitCode: 0 });
    expect(events[2]).toMatchObject({ type: 'quality_check_progress', check: 'check-b', state: 'started' });
    expect(events[3]).toMatchObject({ type: 'quality_check_progress', check: 'check-b', state: 'passed', exitCode: 0 });
    events.forEach((e) => {
      expect(e.type).toBe('quality_check_progress');
      expect(e.timeoutMs).toBeGreaterThan(0);
      expect(e.check).toBeTruthy();
    });
  });

  // AC-2: Progress events do not contain stdout/stderr or environment values
  it('AC-2: progress events do not leak command output or environment', async () => {
    const root = await tempRoot();
    const events: string[] = [];

    await collectEvidence('no-leak-test', [
      { kind: 'test', command: process.execPath, args: ['-e', 'console.log("secret-token-abc")'], cwd: root, redact: ['secret-token-abc'] },
    ], {
      onProgress: (event) => { events.push(JSON.stringify(event)); },
    });

    const output = events.join(' ');
    expect(output).not.toContain('secret-token-abc');
    expect(output).not.toContain('stdout');
    expect(output).not.toContain('stderr');
  });

  // AC-3: Timeout terminates process group and returns timed_out state
  it('AC-3: timeout terminates child process group and waits for cleanup', async () => {
    const root = await tempRoot();

    const pidFile = join(root, 'pid.txt');
    const events: CheckProgressEvent[] = [];
    const timeoutMs = 800;

    const result = await collectEvidence('timeout-wait-test', [
      {
        kind: 'test', name: 'sleeper',
        command: 'sh', args: ['-c', `trap '' TERM; echo $$ > ${pidFile}; sleep 30`],
        cwd: root, timeoutMs,
      },
    ], {
      onProgress: (event) => { events.push(event); },
    });

    expect(events.length).toBe(2);
    expect(events[0]).toMatchObject({ state: 'started' });
    expect(events[1]).toMatchObject({ state: 'timed_out', exitCode: 124, check: 'sleeper' });
    expect(result[0].exitCode).toBe(124);

    const pid = parseInt((await readFile(pidFile, 'utf8')).trim(), 10);
    const waitMs = 7_000;
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      try {
        process.kill(pid, 0);
        await new Promise((r) => setTimeout(r, 200));
      } catch {
        break;
      }
    }
    expect(() => process.kill(pid, 0)).toThrow();
  }, 20_000);

  // AC-3: AbortSignal cancels in-flight checks and waits for cleanup
  it('AC-3: AbortSignal cancels in-flight check and waits for process group cleanup', async () => {
    const root = await tempRoot();
    const controller = new AbortController();
    const pidFile = join(root, 'cancel-pid.txt');
    const events: CheckProgressEvent[] = [];

    const checks: CheckCommand[] = [
      {
        kind: 'test', name: 'slow',
        command: 'sh', args: ['-c', `trap '' TERM; echo $$ > ${pidFile}; sleep 30`],
        cwd: root, timeoutMs: 60_000,
      },
      { kind: 'test', name: 'fast', command: process.execPath, args: ['-e', 'process.exit(0)'], cwd: root },
    ];

    setTimeout(() => controller.abort(), 300);
    const result = await collectEvidence('cancel-wait-test', checks, {
      onProgress: (event) => { events.push(event); },
      signal: controller.signal,
    });

    expect(events.length).toBe(2);
    expect(events[0]).toMatchObject({ state: 'started', check: 'slow' });
    expect(events[1]).toMatchObject({ state: 'cancelled', check: 'slow' });
    expect(result.length).toBe(1);
    expect(result[0].log).toContain('CANCELLED');

    const pid = parseInt((await readFile(pidFile, 'utf8')).trim(), 10);
    const waitMs = 7_000;
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      try {
        process.kill(pid, 0);
        await new Promise((r) => setTimeout(r, 200));
      } catch {
        break;
      }
    }
    expect(() => process.kill(pid, 0)).toThrow();
  }, 20_000);
});
