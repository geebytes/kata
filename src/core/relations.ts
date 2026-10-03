import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { assertValidTaskId } from './ids.js';
import { readValidatedOptional, validate } from './schema.js';
import { withRepositoryArtefactLock } from './locks.js';
import { relationsPath, taskPath } from './layout.js';

export type TaskRelationType =
  | 'superseded_by'
  | 'covered_by'
  | 'duplicate_of'
  | 'merged_into'
  | 'parent_of'
  | 'spawned_from'
  | 'related_to'
  | 'contains'
  | 'implements'
  | 'repairs'
  | 'depends_on'
  | 'blocked_by';

export type RelationEndpointType = 'task' | 'change';

export type RelationEndpoint = {
  type: RelationEndpointType;
  id: string;
};

export type RelationKind = 'ownership' | 'lineage' | 'control' | 'context';

/** The lifecycle policies a relation may carry (the type-level vocabulary, mirrored by the schema's enum). */
export type LifecyclePolicy = 'blocks' | 'invalidates_design' | 'implements_finding' | 'informs' | 'independent';

/** What a lifecycle relation owes back, and what it points at. */
export type LifecycleMetadata = {
  initiativeId: string;
  policy: LifecyclePolicy;
  requiredReturn: 'revalidation' | 'impact_packet' | 'none';
  sourceFindingIds?: string[];
  affectedAssumptionIds?: string[];
  /** Declared surfaces, which is what makes an `independent` claim checkable rather than aspirational. */
  declaredSurfaces?: { from: string[]; to: string[] };
};

export type KataRelation = {
  /**
   * **Stable, and never derived from the endpoints.**
   *
   * A lifecycle record has to name one particular relation — "this packet answers that finding's edge" — and the graph
   * replaces edges by `(from, to, type)`. Without an id the only available binding would be a fingerprint of the
   * endpoints, which breaks the first time the edge is rewritten, and that is the second-derivation defect this whole
   * change is about. The id is therefore allocated once by the writer, inherited by a rewrite of the same edge, and
   * never minted by a reader.
   */
  id: string;
  kind: RelationKind;
  type: TaskRelationType;
  from: RelationEndpoint;
  to: RelationEndpoint;
  reason?: string;
  createdAt: string;
  createdBy?: string;
  lifecycle?: LifecycleMetadata;
};

export type KataRelationsGraph = {
  /** `1` is a graph written before edges had identities; `2` requires one on every edge. */
  version: 1 | 2;
  relations: KataRelationWithLegacyId[];
  updatedAt: string;
};

/**
 * **A v1 edge has no id, and that is a readable state, not a drifted one.**
 *
 * Every graph written before this change is v1, and this repository has several. Rejecting them would turn the
 * historical topology unreadable — the reader would report drift on files that are exactly what the old writer
 * produced — and the record that matters most is the one already written. The id becomes required at v2, and the
 * migration that mints the missing ids happens once, inside the first locked write.
 */
export type KataRelationWithLegacyId = Omit<KataRelation, 'id'> & { id?: string };

export type TaskRelation = {
  type: TaskRelationType;
  targetTaskId: string;
  reason?: string;
  createdAt: string;
  createdBy?: string;
};

export type TaskRelationsRecord = {
  taskId: string;
  relations: TaskRelation[];
  updatedAt: string;
};

export const terminalRelationTypes: readonly TaskRelationType[] = [
  'superseded_by',
  'covered_by',
  'duplicate_of',
  'merged_into',
];

