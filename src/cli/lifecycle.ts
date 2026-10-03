import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
    appendLifecycleEvent,
    initiativeDir,
    readInitiativeLifecycle,
} from '../core/initiative-lifecycle.js';
import { addLifecycleRelation, readKataRelations, type LifecyclePolicy } from '../core/relations.js';
import { writeFileAtomic } from '../core/state.js';

/**
 * `kata-cli lifecycle …` — the operator's route into an Initiative's lifecycle.
 *
 * The command family exists because a mechanism with a library and no entry point is the defect this repository finds
 * most often: an Initiative has to be creatable, attachable and inspectable from the CLI, or every later trigger is
 * unreachable in practice.
 *
 * The reads and writes here go through the same modules the workflow uses — the relation writer for topology, the
 * lifecycle store for history — rather than opening the files themselves. A command that wrote its own `relations.json`
 * would be a second writer of the one topology, which is precisely what this change refuses.
 */

/** Where a design's declared dependency surface lives, read by the trigger and written by `lifecycle design`. */
export function designsPath(root: string, initiativeId: string): string {
    return join(initiativeDir(root, initiativeId), 'designs.json');
}

export type DesignDeclaration = { designId: string; dependsOn: string[] };

export async function readDesignDeclarations(root: string, initiativeId: string): Promise<DesignDeclaration[]> {
    const raw = await readFile(designsPath(root, initiativeId), 'utf8').catch(() => null);
    if (raw === null) return [];
    const parsed = JSON.parse(raw) as { designs?: DesignDeclaration[] };
    return parsed.designs ?? [];
}

export async function writeDesignDeclarations(root: string, initiativeId: string, designs: readonly DesignDeclaration[]): Promise<void> {
    await mkdir(initiativeDir(root, initiativeId), { recursive: true });
    await writeFileAtomic(designsPath(root, initiativeId), `${JSON.stringify({ designs }, null, 2)}\n`);
}

const POLICIES: readonly LifecyclePolicy[] = ['blocks', 'invalidates_design', 'implements_finding', 'informs', 'independent'];
const RETURNS = ['revalidation', 'impact_packet', 'none'] as const;

function flagValue(argv: readonly string[], name: string): string | undefined {
    // Both spellings, and only here: the hand-written comparison this replaces read one form and silently ignored the
    // other, which is the defect the CLI value-read class is about.
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

export async function runLifecycleCommand(argv: string[]): Promise<Record<string, unknown>> {
    const [subcommand, ...rest] = argv;
    const root = flagValue(rest, '--root') ?? process.cwd();

    if (subcommand === 'create') {
        const initiativeId = required(rest, '--initiative', 'Usage: kata-cli lifecycle create --initiative <id>');
        await appendLifecycleEvent(root, initiativeId, { type: 'initiative_created', initiativeId });
        return { command: 'lifecycle create', initiativeId, status: 'active' };
    }

    if (subcommand === 'attach') {
        const initiativeId = required(rest, '--initiative', 'Usage: kata-cli lifecycle attach --initiative <id> --task <id> [--policy <p>] [--return <r>]');
        const taskId = required(rest, '--task', 'Usage: kata-cli lifecycle attach --initiative <id> --task <id>');
        const policy = (flagValue(rest, '--policy') ?? 'informs') as LifecyclePolicy;
        if (!POLICIES.includes(policy)) throw new Error(`Unknown lifecycle policy '${policy}'; expected one of ${POLICIES.join(', ')}.`);
        const requiredReturn = (flagValue(rest, '--return') ?? 'impact_packet') as (typeof RETURNS)[number];
        if (!RETURNS.includes(requiredReturn)) throw new Error(`Unknown required return '${requiredReturn}'; expected one of ${RETURNS.join(', ')}.`);

        const graph = await addLifecycleRelation({
            root,
            from: { type: 'change', id: initiativeId },
            to: { type: 'task', id: taskId },
            type: policy === 'blocks' ? 'blocked_by' : policy === 'implements_finding' ? 'implements' : 'related_to',
            lifecycle: { initiativeId, policy, requiredReturn },
        });
        const relation = graph.relations.find(
            (entry) => entry.from.type === 'change' && entry.from.id === initiativeId && entry.to.id === taskId
        );
        return { command: 'lifecycle attach', initiativeId, taskId, relationId: relation?.id ?? null };
    }

    if (subcommand === 'design') {
        const initiativeId = required(rest, '--initiative', 'Usage: kata-cli lifecycle design --initiative <id> --design <id> --depends-on <path...>');
        const designId = required(rest, '--design', 'Usage: kata-cli lifecycle design --initiative <id> --design <id> --depends-on <path...>');
        const dependsOn = rest
            .map((token, index) => (token === '--depends-on' ? rest[index + 1] : undefined))
            .filter((value): value is string => typeof value === 'string' && !value.startsWith('--'))
            .map((path) => (path.startsWith('path:') ? path : `path:${path}`));
        const existing = await readDesignDeclarations(root, initiativeId);
        const next = [...existing.filter((entry) => entry.designId !== designId), { designId, dependsOn }];
        await writeDesignDeclarations(root, initiativeId, next);
        return { command: 'lifecycle design', initiativeId, designId, dependsOn };
    }

    if (subcommand === 'status') {
        const initiativeId = required(rest, '--initiative', 'Usage: kata-cli lifecycle status --initiative <id>');
        const graph = await readKataRelations(root);
        const relationIds = graph.relations
            .filter((relation) => relation.lifecycle?.initiativeId === initiativeId)
            .map((relation) => relation.id)
            .filter((id): id is string => typeof id === 'string');
        const state = await readInitiativeLifecycle(root, initiativeId);
        return {
            command: 'lifecycle status',
            initiativeId,
            readState: state.readState,
            status: state.current.status,
            relationIds,
            designs: state.current.designs,
            openPacketIds: state.current.openPacketIds,
        };
    }

    throw new Error('Usage: kata-cli lifecycle <create|attach|design|status|reconcile|close> --initiative <id> [--root <path>]');
}
