import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import {
    declareCorrectiveAction,
    readCorrectiveActionStatus,
    readCorrectiveActions,
    summarizeCorrectiveAction,
} from '../workflow/corrective-action.js';

/**
 * `kata-cli corrective …` — the declaration that a task exists because of a *class*, and who owns it.
 *
 * Two verbs. `status` reads one task's declaration (or the whole repository's, with `--all`), so an operator can see which
 * class is already owned before opening a second task for it. `declare` writes the declaration and **refuses a second
 * owner for a class that has not been discharged**, which is the rule the design states and nothing enforced: without it a
 * new reviewer reporting the same class is free to start a new task, and the same defect gets repaired twice.
 *
 * The class contract is the review loop's own seven-field obligation, read from a file rather than typed as flags: a
 * contract is a document (states, an inventory, an invariant, the surface, the test), and a flag per field would invite the
 * half-filled version that no reader can check.
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

const USAGE = 'Usage: kata-cli corrective <status|declare> --change <id> [--all | --source-change <id> --class <key> --owner <who> --obligation-file <json>] [--root <path>]';

export async function runCorrectiveCommand(argv: string[]): Promise<Record<string, unknown>> {
    const [subcommand, ...rest] = argv;
    const root = flagValue(rest, '--root') ?? process.cwd();

    if (subcommand === 'status') {
        if (rest.includes('--all')) {
            const { open, unreadable } = await readCorrectiveActions(root);
            return {
                command: 'corrective status',
                scope: 'repository',
                // Published together, because "no class is owned" and "a declaration could not be read" are different
                // answers and a caller reading only `open` would take the second for the first.
                open,
                unreadable,
                openCount: open.filter((entry) => !entry.discharged).length,
                dischargedCount: open.filter((entry) => entry.discharged).length,
            };
        }
        const taskId = required(rest, '--change', USAGE);
        return { command: 'corrective status', ...summarizeCorrectiveAction(await readCorrectiveActionStatus(root, taskId)) };
    }

    if (subcommand === 'declare') {
        const taskId = required(rest, '--change', USAGE);
        const sourceChangeId = required(rest, '--source-change', USAGE);
        const classKey = required(rest, '--class', USAGE);
        const owner = required(rest, '--owner', USAGE);
        const obligationFile = required(rest, '--obligation-file', USAGE);
        const path = isAbsolute(obligationFile) ? obligationFile : resolve(root, obligationFile);
        const obligation = JSON.parse(await readFile(path, 'utf8')) as unknown;
        const findingIds = rest
            .map((token, index) => (token === '--finding' ? rest[index + 1] : undefined))
            .filter((value): value is string => typeof value === 'string' && !value.startsWith('--'));
        const note = flagValue(rest, '--note');
        const declared = await declareCorrectiveAction({
            root,
            taskId,
            classKey,
            sourceChangeId,
            owner,
            obligation,
            ...(findingIds.length === 0 ? {} : { sourceFindingIds: findingIds }),
            ...(note === undefined ? {} : { note }),
        });
        return {
            command: 'corrective declare',
            ...summarizeCorrectiveAction(declared.status),
            message: `Declared. Class '${declared.declaration.classKey}' is owned by '${taskId}' (owner: ${declared.declaration.owner}) until its current revision carries a Judge pass.`,
        };
    }

    throw new Error(USAGE);
}
