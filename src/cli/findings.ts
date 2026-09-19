import { readTrackedFindings } from '../quality/finding-disposition.js';
import { resolveWorkspaceRoot } from '../core/layout.js';
import { parseChangeArg } from './invocation.js';

/**
 * `kata-cli findings …` — what has been decided about each finding, and what is still open.
 *
 * The command surface for the finding-lifecycle design (G1): `defer` and `accept` record a decision, `list` shows every
 * finding with the decision attached, and `carry` is the signed act of closing a task that still has known problems.
 * `blocking` and `major` are refused by `defer`/`accept` (invariant I1) with a message pointing at the repair.
 */
export async function runFindingsCommand(argv: string[]): Promise<Record<string, unknown>> {
    const [subcommand, ...rest] = argv;
    if (!subcommand || subcommand === '--help' || subcommand === '-h') {
        return {
            command: 'findings help',
            commands: [
                'list --change <task-id> [--disposition open|deferred|accepted|fixed]',
                'defer --change <task-id> --id <finding-id> --reason "<why not now>" [--by <actor>]',
                'accept --change <task-id> --id <finding-id> --reason "<why this is not a defect>" [--by <actor>]',
                'carry --change <task-id> --to <task-or-ticket> [--reason "<note>"]',
            ],
            note: 'blocking and major findings cannot be deferred or accepted: they must be repaired.',
        };
    }

    const taskId = parseChangeArg(rest);
    if (!taskId) throw new Error(`Usage: kata-cli findings ${subcommand} --change <task-id>`);
    const root = resolveWorkspaceRoot();

    if (subcommand === 'list') {
        const findings = await readTrackedFindings(root, taskId);
        const filter = valueAfter(rest, '--disposition');
        const shown = filter ? findings.filter((finding) => finding.disposition === filter) : findings;

        // §21.4: convergence as a query. Assembling the by-layer table took reading ~10 round records by hand, and the
        // answer — the product stopped producing findings and every round after was about the tooling — was visible only
        // in hindsight. Layer × severity, computed, so a loop of that kind is visible while it is happening.
        const { findingLayer } = await import('../quality/code-surface.js');
        const { readTask } = await import('../core/task.js');
        const task = await readTask(root, taskId).catch(() => null);
        const byLayer: Record<string, { total: number; open: number; bySeverity: Record<string, number> }> = {};
        for (const finding of shown) {
            const layer = findingLayer(task ?? {}, finding.path);
            const entry = (byLayer[layer] ??= { total: 0, open: 0, bySeverity: {} });
            entry.total += 1;
            if (finding.disposition === 'open') entry.open += 1;
            entry.bySeverity[finding.severity] = (entry.bySeverity[finding.severity] ?? 0) + 1;
        }

        return {
            command: 'findings list',
            taskId,
            count: shown.length,
            open: shown.filter((finding) => finding.disposition === 'open').length,
            deferred: shown.filter((finding) => finding.disposition === 'deferred').length,
            accepted: shown.filter((finding) => finding.disposition === 'accepted').length,
            byLayer,
            ...(task?.instruments?.length ? { instruments: task.instruments } : {}),
            findings: shown.map((finding) => ({ ...finding, layer: findingLayer(task ?? {}, finding.path) })),
        };
    }

    if (subcommand === 'carry') {
        // "Closing with known problems" is a signed act (design §F1.4): it names where the finding goes, so the same
        // finding cannot simply stop being mentioned.
        const to = valueAfter(rest, '--to');
        if (!to) throw new Error('Usage: kata-cli findings carry --change <task-id> --to <task-or-ticket> [--reason "<note>"]');
        const findings = await readTrackedFindings(root, taskId);
        const carried = findings.filter((finding) => finding.disposition === 'deferred' || finding.disposition === 'accepted');
        const blockingOpen = findings.filter((finding) => finding.disposition === 'open' && (finding.severity === 'blocking' || finding.severity === 'major'));
        return {
            command: 'findings carry',
            taskId,
            to,
            ...(valueAfter(rest, '--reason') ? { reason: valueAfter(rest, '--reason') } : {}),
            carried: carried.map((finding) => ({ id: finding.id, severity: finding.severity, disposition: finding.disposition, message: finding.message })),
            carriedCount: carried.length,
            // Reported, never silently allowed: an open blocking/major finding is a gate failure, not a carry-over.
            ...(blockingOpen.length > 0 ? { refusedForOpenBlocking: blockingOpen.map((finding) => finding.id) } : {}),
        };
    }

    const disposition = subcommand === 'defer' ? 'deferred' : subcommand === 'accept' ? 'accepted' : null;
    if (!disposition) throw new Error(`Unknown findings subcommand: ${subcommand}. Usage: kata-cli findings <list|defer|accept|carry>`);

    const id = valueAfter(rest, '--id');
    const reason = valueAfter(rest, '--reason');
    if (!id) throw new Error(`Usage: kata-cli findings ${subcommand} --change <task-id> --id <finding-id> --reason "<why>"`);

    const { dispositionDenial, applyDisposition } = await import('../quality/finding-disposition.js');
    const findings = await readTrackedFindings(root, taskId);
    const finding = findings.find((entry) => entry.id === id);
    if (!finding) throw new Error(`Finding '${id}' was not found in the review record or an adversarial pass of task '${taskId}'.`);

    // §21.2: is this finding outside a dimension the instrument's declaration excludes? Computed here, where the task's
    // declarations are in hand, and passed in as evidence rather than as a permission.
    const { readTask } = await import('../core/task.js');
    const { classifyFindingCoverage } = await import('../quality/instrument-boundary.js');
    const task = await readTask(root, taskId).catch(() => null);
    const coverage = task
        ? classifyFindingCoverage(task, task.boundaries ? { boundaries: task.boundaries } : null, finding)
        : null;

    const denial = dispositionDenial(finding, disposition, reason, coverage);
    if (denial) throw new Error(denial);

    // A boundary closure is reported with the dimension and the canonical statement, so it is auditable rather than a
    // finding that quietly acquired a reason.
    const closure = coverage?.classification === 'beyond-declared-coverage'
        ? { closedByBoundary: coverage.dimension, canonicalStatement: coverage.canonicalStatement ?? null }
        : {};

    const by = valueAfter(rest, '--by') ?? 'user';
    const at = new Date().toISOString();
    const written = await applyDisposition(root, taskId, finding.source, id, { disposition, reason, by, at });
    if (!written) throw new Error(`Finding '${id}' could not be written back to ${finding.source}.`);

    return { command: `findings ${subcommand}`, taskId, id, disposition, reason, by, at, ...closure };
}

function valueAfter(argv: string[], flag: string): string | undefined {
    const index = argv.indexOf(flag);
    if (index === -1) return undefined;
    const value = argv[index + 1];
    return value && !value.startsWith('--') ? value : undefined;
}
