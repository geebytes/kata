import { renderRepairScopeGuide } from '../quality/repair-scope-guide.js';
import { platformAgentsDir } from './platforms.js';
import { ledgerReviewGuidanceFor, automationGuidanceFor, phaseGuidanceFor } from './phase-guidance.js';
import { GATE_CREATED_BY } from '../workflow/user-choice-gate.js';

/** The boundaries the CLI accepts, read from the table that creates them rather than restated here. */
const GATE_KEYS = Object.keys(GATE_CREATED_BY);

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
    /** The workflow entrypoint this skill inspects. Absent for a skill that carries a standing procedure rather than a phase. */
    phase?: string;
    summary: string;
    triggerScenarios: string[];
    inputSignals: string[];
    outputGoals: string[];
    /**
     * A body to render **instead of** the generic workflow-entrypoint text.
     *
     * Added for the two skills whose subject is a procedure rather than kata's own lifecycle (`kata-review-round`, `kata-host-adapter`): the
     * generic body describes resolving a task and reading its packet, which is not what either of them is for, and there is no per-phase
     * guidance that fits them either.
     *
     * **What a body must not do is restate a per-round value.** A skill that repeats the record's fields or the gate's conditions becomes a
     * second channel for a rule the brief already renders, and the measured cost of exactly that is 28 of 62 rounds producing no record
     * while a dispatch prompt carried a missing requirement by hand.
     */
    body?: string;
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
    // **`kata-review-round` and `kata-host-adapter` were here**, and are deleted with the protocol they described.
    //
    // They were the two halves of the round-shaped route's procedure: the reviewer's half (read the brief as the whole
    // instruction set, emit a record early, a round is neither a repair nor a survey) and the operator's half (launch an
    // isolated session, emit the six event kinds, declare only the capabilities you provide, never write the receipt).
    // The route they served is gone — the ledger has no round, no wire format and no executor contract — so leaving them
    // installed would ship a skill whose every command line (`kata-cli adversarial execute`) exits 1 with "unknown
    // command", which is the class this session has removed more often than any other: a declaration that outlives what
    // it declares.
    //
    // What survives from them is the discipline they encoded, and it lives where it is enforced now: a record is emitted
    // early and improved (`ledger evidence add` is incremental, so there is no single output channel to lose), a finding
    // carries its evidence rather than a fix recipe (`executable_falsifier`), and a capability is refuted rather than
    // asserted (the kernel reads what kata measured).
] as const satisfies readonly SkillCommand[];

export const commandManifest = skillCommands.map((command) => ({
    id: command.id,
    slashCommand: command.slashCommand,
    cli: command.cli,
    // A procedure skill has no workflow phase, and inventing one would put a value in the manifest that nothing means.
    ...('phase' in command && command.phase ? { phase: command.phase } : {}),
    summary: command.summary,
}));

/**
 * **What a node consumes, produces, and asks.** A node that does not say these three cannot be connected to anything:
 * measured on a real change, the review node was handed a brief the author improvised instead of the deterministic
 * output of the previous node, so its input existed as prose in one session rather than as an artefact the next node
 * could be pointed at.
 */
export type NodeInput = {
    /** What the node reads. */
    what: string;
    /** The node whose output it is, or `null` for something no node produces (a user's intent, the repository itself). */
    from: string | null;
    /** Where a reader can find it: a command that emits it, or a path an artefact lives at. */
    source: string;
};

export type NodeOutput = { what: string; artefact: string };

export type NodeQuestion = {
    /** Why the node stops. */
    why: string;
    /** The answers the gate accepts — the same set the CLI accepts, because an option it does not know cannot be completed. */
    choices: string[];
};

export type NodeContract = {
    inputs: NodeInput[];
    outputs: NodeOutput[];
    /** Empty for a node that stops for nothing: an interaction the operator cannot act on is not one. */
    interaction: NodeQuestion[];
};

