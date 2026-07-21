import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { assertValidTaskId } from '../core/ids.js';
import { buildContextManifest } from '../core/context.js';
import { createHandoff } from './handoff.js';
import { existsSync } from 'node:fs';
import { computeManifestHash, readCurrentTaskRevision } from './revision.js';
export async function createContextPacket(input) {
    assertValidTaskId(input.taskId);
    assertRole(input.fromRole);
    assertRole(input.toRole);
    const handoff = await createHandoff(input.root, input.taskId, input.toRole);
    const task = JSON.parse(await readFile(join(input.root, '.kata/tasks', input.taskId, 'task.json'), 'utf8'));
    const context = await buildContextManifest({ root: input.root, taskId: input.taskId, sourceRefs: handoff.context.sourceRefs });
    const designRefs = designRefsFor(input.root, input.taskId, input.toRole);
    const packet = { protocolVersion: 1, id: `handoff-${randomUUID().slice(0, 12)}`, taskId: input.taskId, createdAt: new Date().toISOString(), from: { role: input.fromRole, ...(input.platform ? { platform: safePlatform(input.platform) } : {}) }, to: { role: input.toRole }, phase: handoff.fromPhase, repository: await anchor(input.root, input.taskId), task, context: { requiredReads: existingReads(input.root, input.taskId, designRefs), designRefs, sourceRefs: [...handoff.context.sourceRefs].sort(), authoritativeWiki: context.authoritativeWiki.map((record) => ({ id: record.id, path: `.kata/wiki/${record.id}.json` })), excludedWiki: context.excludedWiki.map((record) => ({ id: record.id, reason: record.reason })), evidencePaths: handoff.context.evidenceIds.map((id) => `.kata/evidence/${id}`), priorArtifacts: roleArtifacts(input.root, input.taskId) }, permissions: { allowedWrites: allowedWrites(input.toRole, input.taskId, input.root), guardInstructions: handoff.guardInstructions }, nextAction: `Perform ${input.toRole} work after verifying this handoff.` };
    await writePacket(input.root, packet);
    return packet;
}
export async function readContextPacket(root, taskId, id) { assertValidTaskId(taskId); safeId(id); return JSON.parse(await readFile(packetPath(root, taskId, id), 'utf8')); }
export async function acknowledgeContextPacket(input) { const packet = await readContextPacket(input.root, input.taskId, input.id); assertRole(input.role); const verification = await verifyContextPacket({ root: input.root, taskId: input.taskId, id: input.id }); if (!verification.valid)
    throw new Error(`Cannot acknowledge invalid handoff packet: ${verification.reason}`); const receipt = { protocolVersion: 1, taskId: input.taskId, handoffId: input.id, platform: safePlatform(input.platform), role: input.role, packetSha256: hash(JSON.stringify(packet)), acknowledgedAt: new Date().toISOString(), repository: await anchor(input.root, input.taskId) }; await writeFile(receiptPath(input.root, input.taskId, input.id), `${JSON.stringify(receipt, null, 2)}\n`); return receipt; }
