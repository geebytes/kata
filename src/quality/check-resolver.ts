import { join } from 'node:path';
import type { AcceptanceMatrix, AcceptanceMatrixRow, MatrixEvidenceItem } from '../core/task.js';
import type { CheckCommand, EvidenceKind } from './evidence.js';

/**
 * Turning acceptance-matrix declarations into checks that can be executed.
 *
 * This knowledge used to live in the workflow orchestrator: which test runners kata knows, where their entry files sit
 * inside a project, how a selector is expressed, and how the `kata/` prefix is stripped for a nested project. That put
 * row-to-check resolution in a different layer from the row model it interprets, so adding a runner or changing a
 * package layout meant editing the orchestration module.
 *
 * The runners are data now (`matrixRunners`). Two of the entries record behaviour that a shell would read differently —
 * `pytest` is launched by passing the bare name to the Node binary, and `uv run pytest` keeps its command line whole
 * while the resolved command is `uv` — and they are recorded rather than quietly corrected: this module moves knowledge
 * and must not change what runs.
 */

export interface MatrixRunnerSpec {
    /**
     * Entry file, relative to the project directory, that kata launches through the Node binary. The `{{selector}}`
     * template path and the plain path use this.
     */
    nodeEntry?: string;
    /**
     * A command name kata passes to the Node binary as the first argument, for the selector path only. Preserved from
     * the previous implementation, where `pytest` resolved to `node pytest …`.
     */
    nodeCommandOnSelectorPath?: string;
    /** True when the runner is passed as written and the selector is appended to its own arguments. */
    wholeCommandLine?: boolean;
    /** True when a declaration naming this runner may carry a selector. */
    selectorCapable: boolean;
}

/** The runners a matrix declaration may name. Each entry is one place to change when a package layout moves. */
export const matrixRunners: Record<string, MatrixRunnerSpec> = {
    vitest: { nodeEntry: join('node_modules', 'vitest', 'vitest.mjs'), selectorCapable: true },
    tsc: { nodeEntry: join('node_modules', 'typescript', 'bin', 'tsc'), selectorCapable: false },
    pytest: { nodeCommandOnSelectorPath: 'pytest', selectorCapable: true },
    uv: { wholeCommandLine: true, selectorCapable: true },
};

/** The command lines recognised as selector-capable runners, matched by prefix as well as exactly. */
export const selectorRunnerCommandLines = ['vitest', 'pytest', 'uv run pytest'];

/** The directory a row's tests run in: a `kata/`-prefixed row belongs to the nested kata project. */
export function matrixProjectDir(row: AcceptanceMatrixRow, root: string): string {
    return row.testPaths.every((path) => path.startsWith('kata/')) ? join(root, 'kata') : root;
}

/** A selector written against the workspace is rewritten for the project directory it will run in. */
export function testSelectorForRuntime(selector: string, runtimeProjectDir: string, root: string): string {
    return runtimeProjectDir !== root && selector.startsWith('kata/') ? selector.slice('kata/'.length) : selector;
}

/** A selector's own arguments, appended after the runner's. */
export function selectorArgs(selector: string): string[] {
    return selector.split(/\s+/);
}

function timeoutForKind(kind: EvidenceKind): number {
    return kind === 'test' || kind === 'integration' || kind === 'entrypoint' ? 120_000 : 60_000;
}

/**
 * A check name that the evidence schema accepts.
 *
 * The name is derived from the command text, which contains spaces and slashes, while
 * `evidence.schema.json` constrains `name` to `^[A-Za-z0-9_.-]+$`. Sanitizing here — rather than
 * only in the artefact filename — keeps the recorded name and the file that holds it in agreement,
 * and keeps a matrix-supplied command from producing an artefact its own schema rejects.
 */
export function sanitizeCheckName(value: string): string {
    return value.replace(/[^A-Za-z0-9_.-]+/g, '-').replace(/^-|-$/g, '');
}

/**
 * The declaration's pointer to a covering check, when it names one.
 *
 * A covered row keeps its own id and name (so the evidence artefact, the report and any old reference still line up) but
 * is not executed: `collectEvidence` skips it, and `evidenceMatchesRow` credits it with the covering check's envelope.
 */
function coveredByOf(evidence: MatrixEvidenceItem): { coveredBy?: string } {
    return evidence.coveredBy ? { coveredBy: evidence.coveredBy } : {};
}

function checkIdentity(row: AcceptanceMatrixRow, evidence: MatrixEvidenceItem): { id: string; name: string } {
    const suffix = evidence.testSelector ?? evidence.command;
    const name = sanitizeCheckName(`${row.acceptanceId}-${evidence.kind}-${suffix}`);
    return {
        id: evidence.id ?? `matrix:${row.acceptanceId}:${evidence.kind}:${suffix}`,
        name: name || `${row.acceptanceId}-${evidence.kind}`,
    };
}

/**
 * Resolves one declaration to the check that satisfies it, or an `Error` describing why it cannot.
 *
 * Three shapes, tried in the order the previous implementation tried them:
 *   1. a selector plus a `{{selector}}` template — the selector is substituted, the command line is then split;
 *   2. a selector plus a known selector-capable runner — the runner is launched with the selector appended;
 *   3. a plain command line.
 */
