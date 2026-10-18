import { readClassMetrics, readChangeMetrics } from '../workflow/metrics.js';
import { flagPresent } from './invocation.js';

/**
 * `kata-cli metrics …` — what a change cost, in the terms the design's own economics use.
 *
 * The route-A inequality (`Σ(A_i − R_i) > C + I + M`) had no reader: every term is a count this repository already records
 * — rounds, revisions, repair entries, dependency edges, class declarations — and nothing published them, so the question
 * could only be argued. This command publishes them.
 *
 * **It does not measure work.** The durations are calendar time between recorded events, and the fields kata cannot observe
 * (author attention, model tokens, check execution) are listed as `unmeasured` rather than left as an implicit zero. A
 * report that presented elapsed calendar time as effort would be the substitution this repository keeps finding one layer
 * down — a fact about the record reported as a fact about the work.
 */

function flagValue(argv: readonly string[], name: string): string | undefined {
    for (let index = 0; index < argv.length; index += 1) {
        const token = argv[index] as string;
        if (token === name) return argv[index + 1]?.startsWith('--') ? undefined : argv[index + 1];
        if (token.startsWith(`${name}=`)) return token.slice(name.length + 1);
    }
    return undefined;
}

export async function runMetricsCommand(argv: string[]): Promise<Record<string, unknown>> {
    const root = flagValue(argv, '--root') ?? process.cwd();
    const change = flagValue(argv, '--change');

    // The switch goes through the shared reader: `argv.includes` is the shape the CLI vocabulary guard forbids, because
    // `--all=1` and `--all` are the same switch and two spellings of "is it present" is how the value readers diverged.
    if (flagPresent(argv, '--all') || change === undefined) {
        const view = await readClassMetrics(root);
        return {
            command: 'metrics',
            scope: 'repository',
            ...view,
            // The counts the design's inequality reads first, published as their own fields so a reader does not have to
            // fold the array to answer "is any class reaching more than one change".
            openClasses: view.classes.filter((entry) => !entry.discharged).length,
            dischargedClasses: view.classes.filter((entry) => entry.discharged).length,
            classesReachingMoreThanOneChange: view.classes.filter((entry) => entry.dependentTasks.length > 1).length,
        };
    }

    return { command: 'metrics', scope: 'change', ...(await readChangeMetrics(root, change)) };
}
