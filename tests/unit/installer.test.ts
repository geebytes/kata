import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { execFileSync, spawn } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { discoverPlatforms, identifyPlatformInstallState, install, uninstall, update } from '../../src/adapters/discovery.js';
import { listManagedPlatforms } from '../../src/adapters/ownership.js';
import { skillCommands } from '../../src/adapters/manifest.js';
import { main, roleForPhase } from '../../src/cli.js';
import { initLayout } from '../../src/core/layout.js';
import { createTask } from '../../src/core/task.js';
import { transition } from '../../src/core/state.js';
import { planDetectedInit, renderInitBanner } from '../../src/init-wizard.js';

describe('Kata platform installer', () => {
  const roots: string[] = [];

  async function tempRoot(prefix = 'kata-installer-'): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), prefix));
    roots.push(root);
    return root;
  }

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it('keeps review work owned by the reviewer before the Judge gate', () => {
    expect(roleForPhase('review')).toBe('reviewer');
    expect(roleForPhase('judge')).toBe('judge');
  });

  it('treats workflow --help as a read-only query instead of executing the command', async () => {
    const root = await tempRoot();
    const task = await createTask({
      root,
      id: 'workflow-help',
      title: 'Workflow help has no side effects',
      acceptance: [{ id: 'AC-1', statement: 'Help never changes phase.' }],
    });
    await transition(task.id, 'plan', { id: 'designer', role: 'designer' }, { root });

    await captureJsonOutput(() => main(['build', task.id, '--help', '--root', root]));

    const state = JSON.parse(await readFile(join(root, `.kata/tasks/${task.id}/current-state.json`), 'utf8')) as { phase: string };
    expect(state.phase).toBe('plan');
  });

  it('discovers project and global platform capabilities with generic fallback', async () => {
    const root = await tempRoot();
    const home = await tempRoot('kata-home-');
    await writeFile(join(root, 'AGENTS.md'), '# repo instructions\n');
    await writeFile(join(root, 'opencode.json'), '{}\n');
    await mkdir(join(root, '.cursor'), { recursive: true });
    await mkdir(join(root, '.windsurf'), { recursive: true });
    await mkdir(join(root, '.clinerules'), { recursive: true });
    await mkdir(join(root, '.roo'), { recursive: true });
    await mkdir(join(root, '.gemini'), { recursive: true });
    await mkdir(join(root, '.github'), { recursive: true });
    await writeFile(join(root, '.github', 'copilot-instructions.md'), '# Copilot\n');
    await writeFile(join(home, '.claude.json'), '{}\n');

    const platforms = await discoverPlatforms({ root, home });

    expect(platforms).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ platform: 'codex', scope: 'project', capabilities: expect.objectContaining({ skills: true }) }),
        expect.objectContaining({ platform: 'claude-code', scope: 'global', capabilities: expect.objectContaining({ skills: true }) }),
        expect.objectContaining({
          platform: 'opencode',
          scope: 'project',
          capabilities: expect.objectContaining({ skills: true, hooks: false, subAgents: true, modelSelection: true }),
          unavailable: expect.not.arrayContaining(['subAgents']),
        }),
        expect.objectContaining({ platform: 'cursor', scope: 'project', capabilities: expect.objectContaining({ skills: true }) }),
        expect.objectContaining({ platform: 'windsurf', scope: 'project', capabilities: expect.objectContaining({ hooks: true }) }),
        expect.objectContaining({ platform: 'cline', scope: 'project', capabilities: expect.objectContaining({ skills: true }) }),
        expect.objectContaining({ platform: 'roocode', scope: 'project', capabilities: expect.objectContaining({ skills: true }) }),
        expect.objectContaining({ platform: 'gemini', scope: 'project', capabilities: expect.objectContaining({ hooks: true }) }),
        expect.objectContaining({ platform: 'github-copilot', scope: 'project', capabilities: expect.objectContaining({ skills: true }) }),
        expect.objectContaining({ platform: 'generic', scope: 'project', capabilities: expect.objectContaining({ hooks: false }) }),
      ]),
    );
  });

  it('plans init from detected coding platforms like the interactive wizard', async () => {
    const root = await tempRoot();
    const home = await tempRoot('kata-home-');
    await writeFile(join(root, 'AGENTS.md'), '# repo instructions\n');
    await writeFile(join(root, 'opencode.json'), '{}\n');
    await mkdir(join(home, '.claude'), { recursive: true });

    const platforms = await discoverPlatforms({ root, home });
    const plan = planDetectedInit(platforms, { scope: 'project' });

    expect(plan.selected).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ platform: 'codex', scope: 'project', detected: true }),
        expect.objectContaining({ platform: 'opencode', scope: 'project', detected: true }),
      ]),
    );
    expect(plan.selected).not.toEqual(expect.arrayContaining([expect.objectContaining({ platform: 'generic' })]));
    expect(renderInitBanner()).toContain('STRATA');
  });

  it('rejects bare non-interactive init without writing the generic installation', async () => {
    const root = await tempRoot();

    await expect(main(['init', '--root', root])).rejects.toThrow('requires explicit --platform and --scope');
    await expect(stat(join(root, '.kata-config.json'))).rejects.toThrow();
    await expect(stat(join(root, 'AGENTS.md'))).rejects.toThrow();
  });

  it('CLI init --yes installs all detected project platforms and reports a wizard plan', async () => {
    const root = await tempRoot();
    await writeFile(join(root, 'AGENTS.md'), '# repo instructions\n');
    await writeFile(join(root, 'opencode.json'), '{}\n');

    const result = await captureJsonOutput(() => main(['init', '--yes', '--json', '--root', root, '--no-wiki']));

    expect(result).toMatchObject({
      command: 'init',
      mode: 'auto',
      cometInit: {
        command: 'comet init',
        status: 'deferred',
        nextCommand: expect.stringContaining('comet init'),
      },
      selectedPlatforms: expect.arrayContaining(['codex', 'opencode']),
      codegraph: {
        status: 'deferred',
        nextCommand: 'kata codegraph install --yes',
      },
    });
    await expect(readFile(join(root, '.codex/skills/kata/SKILL.md'), 'utf8')).resolves.toContain('/kata');
    await expect(readFile(join(root, '.codex/skills/kata/SKILL.md'), 'utf8')).resolves.toContain('所有面向用户的自然语言响应必须使用中文');
    await expect(readFile(join(root, '.opencode/skills/kata/SKILL.md'), 'utf8')).resolves.toContain('/kata');
    await expect(readFile(join(root, '.opencode/commands/kata-open.md'), 'utf8')).resolves.toContain('所有面向用户的自然语言响应必须使用中文');
    await expect(readFile(join(root, '.opencode/commands/kata-open.md'), 'utf8')).resolves.toContain('$ARGUMENTS');
  });

  it('installs project skills and records ownership hashes', async () => {
    const root = await tempRoot();

    const report = await install('codex', 'project', { root });

    expect(report.conflicts).toEqual([]);
    expect(report.written).toEqual(expect.arrayContaining(['AGENTS.md', '.kata/skills-index.md']));
    for (const command of skillCommands) {
      await expect(readFile(join(root, '.codex/skills', command.id, 'SKILL.md'), 'utf8')).resolves.toContain(
        command.slashCommand,
      );
    }
    await expect(readFile(join(root, 'AGENTS.md'), 'utf8')).resolves.toContain('Kata Agent Contract');
    await expect(readFile(join(root, '.kata/skills-index.md'), 'utf8')).resolves.toContain('/kata-open');
    await expect(readFile(join(root, '.codex/rules/kata-agent-contract.md'), 'utf8')).resolves.toContain(
      'Wiki helps agents',
    );
    await expect(readFile(join(root, '.codex/rules/kata-agent-contract.md'), 'utf8')).resolves.toContain(
      'Development constraint: skill-first',
    );
    await expect(readFile(join(root, '.kata/adapters/manifest.json'), 'utf8')).resolves.toContain(
      '"platform": "codex"',
    );
  });

  it('installs platform-specific commands and rule formats like Comet adapters', async () => {
    const root = await tempRoot();

    const openCode = await install('opencode', 'project', { root });
    expect(openCode.written).toEqual(expect.arrayContaining(['.opencode/commands/kata-open.md']));
    await expect(readFile(join(root, '.opencode/commands/kata-open.md'), 'utf8')).resolves.toContain(
      'Equivalent Kata skill: `kata-open`',
    );
    await expect(readFile(join(root, '.opencode/commands/kata-open.md'), 'utf8')).resolves.toContain(
      '$ARGUMENTS',
    );

    const cursor = await install('cursor', 'project', { root });
    expect(cursor.written).toEqual(expect.arrayContaining(['.cursor/rules/kata-agent-contract.mdc']));
    await expect(readFile(join(root, '.cursor/rules/kata-agent-contract.mdc'), 'utf8')).resolves.toContain(
      'alwaysApply: true',
    );
    await expect(readFile(join(root, '.cursor/rules/kata-agent-contract.mdc'), 'utf8')).resolves.toContain(
      'Development constraint: skill-first',
    );

    const copilot = await install('github-copilot', 'project', { root });
    expect(copilot.written).toEqual(
      expect.arrayContaining(['.github/instructions/kata-agent-contract.instructions.md']),
    );
    await expect(
      readFile(join(root, '.github/instructions/kata-agent-contract.instructions.md'), 'utf8'),
    ).resolves.toContain('applyTo: "**"');
    await expect(
      readFile(join(root, '.github/instructions/kata-agent-contract.instructions.md'), 'utf8'),
    ).resolves.toContain('Development constraint: skill-first');
  });

  it('routes explicit registry platforms through the CLI installer', async () => {
    const root = await tempRoot();

    const result = await captureJsonOutput(() =>
      main(['init', '--json', '--platform', 'cursor', '--scope', 'project', '--root', root, '--no-wiki']),
    );

    expect(result.platform).toBe('cursor');
    await expect(readFile(join(root, '.cursor/skills/kata/SKILL.md'), 'utf8')).resolves.toContain('/kata');
    await expect(readFile(join(root, '.cursor/rules/kata-agent-contract.mdc'), 'utf8')).resolves.toContain(
      'alwaysApply: true',
    );
  });

  it('doctors platform installs and reports missing managed artifacts', async () => {
    const root = await tempRoot();
    await mkdir(join(root, 'docs'), { recursive: true });
    await writeFile(join(root, 'docs', 'guide.md'), '# Guide\n', 'utf8');
    await install('codex', 'project', { root });

    const healthy = await captureJsonOutput(() =>
      main(['doctor', '--platform', 'codex', '--scope', 'project', '--root', root]),
    );

    expect(healthy).toMatchObject({
      command: 'doctor',
      platform: 'codex',
      ok: true,
      summary: expect.objectContaining({ missing: 0, conflicts: 0 }),
    });
    expect(healthy.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: '.codex/hooks/kata-hook-guard.mjs', status: 'ok' }),
        expect.objectContaining({ path: '.codex/settings.local.json', status: 'ok' }),
        expect.objectContaining({ path: '.llmwiki', status: 'ok' }),
      ]),
    );

    await rm(join(root, '.codex/hooks/kata-hook-guard.mjs'));
    const broken = await captureJsonOutput(() =>
      main(['doctor', '--platform', 'codex', '--scope', 'project', '--root', root]),
    );

    expect(broken).toMatchObject({
      command: 'doctor',
      platform: 'codex',
      ok: false,
      summary: expect.objectContaining({ missing: 1 }),
    });
    expect(broken.checks).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: '.codex/hooks/kata-hook-guard.mjs', status: 'missing' })]),
    );
  });

  it('doctors all detected project platforms when no platform is specified', async () => {
    const root = await tempRoot();
    await writeFile(join(root, 'AGENTS.md'), '# Repo\n');
    await writeFile(join(root, 'opencode.json'), '{}\n');
    await mkdir(join(root, 'docs'), { recursive: true });
    await writeFile(join(root, 'docs', 'guide.md'), '# Guide\n', 'utf8');
    await install('codex', 'project', { root });
    await install('opencode', 'project', { root });

    const result = await captureJsonOutput(() => main(['doctor', '--root', root]));

    expect(result).toMatchObject({
      command: 'doctor',
      mode: 'aggregate',
      ok: true,
      reports: expect.arrayContaining([
        expect.objectContaining({ platform: 'codex', ok: true }),
        expect.objectContaining({ platform: 'opencode', ok: true }),
      ]),
    });
    expect(result.reports).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          platform: 'opencode',
          checks: expect.arrayContaining([
            expect.objectContaining({ path: '.opencode/commands/kata-open.md', status: 'ok' }),
          ]),
        }),
      ]),
    );
  });

  it('installs and safely uninstalls managed hook entries without removing user hooks', async () => {
    const root = await tempRoot();
    await mkdir(join(root, '.codex'), { recursive: true });
    await writeFile(
      join(root, '.codex/settings.local.json'),
      `${JSON.stringify(
        {
          hooks: {
            PreToolUse: [
              {
                matcher: 'Write',
                hooks: [{ type: 'command', command: 'node ./user-hook.mjs' }],
              },
            ],
          },
        },
        null,
        2,
      )}\n`,
    );

    const report = await install('codex', 'project', { root });

    expect(report.written).toEqual(
      expect.arrayContaining(['.codex/hooks/kata-hook-guard.mjs', '.codex/settings.local.json']),
    );
    const settings = JSON.parse(await readFile(join(root, '.codex/settings.local.json'), 'utf8')) as {
      hooks: { PreToolUse: Array<{ hooks: Array<{ command: string }> }> };
    };
    const commands = settings.hooks.PreToolUse.flatMap((group) => group.hooks.map((hook) => hook.command));
    expect(commands).toEqual(expect.arrayContaining(['node ./user-hook.mjs']));
    expect(commands.some((command) => command.includes('kata-hook-guard.mjs'))).toBe(true);

    const removed = await uninstall('codex', 'project', { root });

    expect(removed.removed).toEqual(expect.arrayContaining(['.codex/hooks/kata-hook-guard.mjs', '.codex/settings.local.json']));
    const after = JSON.parse(await readFile(join(root, '.codex/settings.local.json'), 'utf8')) as {
      hooks: { PreToolUse: Array<{ hooks: Array<{ command: string }> }> };
    };
    const afterCommands = after.hooks.PreToolUse.flatMap((group) => group.hooks.map((hook) => hook.command));
    expect(afterCommands).toEqual(['node ./user-hook.mjs']);
  });

  it('installs hook configuration in Gemini, Windsurf, and Copilot platform formats', async () => {
    const root = await tempRoot();

    await install('gemini', 'project', { root });
    const gemini = JSON.parse(await readFile(join(root, '.gemini/settings.json'), 'utf8')) as {
      hooks: { BeforeTool: Array<{ matcher: string }> };
    };
    expect(gemini.hooks.BeforeTool[0]?.matcher).toBe('write_file|edit_file');

    await install('windsurf', 'project', { root });
    const windsurf = JSON.parse(await readFile(join(root, '.windsurf/hooks.json'), 'utf8')) as {
      hooks: { pre_write_code: Array<{ command: string }> };
    };
    expect(windsurf.hooks.pre_write_code[0]?.command).toContain('kata-hook-guard.mjs');

    await install('github-copilot', 'project', { root });
    const copilot = JSON.parse(await readFile(join(root, '.github/hooks/kata-guard.json'), 'utf8')) as {
      hooks: { preToolUse: Array<{ bash: string; powershell: string }> };
    };
    expect(copilot.hooks.preToolUse[0]?.bash).toContain('kata-hook-guard.mjs');
    expect(copilot.hooks.preToolUse[0]?.powershell).toContain('kata-hook-guard.mjs');
    await expect(
      identifyPlatformInstallState({ platform: 'github-copilot', scope: 'project', detected: true, root, capabilities: { skills: true, hooks: true, subAgents: true, modelSelection: true }, unavailable: [] }),
    ).resolves.toMatchObject({
      components: { hooks: 'current' },
    });
  });

  it('activates a task for hook guards and blocks writes outside the active role/phase scope', async () => {
    const root = await tempRoot();
    await install('codex', 'project', { root });
    await createTask({
      root,
      id: 'hook-task',
      title: 'Guard writes',
      acceptance: [{ id: 'AC-1', statement: 'Hook guard blocks unsafe writes.' }],
    });

    const activated = await captureJsonOutput(() =>
      main(['hooks', 'activate', '--change', 'hook-task', '--role', 'implementer', '--root', root]),
    );
    expect(activated).toMatchObject({
      command: 'hooks activate',
      taskId: 'hook-task',
      role: 'implementer',
      phase: 'intake',
      active: true,
    });

    const script = join(root, '.codex/hooks/kata-hook-guard.mjs');
    const blocked = await runHook(script, root, { tool_input: { file_path: 'src/core/task.ts' } });
    expect(blocked.exitCode).toBe(2);
    expect(blocked.stderr).toContain('phase_scope_violation');

    await writeFile(
      join(root, '.kata/tasks/hook-task/current-state.json'),
      `${JSON.stringify(
        {
          taskId: 'hook-task',
          phase: 'implement',
          actor: { id: 'system', role: 'system' },
          updatedAt: new Date().toISOString(),
        },
        null,
        2,
      )}\n`,
    );

    const allowed = await runHook(script, root, { tool_input: { file_path: 'src/core/task.ts' } });
    expect(allowed.exitCode).toBe(0);

    const protectedWrite = await runHook(script, root, {
      tool_input: { file_path: 'docs/superpowers/rules/verified.md' },
    });
    expect(protectedWrite.exitCode).toBe(2);
    expect(protectedWrite.stderr).toContain('protected_rules_or_verified_wiki');

    const deactivated = await captureJsonOutput(() => main(['hooks', 'deactivate', '--root', root]));
    expect(deactivated).toMatchObject({ command: 'hooks deactivate', active: false });

    const inactiveAllowed = await runHook(script, root, {
      tool_input: { file_path: 'docs/superpowers/rules/verified.md' },
    });
    expect(inactiveAllowed.exitCode).toBe(0);
  });

  it('records active task branch and platform for same-branch skill resume', async () => {
    const root = await tempRoot();
    execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
    await initLayout(root);
    await createTask({
      root,
      id: 'active-task',
      title: 'Active task',
      acceptance: [{ id: 'AC-1', statement: 'Active task can be resumed by skills.' }],
    });

    const activated = await captureJsonOutput(() =>
      main(['hooks', 'activate', '--change', 'active-task', '--role', 'implementer', '--platform', 'opencode', '--root', root]),
    );

    expect(activated).toMatchObject({
      command: 'hooks activate',
      taskId: 'active-task',
      role: 'implementer',
      phase: 'intake',
      platform: 'opencode',
      active: true,
    });
    expect(activated.branch).toEqual(expect.any(String));
  });

  it('activates the receiving task when a handoff is acknowledged', async () => {
    const root = await tempRoot();
    execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
    await initLayout(root);
    await createTask({
      root,
      id: 'handoff-active-task',
      title: 'Handoff active task',
      acceptance: [{ id: 'AC-1', statement: 'Acknowledged handoff becomes active.' }],
    });

    const create = await captureJsonOutput(() =>
      main(['handoff', 'create', '--task', 'handoff-active-task', '--from', 'reviewer', '--to', 'implementer', '--platform', 'codex', '--root', root]),
    );
    const id = String(create.id);

    const ack = await captureJsonOutput(() =>
      main(['handoff', 'acknowledge', '--task', 'handoff-active-task', '--id', id, '--platform', 'opencode', '--role', 'implementer', '--root', root]),
    );

    expect(ack).toMatchObject({
      command: 'handoff acknowledge',
      activeTask: expect.objectContaining({
        taskId: 'handoff-active-task',
        role: 'implementer',
        platform: 'opencode',
        active: true,
      }),
    });

    const previousCwd = process.cwd();
    process.chdir(root);
    try {
      const status = await captureJsonOutput(() => main(['status']));
      expect(status).toMatchObject({
        command: 'status',
        taskId: 'handoff-active-task',
        active: true,
        platform: 'opencode',
        activeRole: 'implementer',
      });
    } finally {
      process.chdir(previousCwd);
    }
  });

  it('auto-activates the only unfinished same-branch task discovered by status', async () => {
    const root = await tempRoot();
    execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
    await initLayout(root);
    await createTask({
      root,
      id: 'single-unfinished-task',
      title: 'Single unfinished task',
      acceptance: [{ id: 'AC-1', statement: 'Single task becomes active.' }],
    });

    const previousCwd = process.cwd();
    process.chdir(root);
    try {
      const status = await captureJsonOutput(() => main(['status']));
      expect(status).toMatchObject({
        command: 'status',
        taskId: 'single-unfinished-task',
        autoActivated: true,
        active: true,
        activeRole: 'designer',
      });

      const hooks = await captureJsonOutput(() => main(['hooks', 'status']));
      expect(hooks).toMatchObject({
        command: 'hooks status',
        active: true,
        taskId: 'single-unfinished-task',
        role: 'designer',
      });
    } finally {
      process.chdir(previousCwd);
    }
  });

  it('supports dry-run installation without writing files', async () => {
    const root = await tempRoot();

    const report = await install('codex', 'project', { root, dryRun: true });

    expect(report.planned).toEqual(
      expect.arrayContaining(['.codex/rules/kata-agent-contract.md', ...skillCommands.map((command) => `.codex/skills/${command.id}/SKILL.md`)]),
    );
    expect(report.written).toEqual([]);
    await expect(stat(join(root, '.codex'))).rejects.toThrow();
  });

  it('installs response language constraints into skills and project contract', async () => {
    const root = await tempRoot();

    await install('codex', 'project', { root, language: 'zh', noWiki: true });

    await expect(readFile(join(root, '.codex/skills/kata-build/SKILL.md'), 'utf8')).resolves.toContain('所有面向用户的自然语言响应必须使用中文');
    await expect(readFile(join(root, 'AGENTS.md'), 'utf8')).resolves.toContain('所有面向用户的自然语言响应必须使用中文');
    await expect(readFile(join(root, '.kata/skills-index.md'), 'utf8')).resolves.toContain('Response language');
  });

  it('installs the skill-first development constraint into the project contract', async () => {
    const root = await tempRoot();

    await install('codex', 'project', { root, noWiki: true });

    const contract = await readFile(join(root, 'AGENTS.md'), 'utf8');
    expect(contract).toContain('Development constraint: skill-first');
    expect(contract).toContain('the `/kata-*` skill is the human-facing workflow entrypoint');
    expect(contract).toContain('A skill must first discover the active/same-branch task');
    expect(contract).toContain('Do not ask the user to provide CLI flags');
    expect(contract).toContain('review_gate');
  });

  it('persists response language and reuses it during update without explicit language flags', async () => {
    const root = await tempRoot();

    await install('codex', 'project', { root, language: 'zh', noWiki: true });
    await update('codex', 'project', { root, force: true, noWiki: true });

    const config = JSON.parse(await readFile(join(root, '.kata-config.json'), 'utf8')) as Record<string, unknown>;
    expect(config.language).toBe('zh');
    await expect(readFile(join(root, '.codex/skills/kata-build/SKILL.md'), 'utf8')).resolves.toContain('所有面向用户的自然语言响应必须使用中文');
    await expect(readFile(join(root, 'AGENTS.md'), 'utf8')).resolves.toContain('所有面向用户的自然语言响应必须使用中文');
  });

  it('uses response language from existing project configuration during installer updates', async () => {
    const root = await tempRoot();
    await writeFile(join(root, '.kata-config.json'), '{"language":"zh"}\n', 'utf8');

    await update('generic', 'project', { root, noWiki: true });

    await expect(readFile(join(root, '.kata/skills/kata-build.md'), 'utf8')).resolves.toContain('所有面向用户的自然语言响应必须使用中文');
    await expect(readFile(join(root, '.kata/rules/kata-agent-contract.md'), 'utf8')).resolves.toContain('所有面向用户的自然语言响应必须使用中文');
    await expect(readFile(join(root, '.kata/rules/kata-agent-contract.md'), 'utf8')).resolves.toContain('Development constraint: skill-first');
  });

  it('initializes .llmwiki from docs during project init by default', async () => {
    const root = await tempRoot();
    await mkdir(join(root, 'docs'), { recursive: true });
    await writeFile(join(root, 'docs', 'guide.md'), '# Guide\n\nUse Kata from the binary.\n', 'utf8');

    const result = await captureJsonOutput(() => main(['init', '--json', '--platform', 'codex', '--scope', 'project', '--root', root]));

    expect(result.wiki).toMatchObject({ status: 'initialized', from: 'docs', importedCount: 1 });
    await expect(readFile(join(root, '.llmwiki/SCHEMA.md'), 'utf8')).resolves.toContain('Project LLM Wiki');
    await expect(readFile(join(root, '.llmwiki/index.md'), 'utf8')).resolves.toContain('[[raw/docs/guide.md]]');
  });

  it('supports explicit --wiki-from and --no-wiki for binary-managed wiki initialization', async () => {
    const explicitRoot = await tempRoot();
    await mkdir(join(explicitRoot, 'knowledge'), { recursive: true });
    await writeFile(join(explicitRoot, 'knowledge', 'architecture.md'), '# Architecture\n\nBinary manages wiki.\n', 'utf8');

    const explicit = await captureJsonOutput(() =>
      main(['init', '--json', '--platform', 'codex', '--scope', 'project', '--root', explicitRoot, '--wiki-from', 'knowledge']),
    );

    expect(explicit.wiki).toMatchObject({ status: 'initialized', from: 'knowledge', importedCount: 1 });
    await expect(readFile(join(explicitRoot, '.llmwiki/index.md'), 'utf8')).resolves.toContain('architecture.md');

    const disabledRoot = await tempRoot();
    await mkdir(join(disabledRoot, 'docs'), { recursive: true });
    await writeFile(join(disabledRoot, 'docs', 'guide.md'), '# Guide\n', 'utf8');

    const disabled = await captureJsonOutput(() =>
      main(['init', '--json', '--platform', 'codex', '--scope', 'project', '--root', disabledRoot, '--no-wiki']),
    );

    expect(disabled.wiki).toEqual({ status: 'skipped', reason: 'disabled' });
    await expect(stat(join(disabledRoot, '.llmwiki'))).rejects.toThrow();
  });

  it('preserves an existing .llmwiki during project init', async () => {
    const root = await tempRoot();
    await mkdir(join(root, '.llmwiki'), { recursive: true });
    await writeFile(join(root, '.llmwiki', 'index.md'), '# Existing Wiki\n', 'utf8');
    await mkdir(join(root, 'docs'), { recursive: true });
    await writeFile(join(root, 'docs', 'guide.md'), '# Guide\n', 'utf8');

    const result = await captureJsonOutput(() => main(['init', '--json', '--platform', 'codex', '--scope', 'project', '--root', root]));

    expect(result.wiki).toEqual({ status: 'existing', path: '.llmwiki' });
    await expect(readFile(join(root, '.llmwiki', 'index.md'), 'utf8')).resolves.toBe('# Existing Wiki\n');
  });

  it('reports conflicts instead of overwriting user-owned or user-modified files', async () => {
    const root = await tempRoot();
    const firstSkill = skillCommands[0];
    const skillPath = join(root, '.codex/skills', firstSkill.id, 'SKILL.md');

    await install('codex', 'project', { root });
    const customContent = '# My custom workflow\n';
    await writeFile(skillPath, customContent);

    const report = await update('codex', 'project', { root });

    expect(report.conflicts).toContain(`.codex/skills/${firstSkill.id}/SKILL.md`);
    await expect(readFile(skillPath, 'utf8')).resolves.toBe(customContent);
  });

  it('uninstalls only owned, unmodified files', async () => {
    const root = await tempRoot();
    const firstSkill = skillCommands[0];
    const firstPath = join(root, '.codex/skills', firstSkill.id, 'SKILL.md');
    const secondPath = join(root, '.codex/skills', skillCommands[1].id, 'SKILL.md');

    await install('codex', 'project', { root });
    await writeFile(firstPath, '# user edited\n');

    const report = await uninstall('codex', 'project', { root });

    expect(report.conflicts).toContain(`.codex/skills/${firstSkill.id}/SKILL.md`);
    await expect(readFile(firstPath, 'utf8')).resolves.toBe('# user edited\n');
    await expect(stat(secondPath)).rejects.toThrow();
  });

  it('removes only the managed Kata block from pre-existing AGENTS.md on uninstall', async () => {
    const root = await tempRoot();
    const original = '# repo instructions\n\nKeep this project rule.\n';
    await writeFile(join(root, 'AGENTS.md'), original);

    await install('codex', 'project', { root });
    await expect(readFile(join(root, 'AGENTS.md'), 'utf8')).resolves.toContain('Kata Agent Contract');

    const report = await uninstall('codex', 'project', { root });

    expect(report.removed).toContain('AGENTS.md');
    await expect(readFile(join(root, 'AGENTS.md'), 'utf8')).resolves.toBe(original);
  });

  it('keeps ownership manifest accurate when uninstall preserves conflicted files', async () => {
    const root = await tempRoot();
    const firstSkill = skillCommands[0];
    const firstPath = join(root, '.codex/skills', firstSkill.id, 'SKILL.md');
    const secondPath = join(root, '.codex/skills', skillCommands[1].id, 'SKILL.md');

    await install('codex', 'project', { root });
    await writeFile(firstPath, '# user edited\n');

    await uninstall('codex', 'project', { root });

    const manifest = JSON.parse(await readFile(join(root, '.kata/adapters/manifest.json'), 'utf8')) as {
      files: Record<string, unknown>;
    };
    expect(manifest.files[`.codex/skills/${firstSkill.id}/SKILL.md`]).toBeDefined();
    expect(manifest.files[`.codex/skills/${skillCommands[1].id}/SKILL.md`]).toBeUndefined();
    await expect(stat(secondPath)).rejects.toThrow();
  });

  it('lists every platform managed by the ownership manifest for one scope', async () => {
    const root = await tempRoot();

    await install('opencode', 'project', { root });
    await install('codex', 'project', { root });

    await expect(listManagedPlatforms('project', { root })).resolves.toEqual(['codex', 'opencode']);
  });

  it('updates all managed and detected project platforms when no platform is specified', async () => {
    const root = await tempRoot();
    await install('opencode', 'project', { root });
    await mkdir(join(root, '.codex'), { recursive: true });

    const aggregate = await captureJsonOutput(() => main(['update', '--json', '--root', root]));

    expect(aggregate).toMatchObject({
      command: 'update',
      scope: 'project',
      selectedPlatforms: expect.arrayContaining(['codex', 'opencode']),
    });
    expect(aggregate.selectedPlatforms).not.toContain('generic');
    await expect(readFile(join(root, '.opencode/commands/kata-build.md'), 'utf8'))
      .resolves.toContain('completion.userMessage');

    const directed = await captureJsonOutput(() => main(['update', '--json', '--platform', 'opencode', '--root', root]));
    expect(directed).toMatchObject({ platform: 'opencode', scope: 'project' });
  });

  it('CLI init/update/uninstall route to the platform installer when no change id is provided', async () => {
    const root = await tempRoot();

    await main(['init', '--platform', 'codex', '--scope', 'project', '--root', root]);
    await main(['update', '--platform', 'codex', '--scope', 'project', '--root', root]);
    await main(['uninstall', '--platform', 'codex', '--scope', 'project', '--root', root, '--force']);

    await expect(stat(join(root, '.codex/skills', skillCommands[0].id, 'SKILL.md'))).rejects.toThrow();
  });

  it('routes installer commands without change ids to platform installer', async () => {
    const root = await tempRoot();
    const installOptions = ['--platform', 'generic', '--scope', 'project', '--root', root, '--dry-run'];

    const initResult = await captureJsonOutput(() => main(['init', '--json', ...installOptions]));
    expect(initResult).toEqual(
      expect.objectContaining({ platform: 'generic', dryRun: true }),
    );
  });

  it('routes workflow commands with change ids to orchestrator', async () => {
    const root = await tempRoot();
    const previousCwd = process.cwd();
    process.chdir(root);
    try {
      const openResult = await captureJsonOutput(() => main(['open', '--change', 'change-abc', '--isolation', 'current_worktree', '--development', 'tdd', '--review', 'std']));
      expect(openResult).toMatchObject({
        command: 'open',
        taskId: 'change-abc',
        phase: 'intake',
        success: true,
      });
      await expect(readFile(join(root, '.kata/tasks/change-abc/task.json'), 'utf8')).resolves.toContain('change-abc');
    } finally {
      process.chdir(previousCwd);
    }
  });

  it('returns local status with /kata-design while Kata owns Comet open acknowledgement', async () => {
    const root = await tempRoot();
    const previousCwd = process.cwd();
    process.chdir(root);
    try {
      const open = await captureJsonOutput(() => main(['open', '--change', 'status-task', '--isolation', 'current_worktree', '--development', 'tdd', '--review', 'std']));
      expect(open).toMatchObject({
        nextAction: {
          nextSkill: '/kata-design',
          slashCommand: '/kata-design status-task',
          reason: 'design_intake_task',
        },
      });

      const status = await captureJsonOutput(() => main(['status', '--change', 'status-task']));

      expect(status).toMatchObject({
        command: 'status',
        taskId: 'status-task',
        phase: 'intake',
        nextSkill: '/kata-design',
        nextAction: {
          nextSkill: '/kata-design',
          slashCommand: '/kata-design status-task',
          reason: 'design_intake_task',
        },
      });
      expect(JSON.stringify(status)).not.toContain('/comet-open');
    } finally {
      process.chdir(previousCwd);
    }
  });

  it('honors explicit workflow profile flags for non-interactive kata open', async () => {
    const root = await tempRoot();
    const previousCwd = process.cwd();
    process.chdir(root);
    try {
      const open = await captureJsonOutput(() =>
        main([
          'open',
          '--change',
          'profiled-open-task',
          '--isolation',
          'isolated_worktree',
          '--development',
          'standard',
          '--review',
          'strict',
        ]),
      );

      expect(open).toMatchObject({
        workflowProfile: {
          isolationMode: 'isolated_worktree',
          developmentMode: 'standard',
          reviewMode: 'strict',
          comet: { openStatus: 'required' },
        },
      });

      const task = JSON.parse(await readFile(join(root, '.kata/tasks/profiled-open-task/task.json'), 'utf8')) as {
        workflowProfile?: {
          isolationMode?: string;
          developmentMode?: string;
          reviewMode?: string;
        };
      };
      expect(task.workflowProfile).toMatchObject({
        isolationMode: 'isolated_worktree',
        developmentMode: 'standard',
        reviewMode: 'strict',
      });
    } finally {
      process.chdir(previousCwd);
    }
  });

  it('orients intake tasks to /kata-design instead of exposing /comet-open', async () => {
    const root = await tempRoot();
    const previousCwd = process.cwd();
    process.chdir(root);
    try {
      await captureJsonOutput(() => main(['open', '--change', 'orient-comet-task', '--isolation', 'current_worktree', '--development', 'tdd', '--review', 'std']));

      const orient = await captureJsonOutput(() =>
        main(['orient', '--change', 'orient-comet-task', '--role', 'designer', '--platform', 'codex']),
      );

      expect(orient).toMatchObject({
        command: 'orient',
        taskId: 'orient-comet-task',
        phase: 'intake',
        nextSkill: '/kata-design',
        nextAction: {
          nextSkill: '/kata-design',
          slashCommand: '/kata-design orient-comet-task',
          reason: 'design_intake_task',
        },
      });
      expect(JSON.stringify(orient)).not.toContain('/comet-open');
    } finally {
      process.chdir(previousCwd);
    }
  });

  it('honors --root for local status when invoked from a nested project directory', async () => {
    const root = await tempRoot();
    await initLayout(root);
    await createTask({
      root,
      id: 'rooted-status-task',
      title: 'Rooted status task',
      acceptance: [{ id: 'AC-1', statement: 'Status must use the explicit root.' }],
    });
    const nested = join(root, 'kata');
    await mkdir(nested, { recursive: true });
    await writeFile(join(nested, 'package.json'), '{"name":"nested"}\n');

    const previousCwd = process.cwd();
    process.chdir(nested);
    try {
      const status = await captureJsonOutput(() =>
        main(['status', '--root', root, '--change', 'rooted-status-task']),
      );

      expect(status).toMatchObject({
        command: 'status',
        taskId: 'rooted-status-task',
        phase: 'intake',
        task: {
          title: 'Rooted status task',
          acceptance: [{ id: 'AC-1', statement: 'Status must use the explicit root.' }],
        },
      });
    } finally {
      process.chdir(previousCwd);
    }
  });

  it('uses the same-branch active task for status without asking for a change id', async () => {
    const root = await tempRoot();
    execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
    await initLayout(root);
    await createTask({
      root,
      id: 'active-status-task',
      title: 'Active status task',
      acceptance: [{ id: 'AC-1', statement: 'Status can resume active task.' }],
    });
    const previousCwd = process.cwd();
    process.chdir(root);
    try {
      await main(['hooks', 'activate', '--change', 'active-status-task', '--role', 'implementer', '--platform', 'codex']);

      const status = await captureJsonOutput(() => main(['status']));

      expect(status).toMatchObject({
        command: 'status',
        taskId: 'active-status-task',
        phase: 'intake',
        nextSkill: '/kata-design',
        active: true,
        branch: expect.any(String),
        platform: 'codex',
        task: {
          title: 'Active status task',
          acceptance: [{ id: 'AC-1', statement: 'Status can resume active task.' }],
        },
        requiredReads: expect.arrayContaining(['AGENTS.md', '.llmwiki/SCHEMA.md', '.kata/tasks/active-status-task/task.json']),
        context: expect.objectContaining({
          authoritativeWikiCount: 0,
          excludedWikiCount: 0,
        }),
      });
    } finally {
      process.chdir(previousCwd);
    }
  });

  it('orients the same-branch active task without requiring --change', async () => {
    const root = await tempRoot();
    execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
    await initLayout(root);
    await createTask({
      root,
      id: 'active-orient-task',
      title: 'Active orient task',
      acceptance: [{ id: 'AC-1', statement: 'Orient can resume active task.' }],
    });
    const previousCwd = process.cwd();
    process.chdir(root);
    try {
      await main(['hooks', 'activate', '--change', 'active-orient-task', '--role', 'reviewer', '--platform', 'codex']);

      const orient = await captureJsonOutput(() => main(['orient', '--role', 'reviewer', '--platform', 'codex']));

      expect(orient).toMatchObject({
        command: 'orient',
        taskId: 'active-orient-task',
        role: 'reviewer',
        platform: 'codex',
        active: true,
        task: {
          title: 'Active orient task',
          acceptance: [{ id: 'AC-1', statement: 'Orient can resume active task.' }],
        },
        state: expect.objectContaining({ phase: 'intake' }),
        requiredReads: expect.arrayContaining(['.kata/tasks/active-orient-task/current-state.json']),
      });
    } finally {
      process.chdir(previousCwd);
    }
  });

  it('discovers the only task created on the current branch when no active task is set', async () => {
    const root = await tempRoot();
    execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
    await initLayout(root);
    await createTask({
      root,
      id: 'branch-discovered-task',
      title: 'Branch discovered task',
      acceptance: [{ id: 'AC-1', statement: 'Status discovers the current branch task.' }],
    });
    const previousCwd = process.cwd();
    process.chdir(root);
    try {
      const status = await captureJsonOutput(() => main(['status']));
      expect(status).toMatchObject({
        command: 'status',
        taskId: 'branch-discovered-task',
        discovered: true,
        branch: expect.any(String),
        task: {
          title: 'Branch discovered task',
          acceptance: [{ id: 'AC-1', statement: 'Status discovers the current branch task.' }],
        },
      });

      const orient = await captureJsonOutput(() => main(['orient', '--role', 'implementer', '--platform', 'codex']));
      expect(orient).toMatchObject({
        command: 'orient',
        taskId: 'branch-discovered-task',
        discovered: true,
        branch: expect.any(String),
        requiredReads: expect.arrayContaining(['.kata/tasks/branch-discovered-task/task.json']),
      });
    } finally {
      process.chdir(previousCwd);
    }
  });

  it('rejects no-argument workflow resume when the active task belongs to another branch', async () => {
    const root = await tempRoot();
    execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
    await initLayout(root);
    await createTask({
      root,
      id: 'wrong-branch-task',
      title: 'Wrong branch task',
      acceptance: [{ id: 'AC-1', statement: 'Wrong branch task is not resumed.' }],
    });
    await main(['hooks', 'activate', '--change', 'wrong-branch-task', '--role', 'implementer', '--platform', 'codex', '--root', root]);
    await writeFile(
      join(root, '.kata/runtime/active-task.json'),
      `${JSON.stringify(
        {
          taskId: 'wrong-branch-task',
          role: 'implementer',
          phase: 'intake',
          platform: 'codex',
          branch: 'different-branch',
          activatedAt: new Date().toISOString(),
        },
        null,
        2,
      )}\n`,
    );
    const previousCwd = process.cwd();
    process.chdir(root);
    try {
      await expect(main(['design'])).rejects.toThrow(/active task belongs to branch different-branch/i);
    } finally {
      process.chdir(previousCwd);
    }
  });

  it('dispatch status recommends repairing upstream blocking review findings without a change id', async () => {
    const root = await tempRoot();
    execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
    await initLayout(root);
    await createTask({
      root,
      id: 'repair-me',
      title: 'Repair me',
      acceptance: [{ id: 'AC-1', statement: 'Repair blocking findings.' }],
    });
    await createTask({
      root,
      id: 'review-me',
      title: 'Review me',
      acceptance: [{ id: 'AC-1', statement: 'Review fresh evidence.' }],
    });
    await writeFile(
      join(root, '.kata/tasks/repair-me/current-state.json'),
      `${JSON.stringify({ taskId: 'repair-me', phase: 'review', updatedAt: new Date().toISOString() }, null, 2)}\n`,
    );
    await writeFile(
      join(root, '.kata/tasks/review-me/current-state.json'),
      `${JSON.stringify({ taskId: 'review-me', phase: 'hardVerify', updatedAt: new Date().toISOString() }, null, 2)}\n`,
    );
    await writeFile(
      join(root, '.kata/tasks/repair-me/review.json'),
      `${JSON.stringify({ findings: [{ severity: 'blocking', message: 'Must fix.' }] }, null, 2)}\n`,
    );

    const previousCwd = process.cwd();
    process.chdir(root);
    try {
      const status = await captureJsonOutput(() => main(['status']));

      expect(status).toMatchObject({
        command: 'status',
        taskId: null,
        phase: 'dispatch',
      recommended: {
        taskId: 'repair-me',
        nextSkill: '/kata-build',
        role: 'implementer',
        reason: 'repair_blocking_review_findings',
        slashCommand: '/kata-build repair-me',
        cliCommand: 'kata build --change repair-me',
      },
      nextAction: {
        taskId: 'repair-me',
        slashCommand: '/kata-build repair-me',
        cliCommand: 'kata build --change repair-me',
      },
        candidates: [
          expect.objectContaining({
            taskId: 'repair-me',
            upstream: expect.objectContaining({ blockingFindings: 1 }),
          }),
          expect.objectContaining({
            taskId: 'review-me',
            nextSkill: '/kata-verify',
          }),
        ],
      });
    } finally {
      process.chdir(previousCwd);
    }
  });

  it('specific status recommends repair when the selected task has blocking review findings', async () => {
    const root = await tempRoot();
    execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
    await initLayout(root);
    await createTask({
      root,
      id: 'selected-repair',
      title: 'Selected repair',
      acceptance: [{ id: 'AC-1', statement: 'Selected status should not hide blocking findings.' }],
    });
    await writeFile(
      join(root, '.kata/tasks/selected-repair/current-state.json'),
      `${JSON.stringify({ taskId: 'selected-repair', phase: 'review', updatedAt: new Date().toISOString() }, null, 2)}\n`,
    );
    await writeFile(
      join(root, '.kata/tasks/selected-repair/review.json'),
      `${JSON.stringify({ findings: [{ severity: 'blocking', message: 'Boundary still violated.' }] }, null, 2)}\n`,
    );

    const status = await captureJsonOutput(() => main(['status', '--root', root, '--change', 'selected-repair']));

    expect(status).toMatchObject({
      command: 'status',
      taskId: 'selected-repair',
      phase: 'review',
      phaseNextSkill: '/kata-judge',
      nextSkill: '/kata-build',
      recommended: {
        taskId: 'selected-repair',
        nextSkill: '/kata-build',
        role: 'implementer',
        reason: 'repair_blocking_review_findings',
        slashCommand: '/kata-build selected-repair',
        cliCommand: 'kata build --change selected-repair',
      },
      nextAction: {
        taskId: 'selected-repair',
        slashCommand: '/kata-build selected-repair',
        cliCommand: 'kata build --change selected-repair',
      },
      upstream: expect.objectContaining({
        blockingFindings: 1,
      }),
      askUser: expect.arrayContaining([
        '检测到 blocking review findings；建议先执行 /kata-build 修复，而不是继续 Judge PASS。',
      ]),
    });
  });

  it('orient includes artifact-aware repair recommendation when review has blocking findings', async () => {
    const root = await tempRoot();
    execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
    await initLayout(root);
    await createTask({
      root,
      id: 'orient-repair',
      title: 'Orient repair',
      acceptance: [{ id: 'AC-1', statement: 'Orientation should surface blocking review findings.' }],
    });
    await writeFile(
      join(root, '.kata/tasks/orient-repair/current-state.json'),
      `${JSON.stringify({ taskId: 'orient-repair', phase: 'review', updatedAt: new Date().toISOString() }, null, 2)}\n`,
    );
    await writeFile(
      join(root, '.kata/tasks/orient-repair/review.json'),
      `${JSON.stringify({ findings: [{ severity: 'blocking', message: 'Must repair before judge.' }] }, null, 2)}\n`,
    );

    const orient = await captureJsonOutput(() =>
      main(['orient', '--root', root, '--change', 'orient-repair', '--role', 'judge', '--platform', 'codex']),
    );

    expect(orient).toMatchObject({
      command: 'orient',
      taskId: 'orient-repair',
      phase: 'review',
      phaseNextSkill: '/kata-judge',
      nextSkill: '/kata-build',
      recommended: {
        taskId: 'orient-repair',
        nextSkill: '/kata-build',
        role: 'implementer',
        reason: 'repair_blocking_review_findings',
        slashCommand: '/kata-build orient-repair',
        cliCommand: 'kata build --change orient-repair',
      },
      nextAction: {
        taskId: 'orient-repair',
        slashCommand: '/kata-build orient-repair',
        cliCommand: 'kata build --change orient-repair',
      },
      artifactOverride: true,
      upstream: expect.objectContaining({ blockingFindings: 1 }),
    });
  });

  it('specific status ignores stale blocking review findings after repair returns to hardVerify', async () => {
    const root = await tempRoot();
    execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
    await initLayout(root);
    await createTask({
      root,
      id: 'repaired-hardverify',
      title: 'Repaired hard verify',
      acceptance: [{ id: 'AC-1', statement: 'Old review findings should not override hardVerify.' }],
    });
    await writeFile(
      join(root, '.kata/tasks/repaired-hardverify/current-state.json'),
      `${JSON.stringify({ taskId: 'repaired-hardverify', phase: 'hardVerify', updatedAt: new Date().toISOString() }, null, 2)}\n`,
    );
    await writeFile(
      join(root, '.kata/tasks/repaired-hardverify/review.json'),
      `${JSON.stringify({ findings: [{ severity: 'blocking', message: 'Old finding before repair.' }] }, null, 2)}\n`,
    );

    const status = await captureJsonOutput(() => main(['status', '--root', root, '--change', 'repaired-hardverify']));

    expect(status).toMatchObject({
      command: 'status',
      taskId: 'repaired-hardverify',
      phase: 'hardVerify',
      nextSkill: '/kata-verify',
      recommended: {
        taskId: 'repaired-hardverify',
        nextSkill: '/kata-verify',
        role: 'reviewer',
        reason: 'verify_fresh_implementation',
        slashCommand: '/kata-verify repaired-hardverify',
        cliCommand: 'kata verify --change repaired-hardverify',
      },
      nextAction: {
        taskId: 'repaired-hardverify',
        nextSkill: '/kata-verify',
        role: 'reviewer',
        reason: 'verify_fresh_implementation',
        requiresUserConfirmation: false,
        modelOrPlatformSwitchAllowed: false,
      },
      upstream: expect.objectContaining({ blockingFindings: 1 }),
    });
    expect(status.artifactOverride).toBeUndefined();
  });

  it('specific status ignores stale failed judge result after repair returns to hardVerify', async () => {
    const root = await tempRoot();
    execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
    await initLayout(root);
    await createTask({
      root,
      id: 'judge-repaired-hardverify',
      title: 'Judge repaired hard verify',
      acceptance: [{ id: 'AC-1', statement: 'Old judge FAIL should not override hardVerify.' }],
    });
    await writeFile(
      join(root, '.kata/tasks/judge-repaired-hardverify/current-state.json'),
      `${JSON.stringify({ taskId: 'judge-repaired-hardverify', phase: 'hardVerify', updatedAt: new Date().toISOString() }, null, 2)}\n`,
    );
    await writeFile(
      join(root, '.kata/tasks/judge-repaired-hardverify/judge.json'),
      `${JSON.stringify({ result: 'FAIL', acceptance: [{ id: 'AC-1', result: 'FAIL', repairScope: 'stale_evidence' }] }, null, 2)}\n`,
    );

    const status = await captureJsonOutput(() => main(['status', '--root', root, '--change', 'judge-repaired-hardverify']));

    expect(status).toMatchObject({
      command: 'status',
      taskId: 'judge-repaired-hardverify',
      phase: 'hardVerify',
      nextSkill: '/kata-verify',
      recommended: {
        taskId: 'judge-repaired-hardverify',
        nextSkill: '/kata-verify',
        role: 'reviewer',
        reason: 'verify_fresh_implementation',
        slashCommand: '/kata-verify judge-repaired-hardverify',
        cliCommand: 'kata verify --change judge-repaired-hardverify',
      },
      nextAction: {
        taskId: 'judge-repaired-hardverify',
        nextSkill: '/kata-verify',
        role: 'reviewer',
        reason: 'verify_fresh_implementation',
        requiresUserConfirmation: false,
        modelOrPlatformSwitchAllowed: false,
      },
      upstream: expect.objectContaining({ judgeResult: 'FAIL', failedAcceptance: 1 }),
    });
    expect(status.artifactOverride).toBeUndefined();
  });

  it('does not route archived tasks back to build because of stale failing evidence', async () => {
    const root = await tempRoot();
    await initLayout(root);
    await createTask({
      root,
      id: 'archived-with-old-failure',
      title: 'Archived with old failure',
      acceptance: [{ id: 'AC-1', statement: 'Archived tasks stay archived unless reopened.' }],
    });
    await mkdir(join(root, '.kata/evidence'), { recursive: true });
    await writeFile(
      join(root, '.kata/tasks/archived-with-old-failure/current-state.json'),
      `${JSON.stringify({ taskId: 'archived-with-old-failure', phase: 'archive', updatedAt: new Date().toISOString() }, null, 2)}\n`,
    );
    await writeFile(
      join(root, '.kata/evidence/archived-with-old-failure-test.json'),
      `${JSON.stringify({ kind: 'test', exitCode: 1 }, null, 2)}\n`,
    );

    const status = await captureJsonOutput(() => main(['status', '--root', root, '--change', 'archived-with-old-failure']));

    expect(status).toMatchObject({
      command: 'status',
      taskId: 'archived-with-old-failure',
      phase: 'archive',
      nextSkill: '/kata',
      recommended: {
        reason: 'archived_task',
        slashCommand: '/kata archived-with-old-failure',
        cliCommand: 'kata status --change archived-with-old-failure',
      },
      upstream: expect.objectContaining({ failingEvidence: 1 }),
    });
    expect(status.artifactOverride).toBeUndefined();
  });

  it('relates placeholder tasks to the governed task that covers them and status follows the relation', async () => {
    const root = await tempRoot();
    execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
    await initLayout(root);
    await createTask({
      root,
      id: 'fix-code-style-arch-boundaries',
      title: 'Change fix-code-style-arch-boundaries',
      acceptance: [{ id: 'AC-1', statement: 'Implement the change.' }],
    });
    await createTask({
      root,
      id: 'repair-code-standards-boundaries',
      title: 'Repair code standards and architecture boundary violations from full-chain audit',
      acceptance: [{ id: 'AC-1', statement: 'Repair code standards.' }],
    });
    await writeFile(
      join(root, '.kata/tasks/repair-code-standards-boundaries/current-state.json'),
      `${JSON.stringify({ taskId: 'repair-code-standards-boundaries', phase: 'hardVerify', updatedAt: new Date().toISOString() }, null, 2)}\n`,
    );

    const relation = await captureJsonOutput(() =>
      main([
        'tasks',
        'relate',
        '--root',
        root,
        '--from',
        'fix-code-style-arch-boundaries',
        '--to',
        'repair-code-standards-boundaries',
        '--type',
        'covered_by',
        '--reason',
        'covered by the specific repair task',
      ]),
    );
    expect(relation).toMatchObject({
      command: 'tasks relate',
      fromTaskId: 'fix-code-style-arch-boundaries',
      toTaskId: 'repair-code-standards-boundaries',
      redirectsTo: 'repair-code-standards-boundaries',
    });

    const status = await captureJsonOutput(() =>
      main(['status', '--root', root, '--change', 'fix-code-style-arch-boundaries']),
    );

    expect(status).toMatchObject({
      command: 'status',
      redirectedFrom: 'fix-code-style-arch-boundaries',
      taskId: 'repair-code-standards-boundaries',
      phase: 'hardVerify',
      nextSkill: '/kata-verify',
      relationRedirects: [
        {
          fromTaskId: 'fix-code-style-arch-boundaries',
          toTaskId: 'repair-code-standards-boundaries',
          type: 'covered_by',
          reason: 'covered by the specific repair task',
        },
      ],
      askUser: [
        '任务 fix-code-style-arch-boundaries 已通过 covered_by 指向 repair-code-standards-boundaries；请继续处理 repair-code-standards-boundaries。',
      ],
    });

    await expect(readFile(join(root, '.kata/tasks/fix-code-style-arch-boundaries/task-relations.json'), 'utf8')).resolves.toContain('covered_by');
    await expect(readFile(join(root, '.kata/tasks/fix-code-style-arch-boundaries/task.json'), 'utf8')).resolves.toContain('repair-code-standards-boundaries');

    const orient = await captureJsonOutput(() =>
      main(['orient', '--root', root, '--change', 'fix-code-style-arch-boundaries', '--role', 'implementer']),
    );
    expect(orient).toMatchObject({
      command: 'orient',
      redirectedFrom: 'fix-code-style-arch-boundaries',
      taskId: 'repair-code-standards-boundaries',
      relationRedirects: [
        expect.objectContaining({
          fromTaskId: 'fix-code-style-arch-boundaries',
          toTaskId: 'repair-code-standards-boundaries',
          type: 'covered_by',
        }),
      ],
    });
  });

  it('records change-task and change-change relations without changing task workflow control', async () => {
    const root = await tempRoot();
    await initLayout(root);
    await createTask({
      root,
      id: 'implement-ledger-task',
      title: 'Implement ledger task',
      acceptance: [{ id: 'AC-1', statement: 'Task remains the workflow control unit.' }],
    });

    const owns = await captureJsonOutput(() =>
      main([
        'relations',
        'add',
        '--root',
        root,
        '--from',
        'change:full-chain-quality-optimization',
        '--to',
        'task:implement-ledger-task',
        '--type',
        'contains',
        '--reason',
        'change owns this implementation task',
      ]),
    );
    expect(owns).toMatchObject({
      command: 'relations add',
      from: { type: 'change', id: 'full-chain-quality-optimization' },
      to: { type: 'task', id: 'implement-ledger-task' },
      relation: {
        kind: 'ownership',
        type: 'contains',
      },
    });

    const supersedes = await captureJsonOutput(() =>
      main([
        'relations',
        'add',
        '--root',
        root,
        '--from',
        'change:old-quality-plan',
        '--to',
        'change:full-chain-quality-optimization',
        '--type',
        'superseded_by',
      ]),
    );
    expect(supersedes).toMatchObject({
      relation: {
        kind: 'control',
        from: { type: 'change', id: 'old-quality-plan' },
        to: { type: 'change', id: 'full-chain-quality-optimization' },
      },
    });

    const graph = await captureJsonOutput(() =>
      main(['relations', 'show', '--root', root, '--id', 'change:full-chain-quality-optimization']),
    );
    expect(graph).toMatchObject({
      command: 'relations show',
      endpoint: { type: 'change', id: 'full-chain-quality-optimization' },
      incoming: [
        expect.objectContaining({ type: 'superseded_by' }),
      ],
      outgoing: [
        expect.objectContaining({ type: 'contains', to: { type: 'task', id: 'implement-ledger-task' } }),
      ],
    });

    const status = await captureJsonOutput(() => main(['status', '--root', root, '--change', 'implement-ledger-task']));
    expect(status).toMatchObject({
      command: 'status',
      taskId: 'implement-ledger-task',
      phase: 'intake',
      nextSkill: '/kata-design',
    });
    expect(status.redirectedFrom).toBeUndefined();
    await expect(readFile(join(root, '.kata/relations.json'), 'utf8')).resolves.toContain('full-chain-quality-optimization');
  });

  it('collect recommends the same upstream repair action for short cross-platform handoff', async () => {
    const root = await tempRoot();
    execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
    await initLayout(root);
    await createTask({
      root,
      id: 'collect-repair',
      title: 'Collect repair',
      acceptance: [{ id: 'AC-1', statement: 'Collect should discover repair.' }],
    });
    await writeFile(
      join(root, '.kata/tasks/collect-repair/current-state.json'),
      `${JSON.stringify({ taskId: 'collect-repair', phase: 'review', updatedAt: new Date().toISOString() }, null, 2)}\n`,
    );
    await writeFile(
      join(root, '.kata/tasks/collect-repair/review.json'),
      `${JSON.stringify({ findings: [{ severity: 'blocking', message: 'Fix me.' }] }, null, 2)}\n`,
    );

    const collect = await captureJsonOutput(() => main(['collect', '--root', root]));

    expect(collect).toMatchObject({
      command: 'collect',
      recommended: {
        taskId: 'collect-repair',
        nextSkill: '/kata-build',
        role: 'implementer',
        reason: 'repair_blocking_review_findings',
        slashCommand: '/kata-build collect-repair',
        cliCommand: 'kata build --change collect-repair',
        upstream: expect.objectContaining({ blockingFindings: 1 }),
      },
      nextAction: {
        taskId: 'collect-repair',
        slashCommand: '/kata-build collect-repair',
        cliCommand: 'kata build --change collect-repair',
      },
      askUser: expect.arrayContaining([
        '检测到上游 blocking review findings；建议作为 implementer repair。',
      ]),
    });
  });

  it('suppresses installer stdout by default and emits reports only with --json', async () => {
    const root = await tempRoot();

    const defaultWrite = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      await main(['update', '--platform', 'generic', '--scope', 'project', '--root', root]);
      expect(defaultWrite).not.toHaveBeenCalled();
    } finally {
      defaultWrite.mockRestore();
    }

    const quietWrite = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      await main(['update', '--json', '--platform', 'generic', '--scope', 'project', '--root', root, '--quiet']);
      expect(quietWrite).not.toHaveBeenCalled();
    } finally {
      quietWrite.mockRestore();
    }

    const explicitJson = await captureJsonOutput(() =>
      main(['update', '--json', '--platform', 'generic', '--scope', 'project', '--root', root]),
    );
    expect(explicitJson).toMatchObject({
      platform: 'generic',
      scope: 'project',
    });
  });

  it('returns the next recommended operation after a workflow phase command completes', async () => {
    const root = await tempRoot();
    await writeFile(
      join(root, '.kata-config.json'),
      `${JSON.stringify(
        {
          quality: {
            buildChecks: [
              { name: 'unit', kind: 'test', command: process.execPath, args: ['-e', 'process.exit(0)'] },
            ],
          },
        },
        null,
        2,
      )}\n`,
      'utf8',
    );

    await captureJsonOutput(() => main(['open', 'cli-next-action-test', '--isolation', 'current_worktree', '--development', 'tdd', '--review', 'std', '--root', root, '--json']));
    await captureJsonOutput(() => main(['design', 'cli-next-action-test', '--root', root, '--json']));
    const build = await captureJsonOutput(() => main(['build', 'cli-next-action-test', '--root', root, '--json']));

    expect(build).toMatchObject({
      command: 'build',
      taskId: 'cli-next-action-test',
      phase: 'implement',
      success: true,
      nextSkill: '/kata-build',
      recommended: {
        taskId: 'cli-next-action-test',
        nextSkill: '/kata-build',
        role: 'implementer',
        reason: 'continue_implementation',
        slashCommand: '/kata-build cli-next-action-test',
        cliCommand: 'kata build --change cli-next-action-test',
      },
      nextAction: {
        taskId: 'cli-next-action-test',
        nextSkill: '/kata-build',
        slashCommand: '/kata-build cli-next-action-test',
        cliCommand: 'kata build --change cli-next-action-test',
        requiresUserConfirmation: false,
      },
      askUser: expect.arrayContaining([
        expect.stringContaining('--seal'),
      ]),
    });

    await writeFile(join(root, 'task-owned.txt'), 'sealed implementation\n', 'utf8');
    const sealed = await captureJsonOutput(() => main(['build', 'cli-next-action-test', '--seal', '--owned-path', 'task-owned.txt', '--root', root, '--json']));
    expect(sealed).toMatchObject({
      phase: 'hardVerify',
      success: true,
      nextSkill: '/kata-verify',
      completion: {
        phase: 'hardVerify',
        nextAction: {
          slashCommand: '/kata-verify cli-next-action-test',
          cliCommand: 'kata verify --change cli-next-action-test',
        },
        userMessage: expect.stringContaining('/kata-verify cli-next-action-test'),
      },
    });
  });

  it('passes --owned-path through build sealing so legacy tasks can be scoped at seal time', async () => {
    const root = await tempRoot();
    await writeFile(
      join(root, '.kata-config.json'),
      `${JSON.stringify(
        {
          quality: {
            buildChecks: [
              { name: 'unit', kind: 'test', command: process.execPath, args: ['-e', 'process.exit(0)'] },
            ],
          },
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
    await writeFile(join(root, 'task-owned.txt'), 'sealed implementation\n', 'utf8');
    await captureJsonOutput(() => main(['open', 'cli-build-owned-path-test', '--isolation', 'current_worktree', '--development', 'tdd', '--review', 'std', '--root', root, '--json']));
    await captureJsonOutput(() => main(['design', 'cli-build-owned-path-test', '--root', root, '--json']));

    const sealed = await captureJsonOutput(() =>
      main(['build', 'cli-build-owned-path-test', '--seal', '--owned-path', 'task-owned.txt', '--root', root, '--json']),
    );

    expect(sealed).toMatchObject({
      phase: 'hardVerify',
      success: true,
      diagnostics: {
        ownedPaths: ['task-owned.txt'],
        ownedPathsSource: 'build-option',
      },
    });
    const evidence = JSON.parse(await readFile(join(root, '.kata/evidence/cli-build-owned-path-test-hard.json'), 'utf8')) as {
      revisionId?: string;
      scope?: { paths: string[] };
    };
    expect(evidence.revisionId).toMatch(/^revision-/);
    expect(evidence.scope?.paths).toEqual(['task-owned.txt']);
  });

  it('rejects an invalid --waivers-file before running Build', async () => {
    const root = await tempRoot();
    await initLayout(root);
    await createTask({
      root,
      id: 'cli-waivers-file-test',
      title: 'CLI waiver file validation',
      acceptance: [{ id: 'AC-1', statement: 'Waiver input is validated.' }],
    });
    await writeFile(join(root, '.kata-config.json'), `${JSON.stringify({
      quality: { buildChecks: [{ name: 'unit', kind: 'test', command: process.execPath, args: ['-e', 'process.exit(0)'] }] },
    })}\n`);
    await writeFile(join(root, 'invalid-waivers.json'), '{ invalid json }\n', 'utf8');
    await captureJsonOutput(() => main(['open', 'cli-waivers-file-test', '--isolation', 'current_worktree', '--development', 'tdd', '--review', 'std', '--root', root, '--json']));
    await captureJsonOutput(() => main(['design', 'cli-waivers-file-test', '--root', root, '--json']));

    await expect(main([
      'build', 'cli-waivers-file-test', '--seal',
      '--waivers-file', join(root, 'invalid-waivers.json'),
      '--root', root, '--json',
    ])).rejects.toThrow(/waivers file/i);
  });

  it('does not expose the retired model routing CLI', async () => {
    const root = await tempRoot();
    await expect(main(['models', 'route', '--root', root])).rejects.toThrow(/Unknown command: models/);
  });

  it('orients an agent with project constraints, wiki, and next skill', async () => {
    const root = await tempRoot();
    await initLayout(root);
    await createTask({
      root,
      id: 'orient-task',
      title: 'Orient task',
      acceptance: [{ id: 'AC-1', statement: 'Orientation aggregates project constraints.' }],
    });

    const result = await captureJsonOutput(() =>
      main(['orient', '--change', 'orient-task', '--root', root, '--role', 'implementer', '--task-kind', 'implementation']),
    );

    expect(result).toMatchObject({
      command: 'orient',
      taskId: 'orient-task',
      nextSkill: '/kata-design',
      requiredReads: expect.arrayContaining(['AGENTS.md', '.llmwiki/SCHEMA.md', '.llmwiki/index.md', '.llmwiki/log.md']),
    });
    expect(result.guardInstructions).toEqual(expect.arrayContaining([expect.stringContaining('Write only to src/')]));
  });

  it('orients without project model routing configuration', async () => {
    const root = await tempRoot();
    await initLayout(root);
    await createTask({
      root,
      id: 'no-route-task',
      title: 'No route task',
      acceptance: [{ id: 'AC-1', statement: 'Orientation still works without configured model routes.' }],
    });

    const result = await captureJsonOutput(() =>
      main(['orient', '--change', 'no-route-task', '--root', root, '--role', 'implementer']),
    );

    expect(result).toMatchObject({
      command: 'orient',
      taskId: 'no-route-task',
      nextSkill: '/kata-design',
    });
    expect(result.requiredReads).toEqual(expect.arrayContaining(['AGENTS.md', '.llmwiki/SCHEMA.md']));
  });

  it('passes codegraph arguments without shell interpolation', async () => {
    const root = await tempRoot();
    const marker = join(root, 'shell-injection-marker');

    const result = await captureJsonOutput(() =>
      main(['codegraph', 'query', `safe-symbol; touch ${marker}`]),
    );

    expect(result).toMatchObject({
      command: 'codegraph query',
      args: [`safe-symbol; touch ${marker}`],
    });
    await expect(stat(marker)).rejects.toThrow();
  });
});

async function captureJsonOutput(action: () => Promise<void>): Promise<Record<string, unknown>> {
  const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  try {
    await action();
    const output = write.mock.calls.at(-1)?.[0];
    if (typeof output !== 'string') throw new Error('expected JSON console output');
    return JSON.parse(output.trim()) as Record<string, unknown>;
  } finally {
    write.mockRestore();
  }
}

async function runHook(
  script: string,
  root: string,
  payload: Record<string, unknown>,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('/home/work/.nvm/versions/node/v22.23.1/bin/node', [script, '--project-root', root], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({ exitCode: code ?? 1, stdout, stderr });
    });
    child.stdin.end(`${JSON.stringify(payload)}\n`);
  });
}
