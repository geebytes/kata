import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { assertValidTaskId } from './ids.js';
export const terminalRelationTypes = [
    'superseded_by',
    'covered_by',
    'duplicate_of',
    'merged_into',
];
export const relationTypes = [
    'superseded_by',
    'covered_by',
    'duplicate_of',
    'merged_into',
    'parent_of',
    'spawned_from',
    'related_to',
    'contains',
    'implements',
    'repairs',
    'depends_on',
    'blocked_by',
];
export function isTerminalRelation(type) {
    return terminalRelationTypes.includes(type);
}
export async function addTaskRelation(input) {
    assertValidTaskId(input.fromTaskId);
    assertValidTaskId(input.toTaskId);
    if (input.fromTaskId === input.toTaskId)
        throw new Error('Task relation cannot point to itself');
    await assertTaskExists(input.root, input.fromTaskId);
    await assertTaskExists(input.root, input.toTaskId);
    const now = new Date().toISOString();
    await addKataRelation({
        root: input.root,
        from: { type: 'task', id: input.fromTaskId },
        to: { type: 'task', id: input.toTaskId },
        type: input.type,
        ...(input.reason ? { reason: input.reason } : {}),
        ...(input.createdBy ? { createdBy: input.createdBy } : {}),
        createdAt: now,
    });
    const current = await readTaskRelations(input.root, input.fromTaskId);
    const relation = {
        type: input.type,
        targetTaskId: input.toTaskId,
        ...(input.reason ? { reason: input.reason } : {}),
        createdAt: now,
        ...(input.createdBy ? { createdBy: input.createdBy } : {}),
    };
    const next = {
        taskId: input.fromTaskId,
        relations: [
            ...current.relations.filter((item) => !(item.type === relation.type && item.targetTaskId === relation.targetTaskId)),
            relation,
        ],
        updatedAt: now,
    };
    await writeTaskRelations(input.root, input.fromTaskId, next);
    await mirrorRelationIntoTask(input.root, input.fromTaskId, next);
    return next;
}
export async function addKataRelation(input) {
    validateEndpoint(input.from);
    validateEndpoint(input.to);
    if (input.from.type === input.to.type && input.from.id === input.to.id)
        throw new Error('Relation cannot point to itself');
    if (input.from.type === 'task')
        await assertTaskExists(input.root, input.from.id);
    if (input.to.type === 'task')
        await assertTaskExists(input.root, input.to.id);
    const now = input.createdAt ?? new Date().toISOString();
    const current = await readKataRelations(input.root);
    const relation = {
        kind: input.kind ?? inferRelationKind(input.type),
        type: input.type,
        from: input.from,
        to: input.to,
        ...(input.reason ? { reason: input.reason } : {}),
        createdAt: now,
        ...(input.createdBy ? { createdBy: input.createdBy } : {}),
    };
    const next = {
        version: 1,
        relations: [
            ...current.relations.filter((item) => !sameEndpoint(item.from, relation.from) || !sameEndpoint(item.to, relation.to) || item.type !== relation.type),
            relation,
        ],
        updatedAt: now,
    };
    await writeKataRelations(input.root, next);
    return next;
}
export async function readKataRelations(root) {
    try {
        const parsed = JSON.parse(await readFile(graphPath(root), 'utf8'));
        return {
            version: 1,
            relations: Array.isArray(parsed.relations) ? parsed.relations.filter(isKataRelation) : [],
            updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : '',
        };
    }
    catch {
        return { version: 1, relations: [], updatedAt: '' };
    }
}
export async function findKataRelations(root, endpoint) {
    validateEndpoint(endpoint);
    const graph = await readKataRelations(root);
    return {
        endpoint,
        outgoing: graph.relations.filter((relation) => sameEndpoint(relation.from, endpoint)),
        incoming: graph.relations.filter((relation) => sameEndpoint(relation.to, endpoint)),
    };
}
export async function readTaskRelations(root, taskId) {
    assertValidTaskId(taskId);
    const path = relationPath(root, taskId);
    try {
        const parsed = JSON.parse(await readFile(path, 'utf8'));
        return {
            taskId,
            relations: Array.isArray(parsed.relations) ? parsed.relations.filter(isTaskRelation) : [],
            updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : '',
        };
    }
    catch {
        const task = await readTask(root, taskId).catch(() => null);
        const taskRelations = Array.isArray(task?.relations) ? task.relations.filter(isTaskRelation) : [];
        return { taskId, relations: taskRelations, updatedAt: typeof task?.updatedAt === 'string' ? task.updatedAt : '' };
    }
}
export async function readTerminalTaskRelation(root, taskId) {
    const record = await readTaskRelations(root, taskId);
    return record.relations.find((relation) => isTerminalRelation(relation.type)) ?? null;
}
export async function resolveTerminalTask(root, taskId) {
    assertValidTaskId(taskId);
    const seen = new Set();
    const redirects = [];
    let current = taskId;
    for (let depth = 0; depth < 16; depth += 1) {
        if (seen.has(current))
            throw new Error(`Task relation cycle detected at ${current}`);
        seen.add(current);
        const relation = await readTerminalTaskRelation(root, current);
        if (!relation)
            return { taskId: current, redirects };
        redirects.push({
            fromTaskId: current,
            toTaskId: relation.targetTaskId,
            type: relation.type,
            ...(relation.reason ? { reason: relation.reason } : {}),
        });
        current = relation.targetTaskId;
    }
    throw new Error(`Task relation chain is too deep starting at ${taskId}`);
}
function isTaskRelation(value) {
    if (typeof value !== 'object' || value === null || Array.isArray(value))
        return false;
    const record = value;
    return typeof record.type === 'string'
        && typeof record.targetTaskId === 'string'
        && typeof record.createdAt === 'string';
}
function isKataRelation(value) {
    if (typeof value !== 'object' || value === null || Array.isArray(value))
        return false;
    const record = value;
    return typeof record.kind === 'string'
        && typeof record.type === 'string'
        && isEndpoint(record.from)
        && isEndpoint(record.to)
        && typeof record.createdAt === 'string';
}
function isEndpoint(value) {
    if (typeof value !== 'object' || value === null || Array.isArray(value))
        return false;
    const record = value;
    return (record.type === 'task' || record.type === 'change') && typeof record.id === 'string';
}
function validateEndpoint(endpoint) {
    if (endpoint.type !== 'task' && endpoint.type !== 'change')
        throw new Error(`Invalid relation endpoint type: ${endpoint.type}`);
    assertValidTaskId(endpoint.id);
}
function sameEndpoint(left, right) {
    return left.type === right.type && left.id === right.id;
}
function inferRelationKind(type) {
    if (type === 'contains' || type === 'implements')
        return 'ownership';
    if (type === 'parent_of' || type === 'spawned_from' || type === 'repairs')
        return 'lineage';
    if (isTerminalRelation(type) || type === 'depends_on' || type === 'blocked_by')
        return 'control';
    return 'context';
}
async function assertTaskExists(root, taskId) {
    await readTask(root, taskId);
}
async function readTask(root, taskId) {
    return JSON.parse(await readFile(join(root, '.kata/tasks', taskId, 'task.json'), 'utf8'));
}
async function writeTaskRelations(root, taskId, record) {
    const path = relationPath(root, taskId);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
}
async function mirrorRelationIntoTask(root, taskId, record) {
    const path = join(root, '.kata/tasks', taskId, 'task.json');
    const task = await readTask(root, taskId);
    task.relations = record.relations;
    task.updatedAt = record.updatedAt;
    await writeFile(path, `${JSON.stringify(task, null, 2)}\n`, 'utf8');
}
function relationPath(root, taskId) {
    return join(root, '.kata/tasks', taskId, 'task-relations.json');
}
async function writeKataRelations(root, graph) {
    const path = graphPath(root);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(graph, null, 2)}\n`, 'utf8');
}
function graphPath(root) {
    return join(root, '.kata/relations.json');
}
//# sourceMappingURL=relations.js.map