const NODE_CONTRACTS: Record<string, NodeContract> = {
    'kata': {
        inputs: [{ what: 'the repository state and the task records', from: null, source: 'kata-cli status' }],
        outputs: [{ what: 'the phase and the one next action', artefact: 'status output' }],
        interaction: [],
    },
    'kata-open': {
        inputs: [{ what: 'what the user wants changed', from: null, source: 'the user' }],
        outputs: [
            { what: 'frozen acceptance criteria, the declared surface and the workflow profile', artefact: '.kata/tasks/<id>/task.json' },
        ],
        interaction: [{ why: 'the profile decides how much process the change pays for', choices: ['continue_current', 'switched', 'delegated'] }],
    },
    'kata-design': {
        inputs: [
            { what: 'the frozen acceptance criteria and the declared surface', from: 'kata-open', source: '.kata/tasks/<id>/task.json' },
            { what: 'what the code already does along the paths the change touches', from: null, source: 'the repository, via kata-cli codegraph' },
        ],
        outputs: [{ what: 'the design and the acceptance matrix', artefact: 'the design doc named by the acceptance matrix' }],
        interaction: [{ why: 'the execution mode for the build is the operator\'s to choose', choices: ['continue_current', 'switched', 'delegated'] }],
    },
    'kata-build': {
        inputs: [{ what: 'the design and the acceptance matrix', from: 'kata-design', source: 'the paths the matrix declares' }],
        outputs: [{ what: 'a sealed revision and one passing evidence item per acceptance criterion', artefact: '.kata/tasks/<id>/current-revision.json' }],
        interaction: [],
    },
    'kata-hotfix': {
        inputs: [{ what: 'the reported failure and a way to reproduce it', from: null, source: 'the user and the repository' }],
        outputs: [{ what: 'a bounded repair with regression evidence', artefact: '.kata/tasks/<id>/current-revision.json' }],
        interaction: [{ why: 'the profile decides how much process the repair pays for', choices: ['continue_current', 'switched', 'delegated'] }],
    },
    'kata-tweak': {
        inputs: [{ what: 'the bounded local adjustment', from: null, source: 'the user' }],
        outputs: [{ what: 'the adjustment with proportional verification', artefact: '.kata/tasks/<id>/current-revision.json' }],
        interaction: [{ why: 'the profile decides how much process the adjustment pays for', choices: ['continue_current', 'switched', 'delegated'] }],
    },
    'kata-verify': {
        // **The command that produces each input, named rather than assumed.** F-8: the review request this node hands on
        // is produced by `ledger run`, and the ledger guidance appended to this same skill speaks in commands while the
        // contract spoke in artefact paths — two I/O descriptions for one node, which is what invites the hand-written
        // brief the design forbids. A path is still given, with the command that puts content at it.
        inputs: [
            { what: 'the sealed revision', from: 'kata-build', source: '.kata/tasks/<id>/current-revision.json' },
            { what: 'the evidence recorded for it', from: 'kata-build', source: 'kata-cli build --change <id> --seal → .kata/evidence/<id>-*.json' },
            { what: 'the frozen plan the review request is derived from', from: 'kata-build', source: 'kata-cli ledger plan --change <id> → .kata/tasks/<id>/review/plan.json' },
        ],
        outputs: [
            { what: 'the verification result and any workspace drift', artefact: 'kata-cli verify --change <id> → .kata/tasks/<id>/verify.json' },
            { what: 'the review request handed to the review node: each claim, its reading set, the evidence its tier requires, the deadline and the probes', artefact: 'kata-cli ledger run --change <id> --out <path>' },
        ],
        interaction: [{ why: 'the reviewer\'s model is chosen on the host platform, and kata records only which choice was made', choices: ['continue_current', 'switched', 'delegated'] }],
    },
    'kata-review': {
        inputs: [
            { what: 'the review request: each claim, its reading set, the evidence its tier requires, the deadline and the probes', from: 'kata-verify', source: 'kata-cli ledger run --change <id> --out <path>' },
        ],
        outputs: [
            { what: 'the structured review result returned by the subagent and recorded by the invoking Skill', artefact: 'kata-cli review --change <id> --result-file <path> → .kata/tasks/<id>/review.json' },
            { what: 'the decision derived from the evidence', artefact: 'kata-cli ledger decide --change <id>' },
        ],
        interaction: [{ why: 'the judge\'s model is chosen on the host platform, and kata records only which choice was made', choices: ['continue_current', 'switched', 'delegated'] }],
    },
    'kata-judge': {
        inputs: [
            { what: 'the review findings and the approved revision', from: 'kata-review', source: '.kata/tasks/<id>/review.json' },
            { what: 'the decision derived from the evidence', from: null, source: 'kata-cli ledger decide --change <id>' },
        ],
        outputs: [{ what: 'the judge result for the current revision', artefact: '.kata/tasks/<id>/judge.json' }],
        interaction: [{ why: 'the archive decision after a judge result is the operator\'s', choices: ['continue_current', 'switched', 'delegated'] }],
    },
    'kata-archive': {
        inputs: [
            { what: 'the judge result for the current revision', from: 'kata-judge', source: '.kata/tasks/<id>/judge.json' },
            { what: 'the knowledge closure decision and its reason', from: null, source: '.kata/tasks/<id>/wiki-closure.json' },
        ],
        outputs: [{ what: 'the archived task record and the distilled wiki pages', artefact: '.kata/tasks/<id>/' }],
        interaction: [{ why: 'archiving is the operator\'s decision, and it is the last one the change gets', choices: ['continue_current', 'switched', 'delegated'] }],
    },
    'kata-wiki-enrich': {
        inputs: [{ what: 'the raw project sources under the wiki store\'s raw tree', from: null, source: '.llmwiki/raw/' }],
        outputs: [{ what: 'synthesised wiki pages, linted and registered', artefact: '.llmwiki/concepts/' }],
        interaction: [],
    },
    'kata-collect': {
        inputs: [{ what: 'what the other platform returned: branch, revision and evidence', from: null, source: 'kata-cli collect' }],
        outputs: [{ what: 'the reconciled task state and a scoped repair when one is needed', artefact: 'kata-cli status' }],
        interaction: [{ why: 'which platform ran the work is the operator\'s to state, because kata does not infer it', choices: ['continue_current', 'switched', 'delegated'] }],
    },
};