export function resolveCheckForRow(row: AcceptanceMatrixRow, evidence: MatrixEvidenceItem, root: string): CheckCommand | Error {
    const hasSelector = typeof evidence.testSelector === 'string' && evidence.testSelector.length > 0;
    const template = evidence.command.trim();
    const hasPlaceholder = template.includes('{{selector}}');
    const { id, name } = checkIdentity(row, evidence);
    const runtimeProjectDir = matrixProjectDir(row, root);

    if (hasSelector && hasPlaceholder) {
        const selector = testSelectorForRuntime(evidence.testSelector!, runtimeProjectDir, root);
        const filled = template.replace('{{selector}}', selector);
        const [rawCommand, ...args] = filled.split(/\s+/);
        const entry = matrixRunners[rawCommand!]?.nodeEntry;
        const runtimeEntry = entry ? join(runtimeProjectDir, entry) : undefined;
        return {
            id,
            source: 'matrix',
            name,
            kind: evidence.kind,
            ...coveredByOf(evidence),
            command: runtimeEntry ? process.execPath : rawCommand!,
            args: [...(runtimeEntry ? [runtimeEntry] : []), ...args],
            cwd: runtimeProjectDir,
            timeoutMs: timeoutForKind(evidence.kind),
            // Two reasons, both structural: the input fingerprint must change when the selector does (or a reuse would
            // credit the wrong test), and Verify/Review may only execute selectors a declaration named (L0-04/L2-04).
            // Keeping the selector out of `args` is what lets those two rules read it rather than pattern-match the
            // command line.
            testSelector: selector,
        } satisfies CheckCommand;
    }

    if (hasSelector) {
        const isKnownRunner = selectorRunnerCommandLines.some((runner) => template === runner || template.startsWith(`${runner} `));
        if (isKnownRunner) {
            const [rawCommand, ...args] = template.split(/\s+/);
            const selector = testSelectorForRuntime(evidence.testSelector!, runtimeProjectDir, root);
            const spec = matrixRunners[rawCommand!];
            const entry = spec?.nodeEntry;
            const runtimeEntry = spec?.nodeCommandOnSelectorPath
                ?? (entry ? join(runtimeProjectDir, entry) : undefined);
            return {
                id,
                source: 'matrix',
                name,
                kind: evidence.kind,
                ...coveredByOf(evidence),
                command: runtimeEntry ? process.execPath : rawCommand!,
                args: [...(runtimeEntry ? [runtimeEntry] : []), ...args, ...selectorArgs(selector)],
                cwd: runtimeProjectDir,
                timeoutMs: timeoutForKind(evidence.kind),
                testSelector: selector,
            } satisfies CheckCommand;
        }
        return new Error(`Matrix row ${row.acceptanceId} declares a testSelector but command "${template}" does not support selectors. Use vitest, pytest, uv run pytest, or a command template with {{selector}} placeholder.`);
    }

    const [rawCommand, ...args] = template.split(/\s+/);
    const selector = evidence.testSelector ? testSelectorForRuntime(evidence.testSelector, runtimeProjectDir, root) : undefined;
    const entry = matrixRunners[rawCommand!]?.nodeEntry;
    const runtimeEntry = entry ? join(runtimeProjectDir, entry) : undefined;
    return {
        id,
        source: 'matrix',
        name,
        kind: evidence.kind,
        ...coveredByOf(evidence),
        command: runtimeEntry ? process.execPath : rawCommand!,
        args: [...(runtimeEntry ? [runtimeEntry] : []), ...args, ...(selector ? selectorArgs(selector) : [])],
        cwd: runtimeProjectDir,
        timeoutMs: timeoutForKind(evidence.kind),
        ...(selector ? { testSelector: selector } : {}),
    } satisfies CheckCommand;
}

/** The stable identity of a resolved check, matching `resolveSealChecks`' naming for the revision id. */
export function resolvedCheckId(check: CheckCommand): string {
    return check.id ?? `${check.kind}:${check.command}:${(check.args ?? []).join(' ')}`;
}

/** Every declaration in the matrix, resolved and de-duplicated. Throws the resolver's error, as the seal always has. */
export function matrixChecks(root: string, matrix: AcceptanceMatrix): CheckCommand[] {
    const checks: CheckCommand[] = [];
    for (const row of matrix.rows) {
        for (const evidence of row.evidence) {
            const result = resolveCheckForRow(row, evidence, root);
            if (result instanceof Error) {
                throw result;
            }
            checks.push(result);
        }
    }
    return dedupeChecks(checks);
}

/** One identity tuple for checks: kind, command, arguments and working directory. */
export function dedupeChecks(checks: CheckCommand[]): CheckCommand[] {
    return checks.filter((check, index) => checks.findIndex((candidate) =>
        candidate.kind === check.kind
        && candidate.command === check.command
        && (candidate.args ?? []).join('\0') === (check.args ?? []).join('\0')
        && candidate.cwd === check.cwd,
    ) === index);
}
