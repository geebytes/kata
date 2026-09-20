import { renderRepairScopeGuide } from '../quality/repair-scope-guide.js';
import { adversarialGuidanceFor, automationGuidanceFor, phaseGuidanceFor } from './phase-guidance.js';

export type Platform =
    | 'codex'
    | 'claude-code'
    | 'opencode'
    | 'pi'
    | 'cursor'
    | 'windsurf'
    | 'cline'
    | 'roocode'
    | 'gemini'
    | 'github-copilot'
    | 'generic';
export type InstallScope = 'project' | 'global';

export type PlatformCapabilities = {
    skills: boolean;
    hooks: boolean;
    subAgents: boolean;
    modelSelection: boolean;
};

export type PlatformInfo = {
    platform: Platform;
    scope: InstallScope;
    detected: boolean;
    capabilities: PlatformCapabilities;
    unavailable: string[];
    root: string;
};

export type SkillCommand = {
    id: string;
    slashCommand: `/kata${string}`;
    cli: string;
    phase: string;
    summary: string;
    triggerScenarios: string[];
    inputSignals: string[];
    outputGoals: string[];
};

export type InstallMode = 'copy' | 'symlink';
export type ResponseLanguage = 'en' | 'zh';

export type InstallOptions = {
    root?: string;
    home?: string;
    dryRun?: boolean;
    force?: boolean;
    wikiFrom?: string;
    noWiki?: boolean;
    mode?: InstallMode;
    language?: ResponseLanguage;
};

export type PlatformComponentState = {
    skills: 'absent' | 'current' | 'stale';
    rules: 'absent' | 'current' | 'stale';
    hooks: 'absent' | 'current' | 'stale';
    contract: 'absent' | 'current' | 'stale';
};

export type PlatformInstallState = {
    platform: PlatformInfo;
    components: PlatformComponentState;
};

export type InstallReport = {
    platform: Platform;
    scope: InstallScope;
    planned: string[];
    written: string[];
    removed: string[];
    conflicts: string[];
    unchanged: string[];
    dryRun: boolean;
    wiki?: {
        status: 'initialized' | 'existing' | 'skipped' | 'planned';
        path?: string;
        from?: string;
        importedCount?: number;
        reason?: string;
    };
};

