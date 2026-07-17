import { createContextPacket, type HandoffPacket } from './context-fabric.js';

export async function createWorkflowHandoff(input: {
  root: string;
  taskId: string;
  fromRole: 'designer' | 'implementer' | 'reviewer' | 'judge' | 'distiller';
  toRole: 'designer' | 'implementer' | 'reviewer' | 'judge' | 'distiller';
}): Promise<{ packet: HandoffPacket; prompt: string }> {
  const packet = await createContextPacket(input);
  return {
    packet,
    prompt: renderDelegationPrompt(input.taskId, packet.id, '<actual-platform>', input.toRole, packet.context.designRefs),
  };
}

export function renderDelegationPrompt(taskId: string, handoffId: string, platform: string, role: string, designRefs: string[] = []): string {
  const designGuidance = role === 'implementer' && designRefs.length > 0
    ? ['', '绑定设计引用（必须先阅读）：', ...designRefs.map((path) => `- ${path}`)]
    : [];
  const implementationGuidance = role === 'implementer'
    ? [
        '',
        `先进入实施阶段（此时不要 seal）：/kata-build ${taskId}`,
        `CLI fallback：kata build --change ${taskId}`,
        '收到实施阶段的 TDD 合同后，再开始阅读、测试与编码。',
        '',
        '实施顺序：先阅读设计引用和 requiredReads，先写聚焦的失败测试（RED），再最小实现并运行聚焦 GREEN。',
        '不要在编码前封存 build 证据。实现和聚焦测试完成后，再执行：',
        `kata build --change ${taskId} --seal`,
      ]
    : [];

  return [
    `请使用 Kata 接手任务：${taskId}`,
    '',
    `Role: ${role}`,
    'Platform: choose the receiving host platform.',
    `Handoff: ${handoffId}`,
    '',
    '先执行：',
    '',
    `kata handoff verify --task ${taskId} --id ${handoffId}`,
    `kata handoff show --task ${taskId} --id ${handoffId}`,
    `kata handoff acknowledge --task ${taskId} --id ${handoffId} --platform <actual-platform> --role ${role}`,
    '',
    '然后读取 packet.requiredReads 中的所有文件，遵守 allowedWrites 和 guardInstructions，运行匹配的 /kata-* skill。',
    ...designGuidance,
    '接收方可在任意已识别平台接手，并使用该平台自己的模型选择器或配置；Kata 不配置、不路由也不记录宿主模型。',
    ...implementationGuidance,
    '不要执行超出委托角色的后续阶段。',
  ].join('\n');
}