/** The declared contract for a node, or `null` for a skill that carries a standing procedure rather than a phase. */
export function nodeContractFor(id: string): NodeContract | null {
    return NODE_CONTRACTS[id] ?? null;
}

function renderNodeContract(command: SkillCommand): string {
    const contract = nodeContractFor(command.id);
    if (contract === null || !command.phase) return '';
    const inputs = contract.inputs
        .map((input) => `- **${input.what}**${input.from === null ? '' : ` — from \`${input.from}\``} — \`${input.source}\``)
        .join('\n');
    const outputs = contract.outputs.map((output) => `- **${output.what}** — \`${output.artefact}\``).join('\n');
    const interaction = contract.interaction.length === 0
        ? '- Nothing: this node does not stop for an operator decision.'
        : contract.interaction
            .map((question) => `- **${question.why}** — \`kata-cli gate approve --task <id> --boundary <${GATE_KEYS.join('|')}> --choice <${question.choices.join('|')}>\``)
            .join('\n');
    return `## Node contract

What this node consumes, produces, and asks. The input of a node is the **deterministic output of the previous node**,
not a summary of it: hand a reader the artefact itself, so the next node can be pointed at the same thing.

**Inputs**

${inputs}

**Outputs**

${outputs}

**Interaction**

${interaction}
`;
}