export const skillCommands = [
    {
        id: 'kata',
        slashCommand: '/kata',
        cli: 'kata-cli status',
        phase: 'dispatch',
        summary: 'Shows Kata task status and available next actions. Use when the user asks what to do next, wants Kata status, or needs workflow dispatch.',
        triggerScenarios: [
            'User asks what Kata phase or next action applies.',
            'Agent needs to resume an existing Kata task.',
            'Agent needs a safe entrypoint before choosing a phase skill.',
        ],
        inputSignals: ['status', 'next', 'resume', 'continue', 'dispatch', 'what now', '当前阶段', '下一步'],
        outputGoals: ['Report current phase.', 'Return the next /kata-* skill or CLI command.', 'Surface wiki/model/gate orientation requirements.'],
    },
    {
        id: 'kata-open',
        slashCommand: '/kata-open',
        cli: 'kata-cli open --change <change-id> --isolation <mode> --development <mode> --review <mode>',
        phase: 'open',
        summary: 'Opens a governed Kata task/change using the Comet-compatible lifecycle. Use when starting a new change, feature, fix, or governed task.',
        triggerScenarios: [
            'User wants to start a new governed coding change.',
            'A task needs acceptance criteria and lifecycle state before design/build.',
            'Agent needs to convert an idea into a Kata/Comet-compatible change.',
        ],
        inputSignals: ['start', 'open', 'new change', 'feature', 'fix', 'hotfix', 'tweak', '创建 change', '开始任务'],
        outputGoals: ['Create or inspect task state.', 'Decide isolation, development, and review workflow choices in the skill conversation before invoking CLI.', 'Keep /kata-design as the user-facing next step while Kata acknowledges Comet open internally.'],
    },
    {
        id: 'kata-design',
        slashCommand: '/kata-design',
        cli: 'kata-cli design --change <change-id>',
        phase: 'design',
        summary: 'Creates or refines the technical design and acceptance contract. Use when requirements, architecture, acceptance criteria, or project constraints need clarification before implementation.',
        triggerScenarios: [
            'User asks for technical design or implementation plan.',
            'Acceptance criteria or constraints are not yet concrete enough to build.',
            'Agent must align design with AGENTS.md and .llmwiki before editing code.',
        ],
        inputSignals: ['design', 'plan', 'proposal', 'architecture', 'acceptance', 'requirements', '方案', '技术设计'],
        outputGoals: ['Produce a bounded design.', 'Clarify acceptance criteria.', 'Capture durable decisions into wiki candidates where useful.'],
    },
    {
        id: 'kata-build',
        slashCommand: '/kata-build',
        cli: 'kata-cli build --change <change-id>',
        phase: 'implement',
        summary: 'Implements the accepted task slice with hard verification evidence. Use when the design and acceptance contract are ready for code or documentation changes.',
        triggerScenarios: [
            'User asks to implement an approved Kata task.',
            'The current phase is plan/implement and acceptance criteria are available.',
            'Agent needs to make code/docs changes while collecting evidence.',
        ],
        inputSignals: ['build', 'implement', 'code', '落地', '实现', '修改代码', '执行计划'],
        outputGoals: ['Apply the smallest coherent change.', 'Collect fresh test/build evidence.', 'Capture implementation discoveries into .llmwiki when relevant.'],
    },
    {
        id: 'kata-review',
        slashCommand: '/kata-review',
        cli: 'kata-cli review --change <change-id>',
        phase: 'review',
        summary: 'Use when an independent Reviewer must record review findings without running Judge.',
        triggerScenarios: ['User asks for an independent code review before judgment.', 'A completed implementation has fresh evidence.'],
        inputSignals: ['review', '审查', 'code review'],
        outputGoals: ['Enter reviewer phase.', 'Record review findings only.', 'Prepare the task for an independent Judge.'],
    },
    {
        id: 'kata-judge',
        slashCommand: '/kata-judge',
        cli: 'kata-cli judge --change <change-id>',
        phase: 'judge',
        summary: 'Use when an independent Judge must evaluate a task after Reviewer has completed.',
        triggerScenarios: ['User asks for a final judgment after review.', 'A task is already in reviewer phase.'],
        inputSignals: ['judge', '裁决', 'final gate'],
        outputGoals: ['Evaluate acceptance against evidence and findings.', 'Record a structured Judge result.'],
    },
    {
        id: 'kata-verify',
        slashCommand: '/kata-verify',
        cli: 'kata-cli verify --change <change-id>',
        phase: 'verify',
        summary: 'Runs reviewer/judge-oriented verification against task acceptance. Use when implementation needs review, CI/test evidence, judge gating, or repair scoping.',
        triggerScenarios: [
            'User asks to verify, review, audit, or judge a completed implementation.',
            'The current phase is hardVerify/review/judge.',
            'A previous judge/reviewer result requires scoped repair.',
        ],
        inputSignals: ['verify', 'review', 'judge', 'audit', 'test', 'CI', '检查', '审查', '验证'],
        outputGoals: ['Evaluate acceptance criteria against evidence.', 'Record reviewer/judge results.', 'Return scoped repair instructions on failure.'],
    },
    {
        id: 'kata-archive',
        slashCommand: '/kata-archive',
        cli: 'kata-cli archive --change <change-id>',
        phase: 'archive',
        summary: 'Archives a completed task after evidence, review, and judge gates pass. Use when a Kata change is ready for final distillation, wiki capture, and archival.',
        triggerScenarios: [
            'User wants to close or archive a completed Kata task.',
            'Evidence, reviewer, and judge gates have passed.',
            'Agent needs to distill durable decisions into governed wiki records.',
        ],
        inputSignals: ['archive', 'finish', 'complete', 'distill', 'close', '归档', '收尾', '沉淀'],
        outputGoals: ['Move task to archive phase.', 'Distill durable knowledge into .llmwiki/.kata wiki flow.', 'Preserve evidence trail for future agents.'],
    },
    {
        id: 'kata-hotfix',
        slashCommand: '/kata-hotfix',
        cli: 'kata-cli hotfix --change <change-id> --isolation <mode> --development <mode> --review <mode>',
        phase: 'hotfix',
        summary: 'Runs the constrained hotfix path for behavior fixes without new capability design. Use when the user asks for a focused bug fix or urgent repair.',
        triggerScenarios: [
            'User reports a bug requiring a narrow behavior fix.',
            'No new capability or broad design is needed.',
            'Agent should skip expansive brainstorming and preserve repair scope.',
        ],
        inputSignals: ['hotfix', 'bug', 'regression', 'broken', 'fix', '修复', '紧急', '问题'],
        outputGoals: ['Decide isolation, development, and review workflow choices before starting the repair.', 'Reproduce or identify the failure.', 'Apply a minimal fix.', 'Verify with regression evidence and archive when gates pass.'],
    },
    {
        id: 'kata-tweak',
        slashCommand: '/kata-tweak',
        cli: 'kata-cli tweak --change <change-id> --isolation <mode> --development <mode> --review <mode>',
        phase: 'tweak',
        summary: 'Runs the lightweight tweak path for local docs, prompt, copy, or configuration changes. Use when the user asks for a small non-bug adjustment.',
        triggerScenarios: [
            'User requests a small local improvement.',
            'Change is limited to docs, prompt text, copy, config, or minor workflow wording.',
            'Full feature design would be disproportionate.',
        ],
        inputSignals: ['tweak', 'small change', 'docs', 'prompt', 'copy', 'config', '微调', '文档', '配置'],
        outputGoals: ['Decide isolation, development, and review workflow choices before starting the change.', 'Apply a bounded lightweight change.', 'Run proportional verification.', 'Avoid expanding into unrelated implementation work.'],
    },
    {
        id: 'kata-wiki-enrich',
        slashCommand: '/kata-wiki-enrich',
        cli: 'kata-cli wiki task --kind enrich',
        phase: 'wiki-enrich',
        summary: 'Uses the coding agent LLM capability to enrich .llmwiki from deterministic Kata task packets. Use when initializing, enriching, linting, or distilling project wiki knowledge.',
        triggerScenarios: [
            'User asks to initialize or enrich .llmwiki from project docs.',
            'Agent needs to turn raw docs into durable concepts/entities/comparisons.',
            'Project knowledge should be captured without Kata binary calling model APIs.',
        ],
        inputSignals: ['llmwiki', 'wiki', 'knowledge', 'enrich', 'distill', '初始化 wiki', '知识沉淀', '项目上下文'],
        outputGoals: ['Read deterministic wiki task packets.', 'Synthesize project knowledge into governed wiki pages.', 'Run lint/verify and keep code correctness responsibility with CI/tests/reviewer/judge.'],
    },
    {
        id: 'kata-collect',
        slashCommand: '/kata-collect',
        cli: 'kata-cli collect',
        phase: 'collect',
        summary: 'Use when collecting work back from another coding platform after delegated Kata implementation or repair.',
        triggerScenarios: [
            'User says another platform has finished implementation or repair.',
            'Agent needs to inspect returned evidence before review, judge, archive, or repair.',
            'Delegated work must be reconciled into the current branch and Kata lifecycle.',
        ],
        inputSignals: ['collect', 'return', 'done in opencode', '回收', '做完了', '交回', '审计另一个平台', 'OpenCode 完成'],
        outputGoals: ['Discover the returned task and evidence state.', 'Ask the user to confirm the task/platform when ambiguous.', 'Run reviewer/judge/archive or produce scoped repair instructions.'],
    },
] as const satisfies readonly SkillCommand[];

