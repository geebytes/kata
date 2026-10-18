import {
    readTaskDependency,
    recordDependencyReturn,
    summarizeTaskDependency,
} from '../workflow/task-dependency.js';

/**
 * `kata-cli dependency …` — the operator's route into a task-to-task blocking edge.
 *
 * Two verbs, and the split is the point. `status` only reads: it prints the decision the governed entries ask, including
 * the reason and the road, so an operator can see *why* a seal would refuse before paying for a seal. `record` writes the
 * one fact a machine cannot observe — that a human authorized the corrective work into this tree — and it refuses unless
 * the corrective task is independently certified and its accepted content is actually present.
 *
 * A command family rather than a library call for the reason this repository keeps rediscovering: a mechanism with no entry
 * point is unreachable in practice, and the dependency gate is only fair if the road it prints exists.
 */

function flagValue(argv: readonly string[], name: string): string | undefined {
    for (let index = 0; index < argv.length; index += 1) {
        const token = argv[index] as string;
        if (token === name) return argv[index + 1]?.startsWith('--') ? undefined : argv[index + 1];
        if (token.startsWith(`${name}=`)) return token.slice(name.length + 1);
    }
    return undefined;
}

function required(argv: readonly string[], name: string, usage: string): string {
    const value = flagValue(argv, name);
    if (value === undefined || value === '') throw new Error(usage);
    return value;
}

export async function runDependencyCommand(argv: string[]): Promise<Record<string, unknown>> {
    const [subcommand, ...rest] = argv;
    const root = flagValue(rest, '--root') ?? process.cwd();

    if (subcommand === 'status') {
        const taskId = required(rest, '--change', 'Usage: kata-cli dependency status --change <id> [--root <path>]');
        // **One read of the fact, published and gated from it.** The spread used to be a second call, and the second call
        // was not awaited — the summary it produced arrived as `{}` while every gate below still worked, so `status` printed
        // a decision it had not read. The decision is taken once here and summarised from that value.
        const decision = await readTaskDependency(root, taskId);
        return {
            command: 'dependency status',
            ...summarizeTaskDependency(decision),
        };
    }

    if (subcommand === 'record') {
        const taskId = required(rest, '--change', 'Usage: kata-cli dependency record --change <id> --relation <relationId> [--note <why>]');
        const relationId = required(rest, '--relation', 'Usage: kata-cli dependency record --change <id> --relation <relationId> [--note <why>]');
        const note = flagValue(rest, '--note');
        const recordedBy = flagValue(rest, '--by');
        const result = await recordDependencyReturn({
            root,
            taskId,
            relationId,
            ...(note === undefined ? {} : { note }),
            ...(recordedBy === undefined ? {} : { recordedBy }),
        });
        return {
            command: 'dependency record',
            recorded: result.record,
            state: result.decision.state,
            message: result.decision.state === 'ready_to_revalidate'
                ? `Return recorded. Re-seal '${taskId}' and re-run its acceptance evidence on the integrated content: judge and archive stay refused until it does.`
                : `Return recorded; '${taskId}' is still '${result.decision.state}' because the corrective work or the tree moved.`,
        };
    }

    throw new Error('Usage: kata-cli dependency <status|record> --change <id> [--relation <relationId>] [--root <path>]');
}
