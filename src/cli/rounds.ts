/**
 * `kata-cli rounds` — how many review rounds a change has had, and how many of the latest round's findings are about what the
 * previous round changed.
 *
 * The CLI entry exists so the report is reachable from the tool rather than only from a test: a mechanism with no consumer is
 * the class this whole line has been finding, and a report nobody can run is the same defect with a friendlier shape.
 */
import { reportRounds } from '../quality/repair-rounds.js';

function valueAfter(argv: string[], flag: string): string | undefined {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
}

export async function runRoundsCommand(argv: string[]): Promise<Record<string, unknown>> {
    const change = valueAfter(argv, '--change');
    if (!change) {
        return { command: 'rounds', success: false, error: 'rounds needs --change <task-id> [--node <node>].' };
    }
    const node = valueAfter(argv, '--node') ?? 'review';
    const report = await reportRounds(process.cwd(), change, node);
    return { command: 'rounds', taskId: change, success: true, ...report };
}