export const commandManifest = skillCommands.map((command) => ({
    id: command.id,
    slashCommand: command.slashCommand,
    cli: command.cli,
    phase: command.phase,
    summary: command.summary,
}));

export const platformCapabilities: Record<Platform, PlatformCapabilities> = {
    codex: { skills: true, hooks: false, subAgents: true, modelSelection: true },
    'claude-code': { skills: true, hooks: true, subAgents: true, modelSelection: true },
    opencode: { skills: true, hooks: false, subAgents: true, modelSelection: true },
    cursor: { skills: true, hooks: false, subAgents: false, modelSelection: true },
    windsurf: { skills: true, hooks: true, subAgents: true, modelSelection: true },
    cline: { skills: true, hooks: false, subAgents: false, modelSelection: true },
    roocode: { skills: true, hooks: false, subAgents: false, modelSelection: true },
    gemini: { skills: true, hooks: true, subAgents: true, modelSelection: true },
    'github-copilot': { skills: true, hooks: true, subAgents: true, modelSelection: true },
    pi: { skills: true, hooks: false, subAgents: false, modelSelection: true },
    generic: { skills: true, hooks: false, subAgents: false, modelSelection: false },
};

export function renderSkill(command: SkillCommand, platform: Platform, options: { language?: ResponseLanguage } = {}): string {
    const capabilities = platformCapabilities[platform];
    const guardMode = capabilities.hooks ? 'skills plus platform hooks' : 'CLI/CI-only';
    const responseLanguageContent = renderResponseLanguageContract(options.language);

    const phaseContent = phaseGuidanceFor(command);

    // Verify and review are exactly the nodes where the context that produced the change is the worst available
    // judge of it, so both carry the independent adversarial step.
    const adversarialGuidance = adversarialGuidanceFor(command);

    const automationContent = automationGuidanceFor(command, platform);

    return `---
name: ${command.id}
description: ${command.summary}
---

# ${command.slashCommand}

platform: ${platform}

${responseLanguageContent ? `${responseLanguageContent}\n\n` : ''}
Use this skill to inspect the Kata ${command.phase} workflow entrypoint.

## Skill-first operating rule

Prefer the \`${command.slashCommand}\` Skill as the human-facing interface. Use \`${command.cli}\` as the deterministic fallback inside the Skill or in non-interactive scripts. If the user passes an explicit task id (e.g. "/kata-build my-task"), use it as the immutable anchor for all subsequent operations; do not re-discover via \`kata-cli status\` or same-branch resolution. If the user gives a short instruction, natural-language hint, or no parameters, discover the active/same-branch task with \`kata-cli status\`, follow relation redirects, and ask for a concise confirmation only when multiple choices remain.

## Startup checklist

Before doing task work, resolve the task and read its authoritative packet. \`kata-cli status\` reports the phase, the
next skill and the candidates; it is deliberately **light** and does not build task context.

**If the user already supplied an explicit task id, skip \`status\` entirely.** The id is the anchor, and \`orient\`
builds the one authoritative context:

\`\`\`bash
kata-cli orient --change <change-id> --role <designer|implementer|reviewer|judge|distiller> --platform ${platform} --task-kind <read|implementation|security>
kata-cli hooks activate --change <change-id> --role <designer|implementer|reviewer|judge|distiller> --platform ${platform}
\`\`\`

Otherwise discover the task first — \`status\` is enough to decide whether there is one candidate or a choice to put
to the user — and then run both commands above with the resolved values:

\`\`\`bash
kata-cli status
\`\`\`

Treat skill use as an interactive agent workflow, not a parameter-only command. First discover the active or
same-branch task and any relation redirects; if the task, role, task kind, or target platform is ambiguous, present concise options and ask the user to confirm or type a value. Do not make the user remember command-line flags. After
confirmation, run \`kata-cli orient\` with the resolved values, then read the returned task, state, context, required files,
guard instructions, relation redirects, and next skill before editing. Pass \`--with-context\` to \`kata-cli status\` only
when you want that projection without a packet. The hook activation links platform write hooks to the active Kata task so
phase/role scope is enforced while you work.

## Phase-boundary pause

Treat \`nextAction.requiresUserConfirmation=true\` as a hard stop. Do not invoke the next /kata-* skill automatically. At model trust boundaries, stop so the user can use the host platform's own model selector before continuing. Kata has no model routing configuration or route artifact.

This is mandatory at trust boundaries:

- \`implementation_gate\`: stop after design and before the first build; a platform-neutral handoff packet is already available for any receiving platform.
- \`review_gate\`: stop after /kata-verify passes before /kata-review.
- \`judge_gate\`: stop after review before /kata-judge.
- \`archive_gate\`: stop after judge before /kata-archive.

## CodeGraph-assisted code search

After reading required context and before broad file scans, use CodeGraph when code understanding, impact analysis, or test targeting is needed:

\`\`\`bash
kata-cli codegraph status
kata-cli codegraph explore "<feature, symbol, module, or error>"
kata-cli codegraph impact "<symbol-or-file>"
kata-cli codegraph affected <changed-file>...
\`\`\`

Use CodeGraph to find likely source files, call paths, dependents, and affected tests. Then verify with direct file reads and focused \`rg\` searches before editing or reviewing. If CodeGraph is unavailable or stale, note the fallback and use \`rg\` plus requiredReads; do not block the workflow solely on CodeGraph.

## Portable context handoff

Before accepting work from another agent or platform, create or verify the canonical repository packet, read every path in its requiredReads field, then acknowledge the packet with the actual platform and role.

Run kata-cli handoff verify --task <change-id> --id <handoff-id>, kata-cli handoff show --task <change-id> --id <handoff-id>, then kata-cli handoff acknowledge --task <change-id> --id <handoff-id> --platform ${platform} --role <role>.

The packet's allowed writes and guard instructions are authoritative. Model selection belongs to the host platform and never bypasses CI, tests, Reviewer, or Judge.

${adversarialGuidance}${automationContent}

\`\`\`json kata-command-manifest
${JSON.stringify(commandManifest.find((entry) => entry.id === command.id), null, 2)}
\`\`\`

## Trigger scenarios

${formatBullets(command.triggerScenarios)}

## Input signals

Keywords and intents that should trigger this skill:

${formatBullets(command.inputSignals.map((signal) => `\`${signal}\``))}

