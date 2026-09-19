import { resolveWorkspaceRoot } from '../core/layout.js';
import { parseChangeArg } from './invocation.js';
import { readTask } from '../core/task.js';

/**
 * `kata-cli scope …` — the audited surface as a decision rather than a drift (§21.1–§21.3).
 *
 * The measurement: one task's surface grew **silently** — a script, a carrier, a mirror, tests for all three — and each
 * addition both expanded what the gate considered in scope and invalidated the evidence, restarting the search, with no
 * point at which the cost was visible. These commands are that point.
 */
export async function runScopeCommand(argv: string[]): Promise<Record<string, unknown>> {
    const [subcommand, ...rest] = argv;
    const root = resolveWorkspaceRoot();
    if (!subcommand || subcommand === '--help' || subcommand === '-h') {
        return {
            command: 'scope help',
            usage: [
                'kata-cli scope show --change <task-id>                                  # the audited surface, its layers, its instruments',
                'kata-cli scope change --change <task-id> --add <path> [--remove <path>] --reason "<why>"',
                'kata-cli scope declare --change <task-id> --instrument <path>           # declare verification tooling this task wrote',
                'kata-cli scope boundary --change <task-id> --instrument <path> --covers "<dim>" --excludes "<dim>: <why>" --statement <doc>',
            ],
        };
    }

    const change = parseChangeArg(rest);
    if (!change) throw new Error('Usage: kata-cli scope <show|change|declare|boundary> --change <task-id>');

    if (subcommand === 'show') {
        const { readScopeChanges, unreportedScopeGrowth } = await import('../quality/scope-change.js');
        const { findingLayer, instrumentPaths } = await import('../quality/code-surface.js');
        const { validateBoundaries } = await import('../quality/instrument-boundary.js');
        const task = await readTask(root, change);
        const record = await readScopeChanges(root, change);
        const undecided = record.changes.length > 0 ? await unreportedScopeGrowth(root, change, task.ownedPaths ?? []) : [];
        return {
            command: 'scope show',
            taskId: change,
            ownedPaths: (task.ownedPaths ?? []).map((path) => ({ path, layer: findingLayer(task, path) })),
            // Declared instruments are listed with their layer too: an instrument may or may not also be an owned path, and
            // the point of the class is that it is a declaration rather than an inference from the owned set.
            instruments: instrumentPaths(task).map((path) => ({ path, layer: 'instrument', owned: (task.ownedPaths ?? []).includes(path) })),
            boundaries: task.boundaries ?? [],
            // A boundary declaration that does not hold is reported here rather than discovered when a finding is closed.
            ...(task.boundaries?.length ? { boundaryRefusals: validateBoundaries(root, task, { boundaries: task.boundaries }) } : {}),
            changes: record.changes,
            // The thing the measured task did four times without saying so.
            ...(undecided.length > 0 ? { unreportedGrowth: undecided } : {}),
        };
    }

    if (subcommand === 'change') {
        const { recordScopeChange } = await import('../quality/scope-change.js');
        const task = await readTask(root, change);
        const reason = valueAfter(rest, '--reason');
        const additions = valuesAfter(rest, '--add');
        const removals = valuesAfter(rest, '--remove');
        if (additions.length === 0 && removals.length === 0) {
            throw new Error('Usage: kata-cli scope change --change <task-id> --add <path> [--remove <path>] [--add ...] --reason "<why>"');
        }
        const current = task.ownedPaths ?? [];
        const next = [...current.filter((path) => !removals.includes(path)), ...additions];
        const result = await recordScopeChange(root, change, {
            next,
            current,
            reason: reason ?? '',
            by: valueAfter(rest, '--by') ?? 'user',
            ...(rest.includes('--allow-ownership-conflicts') ? { allowConflicts: true } : {}),
        });
        if ('refused' in result) throw new Error(result.refused);
        return {
            command: 'scope change',
            taskId: change,
            id: result.id,
            added: result.added,
            removed: result.removed,
            baseRevisionId: result.baseRevisionId ?? null,
            ...(result.conflicts?.length ? { conflicts: result.conflicts } : {}),
            next: 'Run `kata-cli scope apply` or re-seal; the change resets what the next round narrows against.',
        };
    }

    if (subcommand === 'declare') {
        const instrument = valueAfter(rest, '--instrument');
        if (!instrument) throw new Error('Usage: kata-cli scope declare --change <task-id> --instrument <path>');
        const { mutateTaskArtefact } = await import('../core/state.js');
        const { taskPath } = await import('../core/layout.js');
        let instruments: string[] = [];
        await mutateTaskArtefact(root, change, taskPath(root, change), async (raw) => {
            const task = JSON.parse(raw) as { instruments?: string[] };
            instruments = [...new Set([...(task.instruments ?? []), instrument])].sort();
            task.instruments = instruments;
            return `${JSON.stringify(task, null, 2)}\n`;
        });
        return { command: 'scope declare', taskId: change, instruments };
    }

    if (subcommand === 'boundary') {
        const instrument = valueAfter(rest, '--instrument');
        const statement = valueAfter(rest, '--statement');
        const covers = valuesAfter(rest, '--covers');
        const excludes = valuesAfter(rest, '--excludes');
        if (!instrument || !statement) {
            throw new Error('Usage: kata-cli scope boundary --change <task-id> --instrument <path> --statement <doc> --covers "<dim>" --excludes "<dim>: <why>"');
        }
        const doesNotCover = excludes.map((entry) => {
            const [dimension, ...why] = entry.split(':');
            return { dimension: (dimension ?? '').trim(), reason: why.join(':').trim() || 'not stated' };
        });
        const { mutateTaskArtefact } = await import('../core/state.js');
        const { taskPath } = await import('../core/layout.js');
        const { validateBoundaries } = await import('../quality/instrument-boundary.js');
        let refusal: string | null = null;
        let boundaries: Array<{ instrument: string; covers: string[]; doesNotCover: Array<{ dimension: string; reason: string }>; canonicalStatement: string }> = [];
        await mutateTaskArtefact(root, change, taskPath(root, change), async (raw) => {
            const task = JSON.parse(raw) as { instruments?: string[]; boundaries?: typeof boundaries };
            const next = { instrument, covers, doesNotCover, canonicalStatement: statement };
            task.boundaries = [...(task.boundaries ?? []).filter((entry) => entry.instrument !== instrument), next];
            boundaries = task.boundaries;
            // Validated before it is written: a boundary for an undeclared instrument, or one whose single canonical
            // statement does not exist, is refused here rather than when a finding is closed against it.
            const refusals = validateBoundaries(root, task, { boundaries: task.boundaries });
            refusal = refusals.length > 0 ? refusals.map((entry) => entry.detail).join('; ') : null;
            if (refusal) task.boundaries = task.boundaries.filter((entry) => entry.instrument !== instrument);
            return `${JSON.stringify(task, null, 2)}\n`;
        });
        if (refusal) throw new Error(refusal);
        return { command: 'scope boundary', taskId: change, instrument, boundaries };
    }

    throw new Error(`Unknown scope subcommand: ${subcommand}. Usage: kata-cli scope <show|change|declare|boundary>`);
}

function valueAfter(argv: string[], flag: string): string | undefined {
    const index = argv.indexOf(flag);
    if (index === -1) return undefined;
    const value = argv[index + 1];
    return value && !value.startsWith('--') ? value : undefined;
}

function valuesAfter(argv: string[], flag: string): string[] {
    const values: string[] = [];
    for (let index = 0; index < argv.length; index += 1) {
        if (argv[index] === flag) {
            const value = argv[index + 1];
            if (value && !value.startsWith('--')) values.push(value);
        }
    }
    return values;
}