export async function verifyContextPacket(input) { const packet = await readContextPacket(input.root, input.taskId, input.id); const current = await anchor(input.root, input.taskId); if (packet.repository.head !== current.head)
    return { valid: false, reason: 'head_mismatch' }; if (packet.repository.branch !== current.branch)
    return { valid: false, reason: 'branch_mismatch' }; if (packet.repository.scope && !sameScopeIdentity(packet.repository.scope, current.scope))
    return { valid: false, reason: 'diff_mismatch' }; if (packet.repository.diffHash !== current.diffHash)
    return { valid: false, reason: 'diff_mismatch' }; try {
    const receipt = JSON.parse(await readFile(receiptPath(input.root, input.taskId, input.id), 'utf8'));
    if (receipt.packetSha256 !== hash(JSON.stringify(packet)))
        return { valid: false, reason: 'packet_hash_mismatch' };
}
catch { /* acknowledgement is optional before consumption */ } return { valid: true }; }
async function anchor(root, taskId) {
    const revision = await readCurrentTaskRevision(root, taskId);
    const scope = revision
        ? { kind: 'revision', revisionId: revision.id, paths: revision.ownedPaths, hash: await computeManifestHash(root, revision.ownedPaths) }
        : { kind: 'task_context', paths: taskContextPaths(root, taskId), hash: await computeManifestHash(root, taskContextPaths(root, taskId)) };
    return { head: git(root, ['rev-parse', 'HEAD']), branch: git(root, ['branch', '--show-current']), diffHash: scope.hash, scope, worktreeRoot: '.' };
}
function git(root, args) { try {
    const value = execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return value || null;
}
catch {
    return null;
} }
function existingReads(root, taskId, designRefs) { return ['AGENTS.md', '.llmwiki/SCHEMA.md', '.llmwiki/index.md', '.llmwiki/log.md', `.kata/tasks/${taskId}/task.json`, `.kata/tasks/${taskId}/current-state.json`, ...designRefs].filter((path) => { try {
    return resolve(root, path).startsWith(resolve(root));
}
catch {
    return false;
} }); }
function designRefsFor(root, taskId, role) { const designPath = `.kata/tasks/${taskId}/design.md`; return role === 'implementer' && existsSync(join(root, designPath)) ? [designPath] : []; }
function taskContextPaths(root, taskId) { const base = `.kata/tasks/${taskId}`; return [`${base}/task.json`, `${base}/current-state.json`, ...(existsSync(join(root, base, 'design.md')) ? [`${base}/design.md`] : [])]; }
function sameScopeIdentity(left, right) {
    if (left.kind !== right.kind || left.paths.length !== right.paths.length)
        return false;
    if (left.kind === 'revision' && (right.kind !== 'revision' || left.revisionId !== right.revisionId))
        return false;
    return left.paths.every((path, index) => path === right.paths[index]);
}
function roleArtifacts(root, taskId) { const base = `.kata/tasks/${taskId}`; return [`${base}/review.json`, `${base}/judge.json`, `${base}/repair.json`]; }
function allowedWrites(role, taskId, root = process.cwd()) {
    if (role === 'designer')
        return ['docs/', `.kata/tasks/${taskId}/`];
    if (role === 'implementer')
        return [existsSync(join(root, 'packages')) ? 'packages/' : 'src/', 'tests/', 'docs/', `.kata/tasks/${taskId}/`];
    return [`.kata/tasks/${taskId}/${role === 'reviewer' ? 'review.json' : role === 'judge' ? 'judge.json' : 'wiki/'}`];
}
async function writePacket(root, packet) { const directory = join(root, '.kata/tasks', packet.taskId, 'handoffs'); await mkdir(directory, { recursive: true }); await writeFile(packetPath(root, packet.taskId, packet.id), `${JSON.stringify(packet, null, 2)}\n`); }
function packetPath(root, taskId, id) { return join(root, '.kata/tasks', taskId, 'handoffs', `${id}.json`); }
function receiptPath(root, taskId, id) { return join(root, '.kata/tasks', taskId, 'handoffs', `${id}.receipt.json`); }
function hash(value) { return createHash('sha256').update(value).digest('hex'); }
function safeId(id) { if (!/^handoff-[a-z0-9-]{1,63}$/.test(id))
    throw new Error('Invalid handoff id'); }
function safePlatform(platform) { if (!/^[a-z][a-z0-9-]{0,63}$/.test(platform))
    throw new Error('Invalid platform'); return platform; }
function assertRole(role) { if (!['designer', 'implementer', 'reviewer', 'judge', 'distiller', 'approver'].includes(role))
    throw new Error(`Invalid handoff role: ${role}`); }
//# sourceMappingURL=context-fabric.js.map