## Output goals

${formatBullets(command.outputGoals)}

## Invocation

\`\`\`bash
${command.cli}
\`\`\`

The invocation is the deterministic CLI fallback for scripts and CI. In normal agent use, prefer conversation: discover candidates, recommend defaults, ask for confirmation, then run the resolved command.

## Guard enforcement

guard enforcement: ${guardMode}

## Host model selection

Kata does not configure or route host-platform models. If this phase needs a different model, use the host platform's own selector before continuing; model choice is outside Kata state and does not create a route artifact.

${platform === 'opencode'
            ? 'OpenCode：如需切换模型，先执行 `/models` 并在其交互界面完成选择，再运行本次委托的 Kata 命令。'
            : platform === 'pi'
                ? 'Pi：如需切换模型，先执行 `/model` 完成选择，再运行本次委托的 Kata 命令。'
                : '请在当前平台的模型选择器或平台配置中完成切换，然后继续本次 Kata 命令。'}

${phaseContent}`
}

function formatBullets(items: readonly string[]): string {
    return items.map((item) => `- ${item}`).join('\n');
}

function renderResponseLanguageContract(language?: ResponseLanguage): string {
    if (language === 'zh') {
        return `## Response language

所有面向用户的自然语言响应必须使用中文。代码、命令、文件路径、API 名称、日志和协议字段可以保留原文。`;
    }
    if (language === 'en') {
        return `## Response language

All user-facing natural-language responses must be written in English. Code, commands, file paths, API names, logs, and protocol fields may remain in their original form.`;
    }
    return '';
}
