import {
    readCompletion,
    recordIntegration,
    recordStop,
    recordWaiver,
    summarizeCompletion,
} from '../workflow/completion.js';

/**
 * `kata-cli completion …` — how a task ended, and the four ways it can.
 *
 * The family exists because "approved" and "delivered" were the same word in every surface an operator reads: a task with
 * a Judge PASS printed as finished while its content sat on a branch nobody merged. `status` prints the state; this command
 * is where the *evidence* of delivery is written, and it refuses to write an integration the repository cannot confirm
 * (the commit must be in the target, and the check named is run rather than believed).
 *
 * `stop` and `waive` are here for the same reason: closing a task without delivering it stays possible — the design does
 * not pretend otherwise — but it is a recorded decision with a reason, not the absence of one.
 */

function flagValue(argv: readonly string[], name: string): string | undefined {
    for (let index = 0; index < argv.length; index += 1) {
        const token = argv[index] as string;
        if (token === name) return argv[index + 1]?.startsWith('--') ? undefined : argv[index + 1];
        if (token.startsWith(`${name}=`)) return token.slice(name.length + 1);
    }
    return undefined;
}

function repeated(argv: readonly string[], name: string): string[] {
    const values: string[] = [];
    for (let index = 0; index < argv.length; index += 1) {
        const token = argv[index] as string;
        if (token === name && argv[index + 1] !== undefined && !argv[index + 1]!.startsWith('--')) values.push(argv[index + 1]!);
        else if (token.startsWith(`${name}=`)) values.push(token.slice(name.length + 1));
    }
    return values;
}

function required(argv: readonly string[], name: string, usage: string): string {
    const value = flagValue(argv, name);
    if (value === undefined || value === '') throw new Error(usage);
    return value;
}

export async function runCompletionCommand(argv: string[]): Promise<Record<string, unknown>> {
    const [subcommand, ...rest] = argv;
    const root = flagValue(rest, '--root') ?? process.cwd();
    const usage = 'Usage: kata-cli completion <status|integrate|stop|waive> --change <id> [--root <path>]';

    if (subcommand === 'status') {
        const taskId = required(rest, '--change', `${usage}`);
        const decision = await readCompletion(root, taskId);
        return { command: 'completion status', taskId, ...summarizeCompletion(decision) };
    }

    if (subcommand === 'integrate') {
        const taskId = required(rest, '--change', 'Usage: kata-cli completion integrate --change <id> --target <ref> --commit <sha> --check <command> [--check-arg <a>]... [--note <why>]');
        const target = required(rest, '--target', 'Usage: kata-cli completion integrate --change <id> --target <ref> --commit <sha> --check <command> [--check-arg <a>]...');
        const commit = required(rest, '--commit', 'Usage: kata-cli completion integrate --change <id> --target <ref> --commit <sha> --check <command> [--check-arg <a>]...');
        const check = required(rest, '--check', 'Usage: kata-cli completion integrate --change <id> --target <ref> --commit <sha> --check <command> [--check-arg <a>]...');
        const note = flagValue(rest, '--note');
        const recordedBy = flagValue(rest, '--by');
        const result = await recordIntegration({
            root,
            taskId,
            target,
            commit,
            check: { command: check, args: repeated(rest, '--check-arg') },
            ...(note === undefined ? {} : { note }),
            ...(recordedBy === undefined ? {} : { recordedBy }),
        });
        return {
            command: 'completion integrate',
            taskId,
            recorded: result.record,
            state: result.decision.state,
            message: result.decision.state === 'delivered_and_archived'
                ? `Integration recorded and the task is archived: '${taskId}' is delivered.`
                : `Integration recorded. '${taskId}' is '${result.decision.state}': ${result.decision.detail}${result.decision.road ? ` Next: ${result.decision.road}` : ''}`,
        };
    }

    if (subcommand === 'stop') {
        const taskId = required(rest, '--change', `${usage}`);
        const reason = required(rest, '--reason', 'Usage: kata-cli completion stop --change <id> --reason <why>');
        const decision = await recordStop({ root, taskId, reason, ...(flagValue(rest, '--by') === undefined ? {} : { recordedBy: flagValue(rest, '--by') }) });
        return { command: 'completion stop', taskId, state: decision.state, detail: decision.detail };
    }

    if (subcommand === 'waive') {
        const taskId = required(rest, '--change', `${usage}`);
        const reason = required(rest, '--reason', 'Usage: kata-cli completion waive --change <id> --reason <why> --impact <what the gap costs>');
        const impact = required(rest, '--impact', 'Usage: kata-cli completion waive --change <id> --reason <why> --impact <what the gap costs>');
        const decision = await recordWaiver({ root, taskId, reason, impact, ...(flagValue(rest, '--by') === undefined ? {} : { recordedBy: flagValue(rest, '--by') }) });
        return { command: 'completion waive', taskId, state: decision.state, detail: decision.detail };
    }

    throw new Error(usage);
}
