import { mkdir, mkdtemp, readFile, rm, rmdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initLayout } from '../../src/core/layout.js';
import { createTask } from '../../src/core/task.js';
import { createTaskRevision } from '../../src/workflow/revision.js';
import { defaultWorkflowProfile } from '../../src/core/workflow-profile.js';
import { createContextPacket, acknowledgeContextPacket, requireAcknowledgedContextPacket, verifyContextPacket } from '../../src/workflow/context-fabric.js';
import { createWorkflowHandoff } from '../../src/workflow/delegation-prompt.js';

describe('Context Fabric', () => {
  const roots: string[] = [];
  async function root(): Promise<string> {
    const value = await mkdtemp(join(tmpdir(), 'kata-context-'));
    roots.push(value);
    await initLayout(value);
    await createTask({ root: value, id: 'handoff-task', title: 'Portable handoff', acceptance: [{ id: 'AC-1', statement: 'A packet is portable.' }] });
    return value;
  }
  afterEach(async () => Promise.all(roots.splice(0).map((value) => rm(value, { recursive: true, force: true }))));

  it('creates, acknowledges, and verifies a same-worktree packet', async () => {
    const workspace = await root();
    const packet = await createContextPacket({ root: workspace, taskId: 'handoff-task', fromRole: 'implementer', toRole: 'reviewer', platform: 'opencode' });
    expect(packet.context.requiredReads).toContain('.kata/tasks/handoff-task/task.json');
    expect(packet.repository.worktreeRoot).toBe('.');
    const receipt = await acknowledgeContextPacket({ root: workspace, taskId: 'handoff-task', id: packet.id, platform: 'github-copilot', role: 'reviewer' });
    expect(receipt.packetSha256).toMatch(/^[a-f0-9]{64}$/);
    await expect(verifyContextPacket({ root: workspace, taskId: 'handoff-task', id: packet.id })).resolves.toMatchObject({ valid: true });
  });

  it('rejects acknowledgement by a role other than the packet recipient', async () => {
    const workspace = await root();
    const packet = await createContextPacket({ root: workspace, taskId: 'handoff-task', fromRole: 'implementer', toRole: 'reviewer' });

    await expect(acknowledgeContextPacket({
      root: workspace,
      taskId: 'handoff-task',
      id: packet.id,
      platform: 'codex',
      role: 'judge',
    })).rejects.toThrow('does not match packet recipient');
  });

  it('requires a current acknowledgement receipt from the expected receiving role', async () => {
    const workspace = await root();
    const packet = await createContextPacket({ root: workspace, taskId: 'handoff-task', fromRole: 'designer', toRole: 'implementer' });

    await expect(requireAcknowledgedContextPacket({ root: workspace, taskId: 'handoff-task', id: packet.id, role: 'implementer' }))
      .rejects.toThrow('acknowledged receipt');

    await acknowledgeContextPacket({ root: workspace, taskId: 'handoff-task', id: packet.id, platform: 'codex', role: 'implementer' });
    await expect(requireAcknowledgedContextPacket({ root: workspace, taskId: 'handoff-task', id: packet.id, role: 'implementer' }))
      .resolves.toMatchObject({ handoffId: packet.id, role: 'implementer' });
  });

  it('creates a platform-neutral workflow handoff for the receiving role', async () => {
    const workspace = await root();
    const handoff = await createWorkflowHandoff({ root: workspace, taskId: 'handoff-task', fromRole: 'designer', toRole: 'implementer' });

    expect(handoff.packet.from.platform).toBeUndefined();
    expect(handoff.packet.to).toEqual({ role: 'implementer' });
    expect(handoff.prompt).toContain('--platform <actual-platform>');
    expect(handoff.prompt).not.toContain('/kata-delegate');
  });

  it('binds a task design to implementer packets but not reviewer packets', async () => {
    const workspace = await root();
    const designPath = '.kata/tasks/handoff-task/design.md';
    await writeFile(join(workspace, designPath), '# Handoff design\n');

    const implementer = await createContextPacket({ root: workspace, taskId: 'handoff-task', fromRole: 'designer', toRole: 'implementer' });
    const reviewer = await createContextPacket({ root: workspace, taskId: 'handoff-task', fromRole: 'implementer', toRole: 'reviewer' });

    expect(implementer.context.requiredReads).toContain(designPath);
    expect(implementer.context.designRefs).toEqual([designPath]);
    expect(reviewer.context.requiredReads).not.toContain(designPath);
    expect(reviewer.context.designRefs).toEqual([]);
  });

  it('does not invent design references for a task without design.md', async () => {
    const workspace = await root();

    const packet = await createContextPacket({ root: workspace, taskId: 'handoff-task', fromRole: 'designer', toRole: 'implementer' });

    expect(packet.context.requiredReads).not.toContain('.kata/tasks/handoff-task/design.md');
    expect(packet.context.designRefs).toEqual([]);
  });

  it('rejects a revision-anchored packet after an owned path changes', async () => {
    const workspace = await root();
    await writeFile(join(workspace, 'owned.ts'), 'export const version = 1;\n');
    await createTaskRevision({ root: workspace, taskId: 'handoff-task', ownedPaths: ['owned.ts'] });
    const packet = await createContextPacket({ root: workspace, taskId: 'handoff-task', fromRole: 'implementer', toRole: 'reviewer' });
    await writeFile(join(workspace, 'owned.ts'), 'export const version = 2;\n');
    await expect(verifyContextPacket({ root: workspace, taskId: 'handoff-task', id: packet.id })).resolves.toMatchObject({ valid: false, reason: 'diff_mismatch' });
  });

  it('refuses to acknowledge a stale packet and does not write a receipt', async () => {
    const workspace = await root();
    await writeFile(join(workspace, 'owned.ts'), 'export const version = 1;\n');
    await createTaskRevision({ root: workspace, taskId: 'handoff-task', ownedPaths: ['owned.ts'] });
    const packet = await createContextPacket({ root: workspace, taskId: 'handoff-task', fromRole: 'implementer', toRole: 'reviewer' });
    await writeFile(join(workspace, 'owned.ts'), 'export const version = 2;\n');

    await expect(acknowledgeContextPacket({
      root: workspace,
      taskId: 'handoff-task',
      id: packet.id,
      platform: 'github-copilot',
      role: 'reviewer',
    })).rejects.toThrow(/Cannot acknowledge invalid handoff packet: diff_mismatch/);
    await expect(readFile(join(workspace, '.kata/tasks/handoff-task/handoffs', `${packet.id}.receipt.json`), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects a task-context packet after its task metadata changes', async () => {
    const workspace = await root();
    const packet = await createContextPacket({ root: workspace, taskId: 'handoff-task', fromRole: 'designer', toRole: 'implementer' });

    await writeFile(join(workspace, '.kata/tasks/handoff-task/task.json'), '{"title":"changed"}\n');

    await expect(verifyContextPacket({ root: workspace, taskId: 'handoff-task', id: packet.id })).resolves.toMatchObject({ valid: false, reason: 'diff_mismatch' });
  });

  it('keeps a packet valid when platform runtime files change', async () => {
    const workspace = await root();
    const packet = await createContextPacket({ root: workspace, taskId: 'handoff-task', fromRole: 'implementer', toRole: 'reviewer', platform: 'opencode' });

    await mkdir(join(workspace, '.opencode'), { recursive: true });
    await writeFile(join(workspace, '.opencode/session.json'), '{"active":true}\n', { flag: 'w' });

    await expect(verifyContextPacket({ root: workspace, taskId: 'handoff-task', id: packet.id })).resolves.toMatchObject({ valid: true });
  });

  it('keeps a revision-anchored packet valid when files outside its owned paths change', async () => {
    const workspace = await root();
    await writeFile(join(workspace, 'owned.ts'), 'export const version = 1;\n');
    await createTaskRevision({ root: workspace, taskId: 'handoff-task', ownedPaths: ['owned.ts'] });
    const packet = await createContextPacket({ root: workspace, taskId: 'handoff-task', fromRole: 'implementer', toRole: 'reviewer' });

    await mkdir(join(workspace, '.codegraph'), { recursive: true });
    await writeFile(join(workspace, '.codegraph', 'codegraph.db'), 'runtime index update\n');

    await expect(verifyContextPacket({ root: workspace, taskId: 'handoff-task', id: packet.id })).resolves.toMatchObject({ valid: true });
  });

  it('rejects a revision-anchored packet after the task seals a new revision', async () => {
    const workspace = await root();
    await writeFile(join(workspace, 'owned.ts'), 'export const version = 1;\n');
    await createTaskRevision({ root: workspace, taskId: 'handoff-task', ownedPaths: ['owned.ts'] });
    const packet = await createContextPacket({ root: workspace, taskId: 'handoff-task', fromRole: 'implementer', toRole: 'reviewer' });

    await createTaskRevision({ root: workspace, taskId: 'handoff-task', ownedPaths: ['owned.ts'] });

    await expect(verifyContextPacket({ root: workspace, taskId: 'handoff-task', id: packet.id })).resolves.toMatchObject({ valid: false, reason: 'diff_mismatch' });
  });

  it('creates a packet when the optional governed wiki directory is absent', async () => {
    const workspace = await root();
    await rmdir(join(workspace, '.kata/wiki'));
    await expect(createContextPacket({ root: workspace, taskId: 'handoff-task', fromRole: 'implementer', toRole: 'reviewer' })).resolves.toMatchObject({ taskId: 'handoff-task' });
  });

  it('carries the active Git Flow branch into cross-platform guard instructions', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'kata-context-git-flow-'));
    roots.push(workspace);
    await initLayout(workspace);
    await createTask({
      root: workspace,
      id: 'git-flow-task',
      title: 'Git Flow handoff',
      acceptance: [{ id: 'AC-1', statement: 'Stay on the selected feature branch.' }],
      workflowProfile: {
        ...defaultWorkflowProfile(),
        isolationMode: 'git_flow',
        gitFlow: { strategy: 'manual', branch: 'feature/git-flow-task', baseBranch: 'develop', status: 'active' },
      },
    });

    const packet = await createContextPacket({ root: workspace, taskId: 'git-flow-task', fromRole: 'designer', toRole: 'implementer' });
    expect(packet.permissions.guardInstructions).toContain('Work on feature/git-flow-task; do not start, finish, or switch Git Flow branches outside the recorded task action.');
  });
});
