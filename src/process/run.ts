import { spawn, spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { appendFile } from 'node:fs/promises';

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

/**
 * A bounded capture: the head, the tail, and a count of everything that went past.
 *
 * A check that prints a megabyte of progress must not make the *seal* hold a megabyte — and today the only cap is
 * downstream (`quality/evidence.ts` truncates the joined log to 20 000 characters, after the whole thing has already
 * been held). The default here is no bound, which is what every existing caller gets: four of them parse the complete
 * stream (`git … -z` splitting, CodeGraph's affected-test lines, the Comet compat probe, an operator-facing echo), so
 * bounding the *result* would silently change their answers.
 *
 * The length arithmetic is in UTF-16 units while the reported total is in bytes: the bound is a memory guard, not a
 * byte-exact contract, and the count is what a reader is told.
 */
class BoundedCapture {
    private head = '';
    private tail = '';
    private bytes = 0;
    private truncated = false;

    constructor(private readonly limit: number | undefined) {}

    push(chunk: string): void {
        this.bytes += Buffer.byteLength(chunk, 'utf8');
        if (this.limit === undefined) {
            this.head += chunk;
            return;
        }
        const headLimit = Math.ceil(this.limit / 2);
        let rest = chunk;
        if (this.head.length < headLimit) {
            const room = headLimit - this.head.length;
            this.head += chunk.slice(0, room);
            rest = chunk.slice(room);
            if (!rest) return;
        }
        this.truncated = true;
        const tailLimit = Math.max(this.limit - headLimit, 1);
        this.tail = `${this.tail}${rest}`.slice(-tailLimit);
    }

    /** What was kept. A dropped middle is named, never hidden. */
    value(): string {
        if (!this.truncated) return this.head;
        const omitted = Math.max(this.bytes - this.head.length - this.tail.length, 0);
        return `${this.head}\n[${omitted} bytes omitted]\n${this.tail}`;
    }

    totalBytes(): number {
        return this.bytes;
    }

    wasTruncated(): boolean {
        return this.truncated;
    }
}

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
    /** Bytes the child wrote to stdout and stderr, whether or not they were kept. */
    capturedBytes: number;
    /** True when `maxCaptureBytes` was reached and the middle of a stream was dropped. */
    captureTruncated: boolean;
    /**
     * Why a declared `captureArtifact` could not be written, when it could not be.
     *
     * Absent means the artifact was written — the distinction the caller needs, because the whole point of declaring an
     * artifact is handing that path to a reader. Swallowing this was how a truncated check came to name a transcript
     * that did not exist: the failure was an ENOENT from a missing parent directory, and the tee turned it into
     * nothing.
     */
    artifactFailure?: string;
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
    /**
     * Stream the child's output straight to the terminal instead of capturing it, for a child that genuinely needs the
     * user (an interactive prompt). It is still spawned in its own process group and still bounded by `timeoutMs`, so
     * an interactive child can be cancelled and cannot hang the invocation. `stdout`/`stderr` on the result are empty
     * in this mode: there is nothing captured to report.
     */
    inheritOutput?: boolean;
    /**
     * Keep at most roughly this many characters of each stream in the result, as head + tail.
     *
     * Absent (the default) keeps everything, which is what every caller that parses output needs. A caller that
     * *persists* output instead of parsing it sets this and gets an honest account of what it dropped.
     */
    maxCaptureBytes?: number;
    /**
     * Append every chunk to this file as it arrives, in addition to capturing it.
     *
     * The capture bound is a memory bound, not a diagnostic one: the complete output is still the record of last
     * resort, so when the bound is set the full text goes here and the caller keeps a path instead of a payload.
     * The file is created or appended to, and it is flushed before the promise settles. `inheritOutput` captures
     * nothing, so nothing is written when both are set.
     */
    captureArtifact?: string;
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
            stdio: options.inheritOutput ? 'inherit' : ['ignore', 'pipe', 'pipe'],
        });

        const stdout = new BoundedCapture(options.maxCaptureBytes);
        const stderr = new BoundedCapture(options.maxCaptureBytes);
        // Chunks are appended in arrival order; `finish` waits for the queue so a caller that reads the artifact
        // after awaiting `runProcess` sees the whole log rather than a prefix of it.
        let artifactQueue: Promise<void> = Promise.resolve();
        // The first failure is kept and the queue keeps draining, so a later chunk cannot overwrite the reason with a
        // different one and the child is never blocked by a channel that is only a diagnostic.
        let artifactFailure: string | undefined;
        const tee = (text: string): void => {
            if (!options.captureArtifact) return;
            artifactQueue = artifactQueue
                .then(() => appendFile(options.captureArtifact!, text, 'utf8'))
                .catch((error: unknown) => {
                    artifactFailure ??= error instanceof Error ? error.message : String(error);
                });
        };
        let settled = false;
        let failure: ProcessFailure | undefined;
        let killTimer: NodeJS.Timeout | undefined;

        const finish = (exitCode: number, signal: NodeJS.Signals | null): void => {
            if (settled) return;
            settled = true;
            if (killTimer) clearTimeout(killTimer);
            clearTimeout(timeoutTimer);
            options.signal?.removeEventListener('abort', onAbort);
            void artifactQueue.then(() => resolve({
                ok: exitCode === 0 && !failure,
                exitCode,
                signal,
                stdout: stdout.value(),
                stderr: stderr.value(),
                capturedBytes: stdout.totalBytes() + stderr.totalBytes(),
                captureTruncated: stdout.wasTruncated() || stderr.wasTruncated(),
                ...(failure ? { failure } : {}),
                ...(artifactFailure ? { artifactFailure } : {}),
                environment: environmentSummary(options.cwd),
            }));
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

        if (options.inheritOutput) {
            child.on('error', (error) => {
                failure = failure ?? 'spawn_failed';
                stderr.push(error.message);
                finish(127, null);
            });
            child.on('close', (code, signal) => {
                if (failure === 'timeout') finish(124, signal);
                else if (failure === 'aborted') finish(130, signal);
                else finish(code ?? 1, signal);
            });
            return;
        }

        child.stdout?.setEncoding('utf8');
        child.stderr?.setEncoding('utf8');
        child.stdout?.on('data', (chunk: string) => {
            stdout.push(chunk);
            tee(chunk);
            options.onOutput?.({ stream: 'stdout', text: chunk });
        });
        child.stderr?.on('data', (chunk: string) => {
            stderr.push(chunk);
            tee(chunk);
            options.onOutput?.({ stream: 'stderr', text: chunk });
        });

        child.on('error', (error) => {
            failure = failure ?? 'spawn_failed';
            stderr.push(error.message);
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
        capturedBytes: Buffer.byteLength(`${typeof result.stdout === 'string' ? result.stdout : ''}${stderr}`, 'utf8'),
        captureTruncated: false, // `spawnSync` has its own `maxBuffer`; it truncates nothing.
        environment: environmentSummary(options.cwd),
        ...(result.error ? { error: result.error as NodeJS.ErrnoException } : {}),
    };
}

/** A one-line description of where a child ran, for the evidence record. */
export function environmentSummary(cwd: string): string {
    return `cwd=${cwd} node=${process.version} platform=${process.platform}`;
}
