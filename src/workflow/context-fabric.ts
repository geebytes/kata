import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { assertValidTaskId } from '../core/ids.js';
import { buildContextManifest } from '../core/context.js';
import { createHandoff, type Role } from './handoff.js';
import { existsSync } from 'node:fs';
import type { WorkflowProfile } from '../core/workflow-profile.js';
import { computeManifestHash, readCurrentTaskRevision } from './revision.js';
import { readValidated, readValidatedOptional } from '../core/schema.js';
import { hashContent } from '../core/hash.js';
import { currentGitBranch, currentGitHead } from '../core/git.js';
import { taskPath, handoffDir, handoffPacketPath, handoffReceiptPath, reviewPath, judgePath } from '../core/layout.js';

type HandoffAnchorScope =
  | { kind: 'revision'; revisionId: string; paths: string[]; hash: string }
  | { kind: 'task_context'; paths: string[]; hash: string };

export interface HandoffPacket {
  protocolVersion: 1; id: string; taskId: string; createdAt: string;
  from: { role: Role; platform?: string }; to: { role: Role; preferredPlatforms?: string[] }; phase: string;
  repository: { head: string | null; branch: string | null; diffHash: string; scope?: HandoffAnchorScope; worktreeRoot: '.' };
  task: { title: string; acceptance: Array<{ id: string; statement: string }>; workflowProfile?: WorkflowProfile };
  context: { requiredReads: string[]; designRefs: string[]; sourceRefs: string[]; authoritativeWiki: Array<{ id: string; path: string }>; excludedWiki: Array<{ id: string; reason: string }>; evidencePaths: string[]; priorArtifacts: string[] };
  permissions: { allowedWrites: string[]; guardInstructions: string[] }; nextAction: string;
}
export interface HandoffReceipt { protocolVersion: 1; taskId: string; handoffId: string; platform: string; role: Role; packetSha256: string; acknowledgedAt: string; repository: HandoffPacket['repository']; }
/**
 * Why a packet failed verification.
 *
 * There is no `head_mismatch` any more: a packet is bound to **what the task owns**, not to a commit. Measured cost of
 * the old rule: 40 packets and 18 receipts for one task in a day, and 13 rebuilds of the implementer's packet, because
 * every commit — including ones that touched only `docs/` or `.llmwiki/`, which no revision covers — invalidated every
 * receipt. Committing a wiki page is not a change to the artefact under review.
 */
export type ContextPacketVerification =
  | { valid: true }
  | { valid: false; reason: 'branch_mismatch' | 'diff_mismatch' | 'packet_hash_mismatch' };
export async function createContextPacket(input: { root: string; taskId: string; fromRole: Role; toRole: Role; platform?: string }): Promise<HandoffPacket> {
  assertValidTaskId(input.taskId); assertRole(input.fromRole); assertRole(input.toRole);
  const handoff = await createHandoff(input.root, input.taskId, input.toRole);
  const task = JSON.parse(await readFile(taskPath(input.root, input.taskId), 'utf8')) as HandoffPacket['task'];
  const context = await buildContextManifest({ root: input.root, taskId: input.taskId, sourceRefs: handoff.context.sourceRefs });
  const designRefs = designRefsFor(input.root, input.taskId, input.toRole);
  const packet: HandoffPacket = { protocolVersion: 1, id: `handoff-${randomUUID().slice(0, 12)}`, taskId: input.taskId, createdAt: new Date().toISOString(), from: { role: input.fromRole, ...(input.platform ? { platform: safePlatform(input.platform) } : {}) }, to: { role: input.toRole }, phase: handoff.fromPhase, repository: await anchor(input.root, input.taskId), task, context: { requiredReads: existingReads(input.root, input.taskId, designRefs), designRefs, sourceRefs: [...handoff.context.sourceRefs].sort(), authoritativeWiki: context.authoritativeWiki.map((record) => ({ id: record.id, path: `.kata/wiki/${record.id}.json` })), excludedWiki: context.excludedWiki.map((record) => ({ id: record.id, reason: record.reason })), evidencePaths: handoff.context.evidenceIds.map((id) => `.kata/evidence/${id}`), priorArtifacts: roleArtifacts(input.root, input.taskId) }, permissions: { allowedWrites: allowedWrites(input.toRole, input.taskId, input.root), guardInstructions: handoff.guardInstructions }, nextAction: `Perform ${input.toRole} work after verifying this handoff.` };
  await writePacket(input.root, packet); return packet;
}
export async function readContextPacket(root: string, taskId: string, id: string): Promise<HandoffPacket> { assertValidTaskId(taskId); safeId(id); return readValidated<HandoffPacket>('handoff-packet', packetPath(root, taskId, id)); }
export async function acknowledgeContextPacket(input: { root: string; taskId: string; id: string; platform: string; role: Role }): Promise<HandoffReceipt> { const packet = await readContextPacket(input.root, input.taskId, input.id); assertRole(input.role); if (packet.to.role !== input.role) throw new Error(`Handoff role ${input.role} does not match packet recipient ${packet.to.role}.`); const verification = await verifyContextPacket({ root: input.root, taskId: input.taskId, id: input.id }); if (!verification.valid) throw new Error(`Cannot acknowledge invalid handoff packet: ${verification.reason}`); const receipt: HandoffReceipt = { protocolVersion: 1, taskId: input.taskId, handoffId: input.id, platform: safePlatform(input.platform), role: input.role, packetSha256: hashContent(JSON.stringify(packet)), acknowledgedAt: new Date().toISOString(), repository: await anchor(input.root, input.taskId) }; await writeFile(receiptPath(input.root, input.taskId, input.id), `${JSON.stringify(receipt, null, 2)}\n`); return receipt; }
/**
 * Enforce the receipt at a workflow mutation boundary.  Packet verification is
 * deliberately usable before acknowledgement for inspection; mutation is not.
 */
