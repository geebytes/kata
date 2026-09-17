import { spawn, spawnSync, type SpawnSyncReturns } from 'node:child_process';

/**
 * The one place kata spawns a child process.
 *
 * Eleven modules used to spawn directly, each with its own conventions: a carefully bounded async runner in the
 * evidence collector (process-group kill, timeout mapped to exit code 124, captured output, abort signal) next to
 * one-line `execFileSync` calls with no timeout, no captured stderr and inconsistent environments. Behaviour that
 * should be invariant — a timeout, a captured log, an explicit environment, a non-blocking wait — was reinvented per
 * call site, and the differences only surfaced when a particular environment exposed one.
 *
 * Two shapes, deliberately:
 *   `runProcess`     — the default. Async, bounded, kills the process group on timeout or abort, captures everything.
 *   `runProcessSync` — for the few callers that genuinely cannot await (a synchronous CLI path, a generated hook).
 *                      It reports instead of throwing, so the caller decides what a failure means.
 *
 * The child is always spawned in its own process group so that killing it also stops what it started: a test runner
 * that leaks a worker would otherwise keep the seal hanging on a pipe that never closes.
 */

export type ProcessFailure = 'timeout' | 'aborted' | 'spawn_failed';

export interface ProcessResult {
    /** `true` when the child exited 0. */
    ok: boolean;
    /** Exit code, or 124 for a timeout (the conventional value) and 130 for an abort. */
    exitCode: number;
    signal: NodeJS.Signals | null;
    stdout: string;
    stderr: string;
    /** Set when the process did not simply exit: why it was killed or why it could not start. */
    failure?: ProcessFailure;
    /** A short summary of the environment the child ran in, for the evidence record. */
    environment: string;
}

export interface RunProcessOptions {
    cwd: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
    signal?: AbortSignal;
    /** Called with each chunk of captured output, for progress reporting. */
    onOutput?: (chunk: { stream: 'stdout' | 'stderr'; text: string }) => void;
    /** Extra grace between SIGTERM and SIGKILL while a killed child cleans up. */
    killGraceMs?: number;
}

const defaultKillGraceMs = 5_000;

/** Bounded, captured, cancellable. Never throws for a child that fails; only for an environment that cannot spawn. */
export async function runProcess(command: string, args: string[], options: RunProcessOptions): Promise<ProcessResult> {
    const timeoutMs = options.timeoutMs ?? 600_000;

    return new Promise<ProcessResult>((resolve) => {
        const child = spawn(command, args, {
            cwd: options.cwd,
            env: options.env ?? process.env,
            detached: true,
            stdio: ['ignore', 'pipe', 'pipe'],
        });

        let stdout = '';
        let stderr = '';
        let settled = false;
        let failure: ProcessFailure | undefined;
        let killTimer: NodeJS.Timeout | undefined;

        const finish = (exitCode: number, signal: NodeJS.Signals | null): void => {
            if (settled) return;
            settled = true;
            if (killTimer) clearTimeout(killTimer);
            clearTimeout(timeoutTimer);
            options.signal?.removeEventListener('abort', onAbort);
            resolve({
                ok: exitCode === 0 && !failure,
                exitCode,
                signal,
                stdout,
                stderr,
                ...(failure ? { failure } : {}),
                environment: environmentSummary(options.cwd),
            });
        };

        const kill = (reason: ProcessFailure): void => {
            if (settled) return;
            failure = failure ?? reason;
            if (!child.pid) return;
            try {
                // The whole group: a runner that spawned workers must not outlive the seal that started it.
                process.kill(-child.pid, 'SIGTERM');
            } catch { /* already gone */ }
            killTimer = setTimeout(() => {
                try {
                    process.kill(-child.pid!, 'SIGKILL');
                } catch { /* already gone */ }
            }, options.killGraceMs ?? defaultKillGraceMs);
            killTimer.unref?.();
        };

        const timeoutTimer = setTimeout(() => kill('timeout'), timeoutMs);
        timeoutTimer.unref?.();

        const onAbort = (): void => kill('aborted');
        if (options.signal) {
            if (options.signal.aborted) kill('aborted');
            else options.signal.addEventListener('abort', onAbort, { once: true });
        }

        child.stdout?.setEncoding('utf8');
        child.stderr?.setEncoding('utf8');
        child.stdout?.on('data', (chunk: string) => {
            stdout += chunk;
            options.onOutput?.({ stream: 'stdout', text: chunk });
        });
        child.stderr?.on('data', (chunk: string) => {
            stderr += chunk;
            options.onOutput?.({ stream: 'stderr', text: chunk });
        });

        child.on('error', (error) => {
            failure = failure ?? 'spawn_failed';
            stderr += error.message;
            finish(127, null);
        });

        child.on('close', (code, signal) => {
            if (failure === 'timeout') finish(124, signal);
            else if (failure === 'aborted') finish(130, signal);
            else finish(code ?? 1, signal);
        });
    });
}

export interface SyncProcessOptions {
    cwd: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
    /** Capture stderr separately; when false it is discarded. */
    captureStderr?: boolean;
}

/**
 * The synchronous shape, for callers that cannot await. It reports rather than throws: `ok: false` with whatever the
 * child managed to write, which is what a caller needs to decide between "not installed" and "failed".
 */
export function runProcessSync(command: string, args: string[], options: SyncProcessOptions): ProcessResult & { error?: NodeJS.ErrnoException } {
    const result: SpawnSyncReturns<string> = spawnSync(command, args, {
        cwd: options.cwd,
        env: options.env ?? process.env,
        timeout: options.timeoutMs ?? 60_000,
        maxBuffer: 10 * 1024 * 1024,
        ...(options.captureStderr === false ? { stdio: ['ignore', 'pipe', 'ignore'] as const } : {}),
        encoding: 'utf8',
    });

    const timedOut = result.error && (result.error as NodeJS.ErrnoException).code === 'ETIMEDOUT';
    const exitCode = timedOut ? 124 : result.status ?? (result.error ? 127 : 1);
    const stderr = typeof result.stderr === 'string' ? result.stderr : '';

    return {
        ok: exitCode === 0,
        exitCode,
        signal: result.signal ?? null,
        stdout: typeof result.stdout === 'string' ? result.stdout : '',
        stderr: stderr || (result.error?.message ?? ''),
        ...(timedOut ? { failure: 'timeout' as const } : {}),
        environment: environmentSummary(options.cwd),
        ...(result.error ? { error: result.error as NodeJS.ErrnoException } : {}),
    };
}

/** A one-line description of where a child ran, for the evidence record. */
export function environmentSummary(cwd: string): string {
    return `cwd=${cwd} node=${process.version} platform=${process.platform}`;
}