/**
 * The manifest as a value a verifier can read: it carries the node contract, so the connections a rendered skill
 * describes can be checked without parsing prose — an input that names a node, an output that names an artefact, and the
 * answers a gate takes.
 */
export type ManifestEntry = (typeof commandManifest)[number] & { contract?: NodeContract | null };

export const manifestWithContracts: ManifestEntry[] = commandManifest.map((entry) => ({
    ...entry,
    ...(nodeContractFor(entry.id) === null ? {} : { contract: nodeContractFor(entry.id) }),
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
    pi: { skills: true, hooks: false, subAgents: true, modelSelection: true },
    generic: { skills: true, hooks: false, subAgents: false, modelSelection: false },
};

export function renderSkill(command: SkillCommand, platform: Platform, options: { language?: ResponseLanguage } = {}): string {
    if (command.body) {
        // A skill that owns its text answers to the same contract as the generated ones — frontmatter, the platform it was rendered for, and the
        // response-language rule — and skips everything that is about kata's lifecycle, because its subject is not that lifecycle.
        const declaredLanguage = renderResponseLanguageContract(options.language);
        // A rendered skill is a contract, not just prose: every platform's copy carries the platform line, the response-language rule, the
        // invocation it stands for, and the machine-readable manifest the golden test reads. A body skill answers to the same four and skips
        // only what is about kata's own lifecycle.
        return `---
name: ${command.id}
description: ${command.summary}
---

# ${command.slashCommand}

platform: ${platform}

${declaredLanguage ? `${declaredLanguage}\n\n` : ''}${command.body.trim()}

## Invocation

\`${command.cli}\`

\`\`\`json kata-command-manifest
${JSON.stringify(commandManifest.find((entry) => entry.id === command.id), null, 2)}
\`\`\`
`;
    }
    const capabilities = platformCapabilities[platform];
    const guardMode = capabilities.hooks ? 'skills plus platform hooks' : 'CLI/CI-only';
    const responseLanguageContent = renderResponseLanguageContract(options.language);

    // Only reached without a body, which is every workflow-entrypoint skill: those all declare a phase, and the fallback keeps the type honest
    // for a skill that someday carries neither.
    const phaseContent = phaseGuidanceFor({ id: command.id, slashCommand: command.slashCommand, cli: command.cli, phase: command.phase ?? '' });

    // Verify and review are exactly the nodes where the context that produced the change is the worst available
    // judge of it, so both carry the independent adversarial step.
    const reviewGuidance = ledgerReviewGuidanceFor(command);

    const nodeContractContent = renderNodeContract(command);

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

${nodeContractContent}${reviewGuidance}${automationContent}

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

/**
 * **The agents Kata asks a platform to define, as data rather than as hand-written files.**
 *
 * A definition is what the *host* owns: which tools an agent is given, which extension registration it needs, and the
 * measured isolation boundary around both. The protocol is not here and must not be — it has one source and is rendered
 * into the skills, because a second copy drifts: measured on one machine, **55 hand-written copies** of `kata-reviewer.md`
 * existed when the protocol changed under them, and every copy kept instructing the retired behaviour until each was edited
 * by hand.
 *
 * **`isolated` is deliberately absent from every entry.** The flag reads as "more isolation" and is not: on this host it
 * overrides `extensions` to `false` in the runner, which cuts the registration the agent needs to reach its routed model
 * provider — a measured failure that presents as an unavailable provider rather than as a missing extension. Cold context is
 * a property of the *dispatch* (`inherit_context: false`), not of the definition, so it belongs where the dispatch is made.
 */
export interface AgentDefinitionSpec {
    id: string;
    description: string;
    /** The skill carrying this agent's protocol; the definition points at it and restates nothing from it. */
    protocolSkill: string;
    /** Further skills the same agent is told to read, named so the pointer is complete rather than partial. */
    alsoReads?: string[];
    tools: string[];
    extensions?: string[];
    /** What this file owns, in the order the sections are rendered. */
    owns: Array<{ heading: string; body: string }>;
}

export const agentDefinitions: readonly AgentDefinitionSpec[] = [
    {
        id: 'kata-reviewer',
        description: 'Independent reviewer for one kata governed change, dispatched cold against a sealed revision. Use it for a review round and nothing else — never to author, repair, or re-review a change this session touched. Its protocol lives in the kata-review skill.',
        protocolSkill: 'kata-review',
        tools: ['read', 'grep', 'find', 'ls', 'bash'],
        extensions: ['pi-esuyo-custom-provider'],
        owns: [
            {
                heading: 'What you are handed',
                body: 'A **ReviewRequest**, as your payload, and nothing else — no author-written brief. It carries the claims, each one\'s reading set, the evidence each requires, a deadline, and the questions you are asked. A question the request did not hand you is not yours to answer: it asks about content the request deliberately does not speak for.\n\nThe payload also carries `reviewKind`, and the result has to answer the same one: `certification` reviews the sealed revision as a whole, `focused_followup` verifies the previous round\'s repair batch and its dependency cone, and `root_cause` produces the closure contract for a recurring class instead of another certification. Nothing chooses the kind — it is derived from the change\'s own records — and a result naming a different one is refused rather than filed, because a follow-up that widens itself back to the whole change is how a repair loop re-finds a defect in its own fix every round.\n\nIf the payload includes `recurrencePacket`, it has activated a different review mode. Follow the **Recurrence circuit breaker** section in `.agents/skills/kata-review/SKILL.md`: reconstruct the recorded history before ordinary certification work, and return the required `recurrenceAnalysis`. This is a pointer to the single protocol source, not a second copy of that protocol.\n\nThe request also carries `reviewPackage.declaration.acceptanceAmendments`. When it is a non-empty list, an acceptance criterion was **corrected after the seal** (`kata-cli tasks amend-acceptance`), and the correction is part of what you are reviewing: the entry names the old text, the new text, the reason, the actor and the revision whose certification the correction voided. Judge the correction itself — whether it narrows what the change must do, moves the bar to match the implementation instead of the implementation to match the bar, or merely restates the same claim — rather than only the corrected sentence. When it reads `{ unreadable }`, that is a named hole: say so rather than assuming the contract was never corrected.',
            },
            {
                heading: 'What this file owns',
                body: 'Your **tool surface** — `read`, `grep`, `find`, `ls`, `bash`. The shell is not a convenience: a review is decided by *measurement*, and every reading it rests on comes from running something — the declared check, the change that has to falsify it, and the state of the checkout afterwards. A definition without a shell can only read other people\'s claims about those runs, which is how a round becomes a summary instead of a check.\n\nRead-only is therefore a **commitment, not a sandbox**. With a shell you *can* write, and what keeps the review independent is that you do not: never repair, reformat, or "just fix" what you are reviewing, because a review that repairs what it reviews has replaced the judgement rather than informed it and its evidence becomes its own work. When you need scratch space, it is `tmp/`, never a tracked path.\n\nYour **extension registration** (`extensions:` above), because a cold context does not inherit the provider this session registered at startup — a dispatch without it fails with a message that reads like a typo and is not one.',
            },
            {
                heading: 'The isolation boundary, as measured',
                body: 'Read-only here is a property of the `tools` allowlist and of a cold context. It is **not** a property of process isolation, and trying to express it as one breaks the round before it starts:\n\n- `isolated: true` overrides `extensions` to `false` in the runner. That cuts off the extension which registers the routed model provider, so the child cannot resolve the provider and its requests leave for the upstream directly, which refuses them.\n- `extensions: false` cuts the same registration one level down — same failure.\n- Loading every extension (`extensions: true`, or omitting the field) does reach the provider, but injects **every** extension tool into the round (measured: 53 tools).\n\n`extensions: [pi-esuyo-custom-provider]` is the combination that works: the allowlist loads exactly the one extension that registers the provider — which registers **no tools** — while the `tools:` list above keeps the round\'s tool surface to five. Anything that reads as "more isolation" here costs the round its provider.\n\nA separate dispatch path reads no agent definition at all and disables extension discovery for every child, so a dispatch through it must name this same extension in the call; that is a fact about the dispatcher, not about this file.',
            },
        ],
    },
    {
        id: 'kata-implementer',
        description: 'A repair author for a kata governed change. Writes only inside a scratch copy of the change, and reports what it changed rather than editing the change itself.',
        protocolSkill: 'kata-build',
        alsoReads: ['kata-verify'],
        tools: ['read', 'grep', 'find', 'ls', 'edit', 'write', 'bash'],
        extensions: ['pi-esuyo-custom-provider'],
        owns: [
            {
                heading: 'What you are handed',
                body: 'The fact that a specific claim, at a specific severity, does not hold — with the reason it does not — rather than prose about a finding. How that fact is read, and what a repair owes it, is the skill\'s repair loop.',
            },
            {
                heading: 'What this file owns',
                body: 'Your **tool surface** — the four read tools plus `edit`, `write` and `bash`, because a repair is a change to a file. It is the write access that distinguishes this definition from the reviewer\'s, and it is confined by the protocol you were pointed at: a repair that edits the change it is repairing cannot be reviewed by anyone, including the round that comes next.\n\nYour **extension registration** (`extensions:` above), for the same measured reason the reviewer carries one: a cold context does not inherit the provider this session registered at startup, and `isolated: true` would set `extensions` to `false` — the combination that makes the provider unresolvable. Cold context comes from the dispatch (`inherit_context: false`), not from this file.\n\nA repair author that inherits this session\'s context inherits the blind spot it was dispatched to avoid, which is why the dispatch is cold — measured on this line, seven of the tests written during repairs could not fail, and every one of those was written by the author whose blind spot the round existed to find.',
            },
        ],
    },
];

/**
 * Render one agent definition for a platform.
 *
 * `null` when the platform declares no agents directory — the capability is what decides, so a platform that does not carry
 * sub-agent definitions is not written one (and `kata-cli update` reports nothing for it rather than an empty file).
 */
export function renderAgentDefinition(
    agentId: string,
    platform: Platform,
    options: { language?: ResponseLanguage } = {},
): string | null {
    if (platformAgentsDir(platform, 'project') === null) return null;
    const spec = agentDefinitions.find((entry) => entry.id === agentId);
    if (spec === undefined) return null;
    const frontmatter = [
        `name: ${spec.id}`,
        `description: ${spec.description}`,
        `tools: ${spec.tools.join(', ')}`,
        ...(spec.extensions === undefined ? [] : [`extensions: [${spec.extensions.join(', ')}]`]),
    ].join('\n');
    const pointer = [
        `Read \`.agents/skills/${spec.protocolSkill}/SKILL.md\` first — it is rendered by \`kata-cli update\` from the single`,
        'source that carries this agent\'s protocol, so it is the current one.',
        ...(spec.alsoReads ?? []).map((skill) => `The repair loop it hands you runs in \`.agents/skills/${skill}/SKILL.md\`.`),
    ].join(' ').trim();
    const sections = spec.owns.map((section) => `## ${section.heading}\n\n${section.body}`).join('\n\n');
    const language = renderResponseLanguageContract(options.language);
    return `---
${frontmatter}
---

**This file owns what the host owns: your tool surface, your extension registration, and the isolation boundary around both.
The protocol is not here.** ${pointer}

${language ? `${language}\n\n` : ''}${sections}

### Why this file is thin

A hand-copied protocol drifts, and it drifts silently. Fifty-five hand-written copies of the reviewer's definition existed on
one machine when the protocol changed under them, and every copy kept instructing the retired behaviour until each was edited
by hand. This one is rendered, so an edit reaches it the same way it reaches the skills.
`;
}
