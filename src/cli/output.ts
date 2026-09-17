/**
 * Where an invocation writes, and in what shape.
 *
 * A leaf module so that command handlers — which are being extracted from `cli.ts` a family at a time — can write
 * through the same context without importing the entry point that routes to them.
 */

/**
 * Where an invocation writes, and in what shape.
 *
 * Output behaviour used to be two mutable module booleans plus direct `process.stdout` writes, so rendering mixed
 * JSON result serialization with update-specific human text and an in-process invocation could not supply its own
 * streams. The context is supplied at the boundary now: `main` derives it from argv, and a caller may pass its own
 * streams (a test, or a future transport that is not a process).
 *
 * It is held for the duration of one invocation rather than threaded as a parameter through every handler: that
 * threading belongs with the handler-family extraction (L0-01), and a half-threaded context would be worse than an
 * explicit one with a stated lifetime. `main` restores whatever was active before it, so nested calls do not leak.
 */
export interface OutputContext {
    stdout: { write(text: string): void };
    stderr: { write(text: string): void };
    /** `json` renders results as one JSON document; `human` renders the update summary and progress text. */
    format: 'json' | 'human';
    quiet: boolean;
    isTTY: boolean;
}

export interface OutputOverrides {
    stdout?: { write(text: string): void };
    stderr?: { write(text: string): void };
    isTTY?: boolean;
}

export function createOutputContext(argv: string[], overrides: OutputOverrides = {}): OutputContext {
    return {
        stdout: overrides.stdout ?? process.stdout,
        stderr: overrides.stderr ?? process.stderr,
        format: isJsonOutput(argv) ? 'json' : 'human',
        quiet: isQuietOutput(argv) || isDefaultSilentInstallerCommand(argv),
        isTTY: overrides.isTTY ?? Boolean(process.stdout.isTTY),
    };
}

let activeOutput: OutputContext = createOutputContext([]);

/** The context the current invocation writes through. */
export function currentOutput(): OutputContext {
    return activeOutput;
}

/** Replaces the active context. Only an invocation boundary (or a test) does this. */
export function setOutput(context: OutputContext): void {
    activeOutput = context;
}

/**
 * Renders a command result through the active context.
 *
 * The human shape is supplied by the caller that knows it (`{ human: renderUpdateSummary }`), rather than sniffing the
 * result object here: a printer that recognises one command's fields is a boundary that has to change whenever that
 * command's result does.
 */
export interface RenderOptions {
    human?: (result: Record<string, unknown>) => string;
}

export function outputResult(result: Record<string, unknown>, options: RenderOptions = {}): void {
    const output = activeOutput;
    if (output.quiet) return;
    if (output.format === 'human' && options.human) {
        output.stdout.write(options.human(result));
        return;
    }
    output.stdout.write(JSON.stringify(result) + '\n');
}

/** Progress text for a command that narrates while it works; quiet and JSON runs stay silent. */
export function writeProgress(message: string): void {
    const output = activeOutput;
    if (!output.quiet && output.format === 'human') output.stdout.write(message);
}

export function isQuietOutput(argv: string[]): boolean {
    return process.env.STRATA_QUIET === '1' || process.env.STRATA_QUIET === 'true' || argv.includes('--quiet');
}

export function isJsonOutput(argv: string[]): boolean {
    return argv.includes('--json') || process.env.STRATA_JSON === '1' || process.env.STRATA_JSON === 'true';
}

export function isDefaultSilentInstallerCommand(argv: string[]): boolean {
    const command = argv[0];
    return (command === 'init' || command === 'uninstall') && !isJsonOutput(argv);
}

