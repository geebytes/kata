export type Platform = 'codex' | 'claude-code' | 'opencode' | 'cursor' | 'windsurf' | 'cline' | 'roocode' | 'gemini' | 'github-copilot' | 'generic';
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
export declare const skillCommands: readonly [{
    readonly id: "kata";
    readonly slashCommand: "/kata";
    readonly cli: "kata status";
    readonly phase: "dispatch";
    readonly summary: "Shows Kata task status and available next actions. Use when the user asks what to do next, wants Kata status, or needs workflow dispatch.";
    readonly triggerScenarios: ["User asks what Kata phase or next action applies.", "Agent needs to resume an existing Kata task.", "Agent needs a safe entrypoint before choosing a phase skill."];
    readonly inputSignals: ["status", "next", "resume", "continue", "dispatch", "what now", "当前阶段", "下一步"];
    readonly outputGoals: ["Report current phase.", "Return the next /kata-* skill or CLI command.", "Surface wiki/model/gate orientation requirements."];
}, {
    readonly id: "kata-open";
    readonly slashCommand: "/kata-open";
    readonly cli: "kata open --change <change-id> --isolation <mode> --development <mode> --review <mode>";
    readonly phase: "open";
    readonly summary: "Opens a governed Kata task/change using the Comet-compatible lifecycle. Use when starting a new change, feature, fix, or governed task.";
    readonly triggerScenarios: ["User wants to start a new governed coding change.", "A task needs acceptance criteria and lifecycle state before design/build.", "Agent needs to convert an idea into a Kata/Comet-compatible change."];
    readonly inputSignals: ["start", "open", "new change", "feature", "fix", "hotfix", "tweak", "创建 change", "开始任务"];
    readonly outputGoals: ["Create or inspect task state.", "Decide isolation, development, and review workflow choices in the skill conversation before invoking CLI.", "Keep /kata-design as the user-facing next step while Kata acknowledges Comet open internally."];
}, {
    readonly id: "kata-design";
    readonly slashCommand: "/kata-design";
    readonly cli: "kata design --change <change-id>";
    readonly phase: "design";
    readonly summary: "Creates or refines the technical design and acceptance contract. Use when requirements, architecture, acceptance criteria, or project constraints need clarification before implementation.";
    readonly triggerScenarios: ["User asks for technical design or implementation plan.", "Acceptance criteria or constraints are not yet concrete enough to build.", "Agent must align design with AGENTS.md and .llmwiki before editing code."];
    readonly inputSignals: ["design", "plan", "proposal", "architecture", "acceptance", "requirements", "方案", "技术设计"];
    readonly outputGoals: ["Produce a bounded design.", "Clarify acceptance criteria.", "Capture durable decisions into wiki candidates where useful."];
}, {
    readonly id: "kata-build";
    readonly slashCommand: "/kata-build";
    readonly cli: "kata build --change <change-id>";
    readonly phase: "implement";
    readonly summary: "Implements the accepted task slice with hard verification evidence. Use when the design and acceptance contract are ready for code or documentation changes.";
    readonly triggerScenarios: ["User asks to implement an approved Kata task.", "The current phase is plan/implement and acceptance criteria are available.", "Agent needs to make code/docs changes while collecting evidence."];
    readonly inputSignals: ["build", "implement", "code", "落地", "实现", "修改代码", "执行计划"];
    readonly outputGoals: ["Apply the smallest coherent change.", "Collect fresh test/build evidence.", "Capture implementation discoveries into .llmwiki when relevant."];
}, {
    readonly id: "kata-review";
    readonly slashCommand: "/kata-review";
    readonly cli: "kata review --change <change-id>";
    readonly phase: "review";
    readonly summary: "Use when an independent Reviewer must record review findings without running Judge.";
    readonly triggerScenarios: ["User asks for an independent code review before judgment.", "A completed implementation has fresh evidence."];
    readonly inputSignals: ["review", "审查", "code review"];
    readonly outputGoals: ["Enter reviewer phase.", "Record review findings only.", "Prepare the task for an independent Judge."];
}, {
    readonly id: "kata-judge";
    readonly slashCommand: "/kata-judge";
    readonly cli: "kata judge --change <change-id>";
    readonly phase: "judge";
    readonly summary: "Use when an independent Judge must evaluate a task after Reviewer has completed.";
    readonly triggerScenarios: ["User asks for a final judgment after review.", "A task is already in reviewer phase."];
    readonly inputSignals: ["judge", "裁决", "final gate"];
    readonly outputGoals: ["Evaluate acceptance against evidence and findings.", "Record a structured Judge result."];
}, {
    readonly id: "kata-verify";
    readonly slashCommand: "/kata-verify";
    readonly cli: "kata verify --change <change-id>";
    readonly phase: "verify";
    readonly summary: "Runs reviewer/judge-oriented verification against task acceptance. Use when implementation needs review, CI/test evidence, judge gating, or repair scoping.";
    readonly triggerScenarios: ["User asks to verify, review, audit, or judge a completed implementation.", "The current phase is hardVerify/review/judge.", "A previous judge/reviewer result requires scoped repair."];
    readonly inputSignals: ["verify", "review", "judge", "audit", "test", "CI", "检查", "审查", "验证"];
    readonly outputGoals: ["Evaluate acceptance criteria against evidence.", "Record reviewer/judge results.", "Return scoped repair instructions on failure."];
}, {
    readonly id: "kata-archive";
    readonly slashCommand: "/kata-archive";
    readonly cli: "kata archive --change <change-id>";
    readonly phase: "archive";
    readonly summary: "Archives a completed task after evidence, review, and judge gates pass. Use when a Kata change is ready for final distillation, wiki capture, and archival.";
    readonly triggerScenarios: ["User wants to close or archive a completed Kata task.", "Evidence, reviewer, and judge gates have passed.", "Agent needs to distill durable decisions into governed wiki records."];
    readonly inputSignals: ["archive", "finish", "complete", "distill", "close", "归档", "收尾", "沉淀"];
    readonly outputGoals: ["Move task to archive phase.", "Distill durable knowledge into .llmwiki/.kata wiki flow.", "Preserve evidence trail for future agents."];
}, {
    readonly id: "kata-hotfix";
    readonly slashCommand: "/kata-hotfix";
    readonly cli: "kata hotfix --change <change-id> --isolation <mode> --development <mode> --review <mode>";
    readonly phase: "hotfix";
    readonly summary: "Runs the constrained hotfix path for behavior fixes without new capability design. Use when the user asks for a focused bug fix or urgent repair.";
    readonly triggerScenarios: ["User reports a bug requiring a narrow behavior fix.", "No new capability or broad design is needed.", "Agent should skip expansive brainstorming and preserve repair scope."];
    readonly inputSignals: ["hotfix", "bug", "regression", "broken", "fix", "修复", "紧急", "问题"];
    readonly outputGoals: ["Decide isolation, development, and review workflow choices before starting the repair.", "Reproduce or identify the failure.", "Apply a minimal fix.", "Verify with regression evidence and archive when gates pass."];
}, {
    readonly id: "kata-tweak";
    readonly slashCommand: "/kata-tweak";
    readonly cli: "kata tweak --change <change-id> --isolation <mode> --development <mode> --review <mode>";
    readonly phase: "tweak";
    readonly summary: "Runs the lightweight tweak path for local docs, prompt, copy, or configuration changes. Use when the user asks for a small non-bug adjustment.";
    readonly triggerScenarios: ["User requests a small local improvement.", "Change is limited to docs, prompt text, copy, config, or minor workflow wording.", "Full feature design would be disproportionate."];
    readonly inputSignals: ["tweak", "small change", "docs", "prompt", "copy", "config", "微调", "文档", "配置"];
    readonly outputGoals: ["Decide isolation, development, and review workflow choices before starting the change.", "Apply a bounded lightweight change.", "Run proportional verification.", "Avoid expanding into unrelated implementation work."];
}, {
    readonly id: "kata-wiki-enrich";
    readonly slashCommand: "/kata-wiki-enrich";
    readonly cli: "kata wiki task --kind enrich";
    readonly phase: "wiki-enrich";
    readonly summary: "Uses the coding agent LLM capability to enrich .llmwiki from deterministic Kata task packets. Use when initializing, enriching, linting, or distilling project wiki knowledge.";
    readonly triggerScenarios: ["User asks to initialize or enrich .llmwiki from project docs.", "Agent needs to turn raw docs into durable concepts/entities/comparisons.", "Project knowledge should be captured without Kata binary calling model APIs."];
    readonly inputSignals: ["llmwiki", "wiki", "knowledge", "enrich", "distill", "初始化 wiki", "知识沉淀", "项目上下文"];
    readonly outputGoals: ["Read deterministic wiki task packets.", "Synthesize project knowledge into governed wiki pages.", "Run lint/verify and keep code correctness responsibility with CI/tests/reviewer/judge."];
}, {
    readonly id: "kata-collect";
    readonly slashCommand: "/kata-collect";
    readonly cli: "kata collect";
    readonly phase: "collect";
    readonly summary: "Use when collecting work back from another coding platform after delegated Kata implementation or repair.";
    readonly triggerScenarios: ["User says another platform has finished implementation or repair.", "Agent needs to inspect returned evidence before review, judge, archive, or repair.", "Delegated work must be reconciled into the current branch and Kata lifecycle."];
    readonly inputSignals: ["collect", "return", "done in opencode", "回收", "做完了", "交回", "审计另一个平台", "OpenCode 完成"];
    readonly outputGoals: ["Discover the returned task and evidence state.", "Ask the user to confirm the task/platform when ambiguous.", "Run reviewer/judge/archive or produce scoped repair instructions."];
}];
export declare const commandManifest: {
    id: "kata" | "kata-open" | "kata-design" | "kata-build" | "kata-review" | "kata-judge" | "kata-verify" | "kata-archive" | "kata-hotfix" | "kata-tweak" | "kata-wiki-enrich" | "kata-collect";
    slashCommand: "/kata" | "/kata-open" | "/kata-design" | "/kata-build" | "/kata-review" | "/kata-judge" | "/kata-verify" | "/kata-archive" | "/kata-hotfix" | "/kata-tweak" | "/kata-wiki-enrich" | "/kata-collect";
    cli: "kata status" | "kata open --change <change-id> --isolation <mode> --development <mode> --review <mode>" | "kata design --change <change-id>" | "kata build --change <change-id>" | "kata review --change <change-id>" | "kata judge --change <change-id>" | "kata verify --change <change-id>" | "kata archive --change <change-id>" | "kata hotfix --change <change-id> --isolation <mode> --development <mode> --review <mode>" | "kata tweak --change <change-id> --isolation <mode> --development <mode> --review <mode>" | "kata wiki task --kind enrich" | "kata collect";
    phase: "archive" | "review" | "judge" | "dispatch" | "open" | "hotfix" | "tweak" | "design" | "implement" | "verify" | "wiki-enrich" | "collect";
    summary: "Shows Kata task status and available next actions. Use when the user asks what to do next, wants Kata status, or needs workflow dispatch." | "Opens a governed Kata task/change using the Comet-compatible lifecycle. Use when starting a new change, feature, fix, or governed task." | "Creates or refines the technical design and acceptance contract. Use when requirements, architecture, acceptance criteria, or project constraints need clarification before implementation." | "Implements the accepted task slice with hard verification evidence. Use when the design and acceptance contract are ready for code or documentation changes." | "Use when an independent Reviewer must record review findings without running Judge." | "Use when an independent Judge must evaluate a task after Reviewer has completed." | "Runs reviewer/judge-oriented verification against task acceptance. Use when implementation needs review, CI/test evidence, judge gating, or repair scoping." | "Archives a completed task after evidence, review, and judge gates pass. Use when a Kata change is ready for final distillation, wiki capture, and archival." | "Runs the constrained hotfix path for behavior fixes without new capability design. Use when the user asks for a focused bug fix or urgent repair." | "Runs the lightweight tweak path for local docs, prompt, copy, or configuration changes. Use when the user asks for a small non-bug adjustment." | "Uses the coding agent LLM capability to enrich .llmwiki from deterministic Kata task packets. Use when initializing, enriching, linting, or distilling project wiki knowledge." | "Use when collecting work back from another coding platform after delegated Kata implementation or repair.";
}[];
export declare const platformCapabilities: Record<Platform, PlatformCapabilities>;
export declare function renderSkill(command: SkillCommand, platform: Platform, options?: {
    language?: ResponseLanguage;
}): string;
//# sourceMappingURL=manifest.d.ts.map