export async function requireAcknowledgedContextPacket(input: { root: string; taskId: string; id: string; role: Role }): Promise<HandoffReceipt> {
  const packet = await readContextPacket(input.root, input.taskId, input.id);
  if (packet.to.role !== input.role) throw new Error(`Handoff role ${input.role} does not match packet recipient ${packet.to.role}.`);
  const verification = await verifyContextPacket({ root: input.root, taskId: input.taskId, id: input.id });
  if (!verification.valid) throw new Error(`Cannot use invalid handoff packet: ${verification.reason}`);
  const receipt = await readValidatedOptional<HandoffReceipt>('handoff-receipt', receiptPath(input.root, input.taskId, input.id));
  if (!receipt) throw new Error(`Workflow mutation requires an acknowledged receipt for handoff ${input.id}.`);
  if (receipt.taskId !== input.taskId || receipt.handoffId !== input.id || receipt.role !== input.role) {
    throw new Error(`Workflow mutation requires an acknowledged receipt for the expected ${input.role} role.`);
  }
  if (receipt.packetSha256 !== hashContent(JSON.stringify(packet))) {
    throw new Error(`Workflow mutation requires a current acknowledged receipt for handoff ${input.id}.`);
  }
  return receipt;
}
export async function verifyContextPacket(input: { root: string; taskId: string; id: string }): Promise<ContextPacketVerification> { const packet = await readContextPacket(input.root, input.taskId, input.id); const current = await anchor(input.root, input.taskId); if (packet.repository.branch !== current.branch) return { valid: false, reason: 'branch_mismatch' }; if (packet.repository.scope && !sameScopeIdentity(packet.repository.scope, current.scope!)) return { valid: false, reason: 'diff_mismatch' }; if (packet.repository.diffHash !== current.diffHash) return { valid: false, reason: 'diff_mismatch' }; try { const receipt = await readValidatedOptional<HandoffReceipt>('handoff-receipt', receiptPath(input.root, input.taskId, input.id)); if (receipt && receipt.packetSha256 !== hashContent(JSON.stringify(packet))) return { valid: false, reason: 'packet_hash_mismatch' }; } catch (error) { if (!isMissingFile(error)) throw error; } return { valid: true }; }
async function anchor(root: string, taskId: string): Promise<HandoffPacket['repository']> {
  const revision = await readCurrentTaskRevision(root, taskId);
  const scope = revision
    ? { kind: 'revision' as const, revisionId: revision.id, paths: revision.ownedPaths, hash: await computeManifestHash(root, revision.ownedPaths) }
    : { kind: 'task_context' as const, paths: taskContextPaths(root, taskId), hash: await computeManifestHash(root, taskContextPaths(root, taskId)) };
  return { head: currentGitHead(root), branch: currentGitBranch(root), diffHash: scope.hash, scope, worktreeRoot: '.' };
}

