import { describe, expect, it } from 'vitest';
import { commandManifest, platformCapabilities, renderSkill, skillCommands, type Platform } from '../../src/adapters/manifest.js';
import { renderSkill as renderCodexSkill } from '../../src/adapters/codex.js';
import { renderSkill as renderClaudeCodeSkill } from '../../src/adapters/claude-code.js';
import { renderSkill as renderOpenCodeSkill } from '../../src/adapters/opencode.js';
import { renderSkill as renderGenericSkill } from '../../src/adapters/generic.js';
import { platformDefinitions } from '../../src/adapters/platforms.js';

const renderers: Partial<Record<Platform, (command: (typeof skillCommands)[number], platform: Platform) => string>> = {
  codex: renderCodexSkill,
  'claude-code': renderClaudeCodeSkill,
  opencode: renderOpenCodeSkill,
  generic: renderGenericSkill,
};
const platforms = platformDefinitions.map((platform) => platform.id);

describe('platform adapter golden output', () => {
  it('declares OpenCode subagent capability consistently for generated skills', () => {
    expect(platformCapabilities.opencode).toEqual({
      skills: true,
      hooks: false,
      subAgents: true,
      modelSelection: true,
    });
  });

  it('renders the same normalized command manifest for every first-release platform', () => {
    for (const platform of platforms) {
      const renderSkill = renderers[platform] ?? renderGenericSkill;
      const renderedManifest = skillCommands.map((command) => extractManifest(renderSkill(command, platform)));

      expect(renderedManifest, platform).toEqual(commandManifest);
    }
  });

  it('renders every /kata-* skill with CLI invocation, orient checklist, and guard enforcement', () => {
    for (const platform of platforms) {
      const renderSkill = renderers[platform] ?? renderGenericSkill;
      for (const command of skillCommands) {
        const rendered = renderSkill(command, platform);

        expect(rendered).toContain(command.slashCommand);
        expect(rendered).toContain(command.cli);
        expect(rendered).toContain(`platform: ${platform}`);
        expect(rendered).toContain('guard enforcement');
        expect(rendered).toContain('## Trigger scenarios');
        expect(rendered).toContain('## Input signals');
        expect(rendered).toContain('## Output goals');
        expect(rendered).toContain('Use when');
        expect(rendered).toContain('Startup checklist');
        expect(rendered).toContain('Skill-first operating rule');
        expect(rendered).toContain('Prefer the `');
        expect(rendered).toContain('as the human-facing interface');
        expect(rendered).toContain('kata orient --role');
        expect(rendered).toContain('task, state, context');
        expect(rendered).toContain('interactive agent workflow');
        expect(rendered).toContain('ask the user to confirm or type a value');
        expect(rendered).toContain('Do not make the user remember command-line flags');
        expect(rendered).toContain('kata hooks activate --change');
        expect(rendered).toContain('Host model selection');
        expect(rendered).toContain('Kata does not configure or route host-platform models');
        if (platform === 'opencode') expect(rendered).toContain('`/models`');
        expect(rendered).toContain('CodeGraph-assisted code search');
        expect(rendered).toContain('kata codegraph explore');
        expect(rendered).toContain('kata codegraph impact');
        expect(rendered).toContain('kata codegraph affected');
        expect(rendered).toContain('nextAction.requiresUserConfirmation=true');
        expect(rendered).toContain("host platform's own model selector");
        expect(rendered).toContain('Kata has no model routing configuration or route artifact');

        if (['kata-build', 'kata-review', 'kata-judge', 'kata-verify', 'kata-archive'].includes(command.id)) {
          expect(rendered).toContain('Skill automation contract');
          expect(rendered).toContain('The Skill MUST run these commands itself');
          expect(rendered).toContain('task title, acceptance criteria, and context summary');
          expect(rendered).toContain('slash command is the agent interface');
          if (command.id === 'kata-build') {
            expect(rendered).toContain('先完成 TDD 与聚焦测试');
            expect(rendered).toContain('--seal');
            expect(rendered).toContain('不要在编码前封存证据');
          }
          if (command.id === 'kata-verify') {
            expect(rendered).toContain('Wiki closure is a governance action, not an implementation repair');
            expect(rendered).toContain('Only ask the user when the task artifacts are genuinely ambiguous');
            expect(rendered).toContain('implementationReady: true');
            expect(rendered).toContain('kata wiki closure --task <taskId>');
          }
          expect(rendered).toContain('active task, same-branch task, relation redirects');
          expect(rendered).toContain('present concise options');
          expect(rendered).toContain('kata handoff verify');
          expect(rendered).toContain('kata handoff acknowledge');
          expect(rendered).toContain('Always tell the user the current phase and the next recommended operation');
          expect(rendered).toContain('completion.userMessage');
          expect(rendered).toContain('never wait for the user to ask “what next”');
          expect(rendered).toContain('nextAction.slashCommand');
          expect(rendered).toContain("Stop after this Skill's own phase command");
        }

        if (command.id === 'kata-collect') {
          expect(rendered).toContain('Interactive collection');
          expect(rendered).toContain('Discover the likely returned task');
          expect(rendered).toContain('ready-to-send prompt for the delegated platform');
        }

        if (command.id === 'kata-wiki-enrich') {
          expect(rendered).toContain('coding agent');
          expect(rendered).toContain('kata wiki task --kind enrich');
          expect(rendered).toContain('kata wiki lint');
          expect(rendered).toContain('Do not guess Wiki CLI subcommands');
          expect(rendered).toContain('kata wiki --help');
        }

        if (command.id === 'kata-archive') {
          expect(rendered).toContain('Knowledge distillation');
        }
      }
    }
  });

  it('includes wiki enrichment but no explicit delegation skill in the normalized command manifest', () => {
    expect(commandManifest).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'kata-wiki-enrich',
          slashCommand: '/kata-wiki-enrich',
          cli: 'kata wiki task --kind enrich',
        }),
        expect.objectContaining({
          id: 'kata-collect',
          slashCommand: '/kata-collect',
          cli: 'kata collect',
        }),
      ]),
    );
    expect(commandManifest.map((command) => String(command.id))).not.toContain('kata-delegate');
  });

  it('requires workflow-profile confirmation in every task-opening skill', () => {
    for (const id of ['kata-open', 'kata-hotfix', 'kata-tweak']) {
      const command = skillCommands.find((candidate) => candidate.id === id)!;
      const rendered = renderCodexSkill(command, 'codex');

      expect(command.cli).toContain('--isolation <mode> --development <mode> --review <mode>');
      expect(rendered).toContain('## Skill-level workflow profile decision');
      expect(rendered).toContain('Never let non-interactive CLI defaults silently choose the workflow profile.');
    }
  });

  it('routes hard verification to verify and reviewer phase to judge in dispatch skills', () => {
    const rendered = renderCodexSkill(skillCommands.find((command) => command.id === 'kata')!, 'codex');

    expect(rendered).toContain('| `hardVerify` | `/kata-verify` |');
    expect(rendered).toContain('| `review` | `/kata-judge` |');
    expect(rendered).toContain('Workflow control is task-scoped');
    expect(rendered).toContain('kata tasks relate --from <source-task> --to <target-task>');
    expect(rendered).toContain('kata relations add --from change:<change-id> --to task:<task-id>');
    expect(rendered).toContain('relationRedirects');
    expect(rendered).toContain('kata <design|build|review|judge|verify|archive|hotfix|tweak> --change <change-id>');
    expect(rendered).toContain('当前分支没有活跃的 Kata 任务。你想开启什么工作？');
    expect(rendered).toContain('请用一句话描述目标');
    expect(rendered).toContain('收到自然语言目标后，进入 /kata-open');
  });

  it('can render skills with a mandatory Chinese response language contract', () => {
    const rendered = renderSkill(skillCommands.find((command) => command.id === 'kata-build')!, 'codex', { language: 'zh' });

    expect(rendered).toContain('Response language');
    expect(rendered).toContain('所有面向用户的自然语言响应必须使用中文');
  });
});

function extractManifest(rendered: string): unknown {
  const match = rendered.match(/```json kata-command-manifest\n(?<json>[\s\S]*?)\n```/);
  if (!match?.groups?.json) throw new Error(`missing normalized command manifest in:\n${rendered}`);
  return JSON.parse(match.groups.json) as unknown;
}