export const relationTypes: readonly TaskRelationType[] = [
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

export function isTerminalRelation(type: string): type is TaskRelationType {
  return terminalRelationTypes.includes(type as TaskRelationType);
}

export async function addTaskRelation(input: {
  root: string;
  fromTaskId: string;
  toTaskId: string;
  type: TaskRelationType;
  reason?: string;
  createdBy?: string;
}): Promise<TaskRelationsRecord> {
  assertValidTaskId(input.fromTaskId);
  assertValidTaskId(input.toTaskId);
  if (input.fromTaskId === input.toTaskId) throw new Error('Task relation cannot point to itself');
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
  const record = await readTaskRelations(input.root, input.fromTaskId);
  return record;
}

/**
 * Allocate a relation id.
 *
 * Random rather than sequential because the graph is rewritten wholesale on every mutation and several graphs exist
 * across worktrees: a counter derived per-file would hand two different edges the same id, which is exactly the
 * ambiguity the id exists to remove. `edge-<hex>` is greppable and carries no position, so a reordering never implies
 * a re-identification.
 */
function newRelationId(): string {
  return `edge-${randomUUID().replaceAll('-', '').slice(0, 16)}`;
}

/**
 * **The one migration, and it happens on the write side.**
 *
 * A v1 graph is upgraded as a whole, in the same locked mutation that adds an edge: allocating ids lazily on read
 * would make two readers disagree about the identity of the same edge (each would mint its own), and allocating ids
 * only for the edge being added would leave the rest of the graph without identities forever. The order inside the
 * lock is: validate what is on disk, migrate it, then apply the mutation — so a refusal never half-upgrades a graph.
 */
function upgradeToCurrentVersion(graph: KataRelationsGraph): { graph: KataRelationsGraph; migrated: boolean } {
  if (graph.version >= 2 && graph.relations.every((relation) => typeof relation.id === 'string' && relation.id.length > 0)) {
    return { graph, migrated: false };
  }
  const used = new Set(graph.relations.map((relation) => relation.id).filter((id): id is string => typeof id === 'string' && id.length > 0));
  const relations = graph.relations.map((relation) => {
    if (typeof relation.id === 'string' && relation.id.length > 0) return relation;
    let id = newRelationId();
    while (used.has(id)) id = newRelationId();
    used.add(id);
    return { ...relation, id };
  });
  return { graph: { ...graph, version: 2, relations }, migrated: true };
}

/** Two edges are the same edge when they join the same endpoints in the same way. */
function sameEdge(left: KataRelationWithLegacyId, right: KataRelation): boolean {
  return sameEndpoint(left.from, right.from) && sameEndpoint(left.to, right.to) && left.type === right.type;
}

export async function addKataRelation(input: {
  root: string;
  from: RelationEndpoint;
  to: RelationEndpoint;
  type: TaskRelationType;
  kind?: RelationKind;
  reason?: string;
  createdAt?: string;
  createdBy?: string;
}): Promise<KataRelationsGraph> {
  validateEndpoint(input.from);
  validateEndpoint(input.to);
  if (input.from.type === input.to.type && input.from.id === input.to.id) throw new Error('Relation cannot point to itself');
  if (input.from.type === 'task') await assertTaskExists(input.root, input.from.id);
  if (input.to.type === 'task') await assertTaskExists(input.root, input.to.id);

  const now = input.createdAt ?? new Date().toISOString();
  // L3-02: the read and the write are one critical section. Two commands adding an edge used to interleave — read,
  // read, write, write — and the second write silently dropped the first edge. Validation on write (D5) means a graph
  // that drifted fails the mutation that would have compounded it, naming the field.
  let next: KataRelationsGraph = { version: 2, relations: [], updatedAt: now };
  await withRepositoryArtefactLock(input.root, 'relations', relationsPath(input.root), async (current) => {
    // Validation is of the graph that is **on disk**: an absent file has no graph to drift, and the seed below is an
    // internal placeholder whose empty `updatedAt` the schema rightly rejects. Validating the seed would make the
    // first write fail on a graph nobody ever wrote.
    const existing = current.trim()
      ? validate<KataRelationsGraph>('kata-relations', JSON.parse(current) as unknown)
      : { version: 2 as const, relations: [] as KataRelationWithLegacyId[], updatedAt: '' };
    const { graph } = upgradeToCurrentVersion(existing);
    // **The id survives a rewrite of the same edge.** Re-adding an edge is a re-statement, not a new relation, so
    // the existing id is inherited: a lifecycle record pointing at this edge keeps pointing at it.
    const replaced = graph.relations.find((item) => sameEdge(item, { ...relationShape(input, now), id: '' } as KataRelation));
    const relation: KataRelation = {
      id: replaced?.id ?? newRelationId(),
      kind: input.kind ?? inferRelationKind(input.type),
      type: input.type,
      from: input.from,
      to: input.to,
      ...(input.reason ? { reason: input.reason } : {}),
      createdAt: now,
      ...(input.createdBy ? { createdBy: input.createdBy } : {}),
    };
    next = {
      version: 2,
      relations: [...graph.relations.filter((item) => !sameEdge(item, relation)), relation],
      updatedAt: now,
    };
    return `${JSON.stringify(next, null, 2)}\n`;
  });
  return next;
}

/** The endpoint/type part of an edge, shared by the replacement lookup and the writer. */
function relationShape(input: { from: RelationEndpoint; to: RelationEndpoint; type: TaskRelationType }, now: string): Omit<KataRelation, 'id'> {
  return {
    kind: inferRelationKind(input.type),
    type: input.type,
    from: input.from,
    to: input.to,
    createdAt: now,
  };
}

export type LifecycleRelationInput = {
  root: string;
  from: RelationEndpoint;
  to: RelationEndpoint;
  type: TaskRelationType;
  lifecycle: LifecycleMetadata;
  reason?: string;
  createdBy?: string;
  createdAt?: string;
};

/**
 * **The only writer of a lifecycle edge.**
 *
 * It exists as a separate entry point rather than a flag on `addKataRelation` because two of its rules are about the
 * graph rather than about the edge: a lifecycle edge may not close a cycle, and an `independent` claim is refused
 * when the two endpoints declare an overlapping surface. Both are checked against the graph that is on disk, inside
 * the same locked mutation that writes it — checking before the lock would validate a graph another writer may have
 * already changed.
 */
export async function addLifecycleRelation(input: LifecycleRelationInput): Promise<KataRelationsGraph> {
  validateEndpoint(input.from);
  validateEndpoint(input.to);
  if (input.from.type === input.to.type && input.from.id === input.to.id) throw new Error('Lifecycle relation cannot point to itself');
  if (input.from.type === 'task') await assertTaskExists(input.root, input.from.id);
  if (input.to.type === 'task') await assertTaskExists(input.root, input.to.id);
  if (!input.lifecycle.initiativeId.trim()) throw new Error('A lifecycle relation must name its initiative');
  if (input.lifecycle.policy === 'independent') {
    const overlap = surfaceOverlap(input.lifecycle.declaredSurfaces);
    if (overlap.length > 0) {
      throw new Error(
        `An independent lifecycle relation declares overlapping surfaces (${overlap.join(', ')}), so the two endpoints are not independent; declare a dependent policy instead.`
      );
    }
  }

  const now = input.createdAt ?? new Date().toISOString();
  let next: KataRelationsGraph = { version: 2, relations: [], updatedAt: now };
  await withRepositoryArtefactLock(input.root, 'relations', relationsPath(input.root), async (current) => {
    const existing = current.trim()
      ? validate<KataRelationsGraph>('kata-relations', JSON.parse(current) as unknown)
      : { version: 2 as const, relations: [] as KataRelationWithLegacyId[], updatedAt: '' };
    const { graph } = upgradeToCurrentVersion(existing);
    if (closesCycle(graph.relations, input.from, input.to)) {
      throw new Error(`Lifecycle relation would close a cycle: ${describeEndpoint(input.to)} already reaches ${describeEndpoint(input.from)}`);
    }
    const replaced = graph.relations.find((item) => sameEdge(item, { ...relationShape(input, now), id: '' } as KataRelation));
    const relation: KataRelation = {
      id: replaced?.id ?? newRelationId(),
      kind: inferRelationKind(input.type),
      type: input.type,
      from: input.from,
      to: input.to,
      ...(input.reason ? { reason: input.reason } : {}),
      createdAt: now,
      ...(input.createdBy ? { createdBy: input.createdBy } : {}),
      lifecycle: {
        initiativeId: input.lifecycle.initiativeId,
        policy: input.lifecycle.policy,
        requiredReturn: input.lifecycle.requiredReturn,
        ...(input.lifecycle.sourceFindingIds?.length ? { sourceFindingIds: [...input.lifecycle.sourceFindingIds] } : {}),
        ...(input.lifecycle.affectedAssumptionIds?.length ? { affectedAssumptionIds: [...input.lifecycle.affectedAssumptionIds] } : {}),
        ...(input.lifecycle.declaredSurfaces ? { declaredSurfaces: input.lifecycle.declaredSurfaces } : {}),
      },
    };
    next = {
      version: 2,
      relations: [...graph.relations.filter((item) => !sameEdge(item, relation)), relation],
      updatedAt: now,
    };
    return `${JSON.stringify(next, null, 2)}\n`;
  });
  return next;
}

/** The declared surfaces two endpoints share, if any. */
function surfaceOverlap(surfaces: LifecycleMetadata['declaredSurfaces']): string[] {
  if (!surfaces) return [];
  const to = new Set(surfaces.to);
  return surfaces.from.filter((path) => to.has(path));
}

/**
 * True when adding `from -> to` would close a cycle: `from` is reachable from `to` already.
 *
 * Reachability is walked over the graph's own edges, which is the only description of the topology — a second
 * structure holding "which nodes reach which" would be one more thing that can disagree with the graph.
 */
function closesCycle(relations: readonly KataRelationWithLegacyId[], from: RelationEndpoint, to: RelationEndpoint): boolean {
  const seen = new Set<string>();
  const stack: RelationEndpoint[] = [to];
  while (stack.length > 0) {
    const current = stack.pop() as RelationEndpoint;
    const key = `${current.type}:${current.id}`;
    if (key === `${from.type}:${from.id}`) return true;
    if (seen.has(key)) continue;
    seen.add(key);
    for (const relation of relations) {
      if (sameEndpoint(relation.from, current)) stack.push(relation.to);
    }
  }
  return false;
}

function describeEndpoint(endpoint: RelationEndpoint): string {
  return `${endpoint.type}:${endpoint.id}`;
}

/**
 * The relation graph is the one authoritative store for task relations. An absent graph means no relations have been
 * recorded; a graph that drifted is an error rather than an empty answer.
 */
export async function readKataRelations(root: string): Promise<KataRelationsGraph> {
  // **A v1 graph is readable, and reading it changes nothing.** The migration lives on the write side deliberately:
  // minting ids here would let two readers disagree about the identity of the same edge, and would rewrite a historical
  // record on a command that only asked to look at it.
  const graph = await readValidatedOptional<KataRelationsGraph>('kata-relations', graphPath(root));
  if (!graph) return { version: 2, relations: [], updatedAt: '' };
  // A v2 graph is required to carry an id on every edge by its writer; the reader does not invent one, so a graph whose
  // edges lack ids is reported as what it is — v1 — rather than being given identities two readers would disagree on.
  return { version: graph.version, relations: graph.relations, updatedAt: graph.updatedAt };
}

export async function findKataRelations(root: string, endpoint: RelationEndpoint): Promise<{
  endpoint: RelationEndpoint;
  outgoing: KataRelationWithLegacyId[];
  incoming: KataRelationWithLegacyId[];
}> {
  validateEndpoint(endpoint);
  const graph = await readKataRelations(root);
  return {
    endpoint,
    // A v1 edge has no id and is returned as it is: the caller that needs an identity is the lifecycle writer, which
    // migrates the graph first, so this read never has to invent one.
    outgoing: graph.relations.filter((relation) => sameEndpoint(relation.from, endpoint)),
    incoming: graph.relations.filter((relation) => sameEndpoint(relation.to, endpoint)),
  };
}

/**
 * A task's relations, derived from the authoritative graph.
 *
 * One edge used to be written to three stores (the graph, `.kata/tasks/<id>/task-relations.json`, and `task.json`), and
 * reads preferred the per-task file while falling back to `task.json` on any error — so a failure between the writes
 * left the stores disagreeing and the fallback hid it. The graph is the store now; the CLI's projections are gone.
 */
export async function readTaskRelations(root: string, taskId: string): Promise<TaskRelationsRecord> {
  assertValidTaskId(taskId);
  const graph = await readKataRelations(root);
  const relations = graph.relations
    .filter((relation) => relation.from.type === 'task' && relation.from.id === taskId && relation.to.type === 'task')
    .map((relation): TaskRelation => ({
      type: relation.type,
      targetTaskId: relation.to.id,
      ...(relation.reason ? { reason: relation.reason } : {}),
      createdAt: relation.createdAt,
      ...(relation.createdBy ? { createdBy: relation.createdBy } : {}),
    }));
  return {
    taskId,
    relations,
    updatedAt: graph.relations.reduce((latest, relation) => (relation.createdAt > latest ? relation.createdAt : latest), graph.updatedAt),
  };
}

export async function readTerminalTaskRelation(root: string, taskId: string): Promise<TaskRelation | null> {
  const record = await readTaskRelations(root, taskId);
  return record.relations.find((relation) => isTerminalRelation(relation.type)) ?? null;
}

export async function resolveTerminalTask(root: string, taskId: string): Promise<{
  taskId: string;
  redirects: Array<{ fromTaskId: string; toTaskId: string; type: TaskRelationType; reason?: string }>;
}> {
  assertValidTaskId(taskId);
  const seen = new Set<string>();
  const redirects: Array<{ fromTaskId: string; toTaskId: string; type: TaskRelationType; reason?: string }> = [];
  let current = taskId;
  for (let depth = 0; depth < 16; depth += 1) {
    if (seen.has(current)) throw new Error(`Task relation cycle detected at ${current}`);
    seen.add(current);
    const relation = await readTerminalTaskRelation(root, current);
    if (!relation) return { taskId: current, redirects };
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

function isTaskRelation(value: unknown): value is TaskRelation {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.type === 'string'
    && typeof record.targetTaskId === 'string'
    && typeof record.createdAt === 'string';
}

function isKataRelation(value: unknown): value is KataRelation {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.kind === 'string'
    && typeof record.type === 'string'
    && isEndpoint(record.from)
    && isEndpoint(record.to)
    && typeof record.createdAt === 'string';
}

function isEndpoint(value: unknown): value is RelationEndpoint {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (record.type === 'task' || record.type === 'change') && typeof record.id === 'string';
}

function validateEndpoint(endpoint: RelationEndpoint): void {
  if (endpoint.type !== 'task' && endpoint.type !== 'change') throw new Error(`Invalid relation endpoint type: ${endpoint.type}`);
  assertValidTaskId(endpoint.id);
}

function sameEndpoint(left: RelationEndpoint, right: RelationEndpoint): boolean {
  return left.type === right.type && left.id === right.id;
}

function inferRelationKind(type: TaskRelationType): RelationKind {
  if (type === 'contains' || type === 'implements') return 'ownership';
  if (type === 'parent_of' || type === 'spawned_from' || type === 'repairs') return 'lineage';
  if (isTerminalRelation(type) || type === 'depends_on' || type === 'blocked_by') return 'control';
  return 'context';
}

async function assertTaskExists(root: string, taskId: string): Promise<void> {
  await readTask(root, taskId);
}

/** The task record itself, for the existence check. Relations are no longer mirrored into it. */
async function readTask(root: string, taskId: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(taskPath(root, taskId), 'utf8')) as Record<string, unknown>;
}





function graphPath(root: string): string {
  return relationsPath(root);
}