function existingReads(root: string, taskId: string, designRefs: string[]): string[] { return ['AGENTS.md', '.llmwiki/SCHEMA.md', '.llmwiki/index.md', '.llmwiki/log.md', `.kata/tasks/${taskId}/task.json`, `.kata/tasks/${taskId}/current-state.json`, ...designRefs].filter((path) => { try { return resolve(root, path).startsWith(resolve(root)); } catch { return false; } }); }
function designRefsFor(root: string, taskId: string, role: Role): string[] {
  if (role !== 'implementer' && role !== 'reviewer' && role !== 'judge') return [];

  const candidates = [
    `.kata/tasks/${taskId}/design.md`,
    `openspec/changes/${taskId}/design.md`,
  ];

  // 1) Structured upstream refs: task.json upstreamCoverage.sources[].ref +
  //    acceptanceMatrix.rows[].designRefs — these are the binding docs the task
  //    must satisfy (designs / audits / methodology). Reading them here is what
  //    feeds reviewer/judge the real requirements (previously a dead field).
  try {
    const { readFileSync } = require('node:fs') as typeof import('node:fs');
    const taskRaw = readFileSync(taskPath(root, taskId), 'utf8');
    const task = JSON.parse(taskRaw) as {
      upstreamCoverage?: { sources?: Array<{ ref?: string }> };
      acceptanceMatrix?: { rows?: Array<{ designRefs?: string[] }> };
    };
    for (const source of task.upstreamCoverage?.sources ?? []) {
      if (source.ref) candidates.push(source.ref);
    }
    for (const row of task.acceptanceMatrix?.rows ?? []) {
      for (const ref of row.designRefs ?? []) candidates.push(ref);
    }
  } catch {}

  // Comet design-phase Design Doc under docs/superpowers/specs/
  const specsDir = join(root, 'docs/superpowers/specs');
  try {
    const { readdirSync } = require('node:fs') as typeof import('node:fs');
    if (existsSync(specsDir)) {
      for (const entry of readdirSync(specsDir)) {
        if (entry.endsWith('-design.md')) candidates.push(`docs/superpowers/specs/${entry}`);
      }
    }
  } catch {}

  return candidates.filter((p) => existsSync(join(root, p)));
}
function taskContextPaths(root: string, taskId: string): string[] { const base = `.kata/tasks/${taskId}`; return [`${base}/task.json`, `${base}/current-state.json`, ...(existsSync(join(root, base, 'design.md')) ? [`${base}/design.md`] : [])]; }
/**
 * Whether two anchors cover the same content.
 *
 * Deliberately **not** the revision's id: a re-seal of unchanged owned paths produces the same content, and requiring a
 * matching id made every receipt expire the moment anything was sealed again — while requiring a matching HEAD made
 * them expire on any commit at all. Paths and their manifest hash are what the packet is actually about.
 */
function sameScopeIdentity(left: HandoffAnchorScope, right: HandoffAnchorScope): boolean {
  if (left.kind !== right.kind || left.paths.length !== right.paths.length) return false;
  if (left.hash !== right.hash) return false;
  return left.paths.every((path, index) => path === right.paths[index]);
}
function roleArtifacts(root: string, taskId: string): string[] { const base = `.kata/tasks/${taskId}`; return [`${base}/review.json`, `${base}/judge.json`, `${base}/repair.json`]; }
function allowedWrites(role: Role, taskId: string, root = process.cwd()): string[] {
  if (role === 'designer') return ['docs/', `.kata/tasks/${taskId}/`];
  if (role === 'implementer') return [existsSync(join(root, 'packages')) ? 'packages/' : 'src/', 'tests/', 'docs/'];
  return [`.kata/tasks/${taskId}/${role === 'reviewer' ? 'review.json' : role === 'judge' ? 'judge.json' : 'wiki/'}`];
}
async function writePacket(root: string, packet: HandoffPacket): Promise<void> { const directory = handoffDir(root, packet.taskId); await mkdir(directory, { recursive: true }); await writeFile(packetPath(root, packet.taskId, packet.id), `${JSON.stringify(packet, null, 2)}\n`); }
function packetPath(root: string, taskId: string, id: string): string { return handoffPacketPath(root, taskId, id); }
function receiptPath(root: string, taskId: string, id: string): string { return handoffReceiptPath(root, taskId, id); }

function safeId(id: string): void { if (!/^handoff-[a-z0-9-]{1,63}$/.test(id)) throw new Error('Invalid handoff id'); }
function safePlatform(platform: string): string { if (!/^[a-z][a-z0-9-]{0,63}$/.test(platform)) throw new Error('Invalid platform'); return platform; }
function assertRole(role: string): asserts role is Role { if (!['designer', 'implementer', 'reviewer', 'judge', 'distiller', 'approver'].includes(role)) throw new Error(`Invalid handoff role: ${role}`); }

function isMissingFile(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT';
}
