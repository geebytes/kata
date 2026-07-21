export const skillCommands = [
    {
        id: 'kata',
        slashCommand: '/kata',
        cli: 'kata status',
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
        cli: 'kata open --change <change-id> --isolation <mode> --development <mode> --review <mode>',
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
        cli: 'kata design --change <change-id>',
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
        cli: 'kata build --change <change-id>',
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
        cli: 'kata review --change <change-id>',
        phase: 'review',
        summary: 'Use when an independent Reviewer must record review findings without running Judge.',
        triggerScenarios: ['User asks for an independent code review before judgment.', 'A completed implementation has fresh evidence.'],
        inputSignals: ['review', '审查', 'code review'],
        outputGoals: ['Enter reviewer phase.', 'Record review findings only.', 'Prepare the task for an independent Judge.'],
    },
    {
        id: 'kata-judge',
        slashCommand: '/kata-judge',
        cli: 'kata judge --change <change-id>',
        phase: 'judge',
        summary: 'Use when an independent Judge must evaluate a task after Reviewer has completed.',
        triggerScenarios: ['User asks for a final judgment after review.', 'A task is already in reviewer phase.'],
        inputSignals: ['judge', '裁决', 'final gate'],
        outputGoals: ['Evaluate acceptance against evidence and findings.', 'Record a structured Judge result.'],
    },
    {
        id: 'kata-verify',
        slashCommand: '/kata-verify',
        cli: 'kata verify --change <change-id>',
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
        cli: 'kata archive --change <change-id>',
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
        cli: 'kata hotfix --change <change-id> --isolation <mode> --development <mode> --review <mode>',
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
        cli: 'kata tweak --change <change-id> --isolation <mode> --development <mode> --review <mode>',
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
        cli: 'kata wiki task --kind enrich',
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
        cli: 'kata collect',
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
];
export const commandManifest = skillCommands.map((command) => ({
    id: command.id,
    slashCommand: command.slashCommand,
    cli: command.cli,
    phase: command.phase,
    summary: command.summary,
}));
export const platformCapabilities = {
    codex: { skills: true, hooks: false, subAgents: true, modelSelection: true },
    'claude-code': { skills: true, hooks: true, subAgents: true, modelSelection: true },
    opencode: { skills: true, hooks: false, subAgents: true, modelSelection: true },
    cursor: { skills: true, hooks: false, subAgents: false, modelSelection: true },
    windsurf: { skills: true, hooks: true, subAgents: true, modelSelection: true },
    cline: { skills: true, hooks: false, subAgents: false, modelSelection: true },
    roocode: { skills: true, hooks: false, subAgents: false, modelSelection: true },
    gemini: { skills: true, hooks: true, subAgents: true, modelSelection: true },
    'github-copilot': { skills: true, hooks: true, subAgents: true, modelSelection: true },
    generic: { skills: true, hooks: false, subAgents: false, modelSelection: false },
};
export function renderSkill(command, platform, options = {}) {
    const capabilities = platformCapabilities[platform];
    const guardMode = capabilities.hooks ? 'skills plus platform hooks' : 'CLI/CI-only';
    const responseLanguageContent = renderResponseLanguageContract(options.language);
    const phaseContent = command.id === 'kata'
        ? `## Smart dispatch

Read the current task state and upstream artifacts to determine the next action:

\`\`\`bash
kata status  # show current phase and next skill
\`\`\`

For a specific change:

\`\`\`bash
kata status --change <change-id>
\`\`\`

With one active or same-branch task, the output includes a \`nextSkill\` field that tells you which /kata-* command can happen next. With multiple same-branch tasks, \`kata status\` returns \`candidates\` and a \`recommended\` action. Prefer the recommendation and ask the user for a short confirmation instead of asking them to remember command-line flags or change ids.

When \`phase === "dispatch" && candidates.length === 0 && recommended === null\`, do not display raw CLI diagnostics and do not ask for a task id, change id, or CLI flags. Tell the user: “当前分支没有活跃的 Kata 任务。你想开启什么工作？请用一句话描述目标，例如‘修复登录超时’或‘新增导出功能’。” Wait for their answer. 收到自然语言目标后，进入 /kata-open；由该 Skill 解释并确认隔离、开发和审查方式，然后使用显式参数调用 \`kata open\`。

Skill-first rule: treat slash-command Skills as the user interface and CLI commands as the deterministic execution layer inside the Skill. A user should be able to say \`/kata-build 修复代码规范\` or \`继续\`; the Skill must discover the task, relation redirects, current phase, and next action before asking for missing choices. Do not ask the user to run \`kata build --change ...\` unless the host platform cannot execute shell commands.

Workflow control is task-scoped: Change is the target/scope container, Task is the smallest governed control unit, Artifact is evidence, and Step is agent-local execution detail. Do not drive build/review/judge from a Change directly; resolve the canonical Task first.

If a placeholder task or earlier change is covered by a more specific governed task, do not ask future agents to guess. Record the relation:

\`\`\`bash
kata tasks relate --from <source-task> --to <target-task> --type <covered_by|superseded_by|duplicate_of|merged_into> --reason "<why>"
\`\`\`

\`kata status --change <source-task>\` and \`kata orient --change <source-task>\` follow terminal relations and return \`relationRedirects\`.

For change-to-task, task-to-change, and change-to-change context, use the generic graph:

\`\`\`bash
kata relations add --from change:<change-id> --to task:<task-id> --type contains --reason "<why>"
kata relations add --from task:<task-id> --to change:<change-id> --type implements --reason "<why>"
kata relations show --id change:<change-id>
\`\`\`

Ownership and lineage edges enrich context. Only task-to-task terminal control edges should redirect \`status\`/\`orient\`.

Recommendations are derived from upstream platform outputs in this order: blocking \`review.json\` findings, failed \`judge.json\` repair scopes, failing evidence, failed \`verify.json\` repair scopes, \`hardVerify\` awaiting verify, \`review\` awaiting Judge, then ordinary build/design work.

If \`nextAction.requiresUserConfirmation=true\`, stop at that boundary. Do not invoke the next skill automatically. At \`implementation_gate\`, let the user choose current-platform execution, a low-tier delegated slice, or another platform. At \`review_gate\` and \`judge_gate\`, let the user use the host platform's own model selector before continuing. Kata does not configure, route, or verify host-platform models. \`archive_gate\` remains an explicit user archive decision.

The phase dispatch mapping is:

| Phase | Next Skill |
|-------|-----------|
| \`intake\` | \`/kata-design\` |
| \`plan\` | \`/kata-build\` |
| \`implement\` | \`/kata-build\` |
| \`hardVerify\` | \`/kata-verify\` |
| \`review\` | \`/kata-judge\` |
| \`judge\` / \`distill\` | \`/kata-archive\` |
| \`archive\` | \`/kata\` (dispatch) |

If running inside a platform that supports slash commands and \`nextAction.requiresUserConfirmation\` is not true, invoke the suggested /kata-* skill directly. Otherwise use:

\`\`\`bash
kata <design|build|review|judge|verify|archive|hotfix|tweak> --change <change-id>
\`\`\`

You can also check Comet directly:

\`\`\`bash
kata comet verify  # check if Comet is installed and compatible
kata comet version # show compatibility and installed versions
\`\`\`

## Wiki maintenance

The project wiki (\`.llmwiki/\` + \`.kata/wiki/\`) accumulates knowledge across tasks. Over time, sources drift, links break, and candidates pile up.

Periodically run:

\`\`\`bash
kata wiki lint
\`\`\`

Fix reported issues: broken wikilinks, orphaned pages, missing frontmatter. Re-run until clean.

## Ongoing discipline

- If you discover a decision, constraint, or norm **during** task work, capture it immediately via \`kata wiki ingest --from <source-path>\`. Don't wait for archive.
- If the user says “记住这个”, “沉淀到 wiki”, “以后都按这个”, “record this rule”, “add to wiki”, or gives an equivalent durable-knowledge instruction, do **not** treat the chat transcript itself as authoritative. Create a concise source note under the task-owned path or docs/conventions, then ingest/register it as a governed Wiki candidate. Ask a short confirmation only when the instruction is ambiguous.
- Do not promote conversation-derived knowledge directly. It must remain a candidate until reviewed/promoted; stale ideas and temporary discussion should not pollute authoritative Wiki.
- Before starting a new task, run \`kata wiki orient\` to refresh context.`
        : (command.id === 'kata-open' || command.id === 'kata-hotfix' || command.id === 'kata-tweak')
            ? `## Skill-level workflow profile decision

\`${command.slashCommand}\` owns the user-facing decision flow. Do **not** rely on CLI TTY prompts for isolation, development, or review mode; many host platforms invoke the CLI non-interactively.

Before running \`kata ${command.phase}\`, resolve these three choices in the agent conversation:

1. Isolation mode:
   - \`current_worktree\` — use the current checkout; fastest, least isolated.
   - \`isolated_worktree\` — use/create an isolated worktree; preferred for larger implementation work.
   - \`git_flow\` — use a Git Flow feature branch.
   - \`user_decides\` — defer the isolation decision until implementation.
2. Development mode:
   - \`tdd\` — write focused failing tests first, then implement.
   - \`standard\` — implement directly with proportional tests.
3. Review mode:
   - \`std\` — standard independent review.
   - \`strict\` — stricter architecture/regression review.
   - \`security\` — security-focused review.

If the user explicitly provided these choices, use them. If not, present a concise recommendation and wait for confirmation before starting the task. A terse user confirmation such as “确认” may accept the recommended triple.

Then invoke the deterministic layer with explicit flags:

\`\`\`bash
${command.cli}
\`\`\`

Never let non-interactive CLI defaults silently choose the workflow profile.

## After profile confirmation

Do not ask the user to run \`/comet-open\` manually after \`/kata-open\`. When \`workflowProfile.comet.openStatus\` is \`required\`, \`/kata-design <task>\` performs the required acknowledgement before entering \`plan\`. Follow the returned next action after \`${command.slashCommand}\` completes.`
            : command.id === 'kata-design'
                ? `## Knowledge capture during design

Design decisions often establish lasting constraints and norms. Capture them as you go:

1. After accepting or rejecting an approach, run:
   \`\`\`bash
   kata wiki ingest --from docs/decisions/<decision-log>.md
   \`\`\`
   This creates a \`candidate\` wiki record linking the decision to source evidence.

2. If you identify new rules, conventions, or architectural constraints, write a brief summary page and ingest it:
   \`\`\`bash
   kata wiki ingest --from .llmwiki/concepts/<topic>.md
   \`\`\`

3. These candidates are available to future tasks once promoted. The earlier you capture, the less context later agents will miss.`
                : command.id === 'kata-build'
                    ? `## Knowledge capture during implementation

Implementation reveals concrete constraints that design alone cannot foresee:

1. If you discover an unexpected limitation, workaround, or invariant, document it:
   \`\`\`bash
   kata wiki ingest --from src/<relevant-file>.ts
   \`\`\`

2. If you establish new conventions (naming, structure, error handling), write a short convention note and ingest it:
   \`\`\`bash
   kata wiki ingest --from docs/conventions/<topic>.md
   \`\`\`

3. Don't wait for archive. Mid-task capture means the knowledge is available for the verification phase and for future tasks.`
                    : command.id === 'kata-verify'
                        ? `## Repair loop

If Judge returns FAIL for any acceptance criterion:

1. **Read** the \`repairScope\` in the judge result — it tells you which evidence categories failed and what to fix:
   - \`missing_test_evidence\` — write a test for the acceptance criterion
   - \`revision_superseded\` — a declared task-owned path changed after sealing; rebuild to create the next revision
   - \`stale_evidence\` — legacy repository-scoped evidence changed after collection; rebuild
   - \`failing_evidence\` — tests or checks failed
   - \`blocking_review_finding\` — a reviewer blocked this acceptance

2. **Fix only the scoped files** — Judge reports which acceptance criteria failed. Don't touch unrelated code. Unrelated changes will be rejected by \`enforceRepairScope\`.

3. **Rebuild** — first repair and test the scoped implementation, then collect fresh evidence:
   \`\`\`bash
   kata build --change <taskId> --seal
   \`\`\`

4. **Re-verify**:
   \`\`\`bash
   kata verify --change <taskId>
   \`\`\`

## Wiki closure is a governance action, not an implementation repair

When Verify reports implementationReady: true, governanceReady: false, and reason: resolve_wiki_closure, do **not** run build or modify implementation. Read the task acceptance, design artifacts, changed source, and existing Wiki candidates, then decide the closure yourself.

- Choose \`captured\` when the task establishes a reusable capability, architecture rule, workflow constraint, or domain convention. Create and register the grounded candidate first, then reference its id.
- Choose \`not_applicable\` when the task is a local mechanical change and establishes no reusable project knowledge.
- Only ask the user when the task artifacts are genuinely ambiguous or contradictory. Do not invoke bare \`kata wiki closure\` and make the user classify an otherwise clear task.

After making the decision, record it non-interactively and re-verify:

\`\`\`bash
kata wiki closure --task <taskId> --decision captured --reason "<durable rule>" --candidate <wiki-id>
kata wiki closure --task <taskId> --decision not_applicable --reason "<why no reusable knowledge changed>"
kata verify --change <taskId>
\`\`\`

The deferred decision intentionally blocks review and archive, but it does not mean acceptance criteria, tests, or evidence failed.

## Escalation

If repair fails repeatedly, use the host platform's own selector to choose a more capable model before continuing. Kata does not prescribe or record that choice.`
                        : command.id === 'kata-archive'
                            ? `## Knowledge distillation

The \`kata archive\` command transitions the task from \`distill\` to \`archive\` phase — a **deterministic** CLI operation. It does NOT generate wiki content. That is your job as the agent.

After archive completes, read the returned diagnostics, then:

1. **Read** the task artifacts:
   - \`.kata/tasks/<taskId>/task.json\` — acceptance criteria and title
   - \`.kata/tasks/<taskId>/judge.json\` — judge PASS/FAIL per acceptance
   - \`.kata/tasks/<taskId>/review.json\` — review findings
   - \`.kata/evidence/<taskId>-*.json\` — evidence envelopes
   - Project diff or implementation files

2. **Synthesize** a wiki entry capturing:
   - What decisions were made
   - What constraints or norms were established
   - Why certain approaches were chosen over alternatives
   - Any new rules, conventions, or patterns the project should adopt

3. **Write** the wiki record via CLI:
   \`\`\`bash
   kata wiki ingest --from .kata/tasks/<taskId>/task.json
   \`\`\`

4. **Promote** (optional):
   \`\`\`bash
   kata wiki promote wiki-<taskId> --by <your-id> --role distiller
   \`\`\`

5. **Deactivate active hook task**:
   \`\`\`bash
   kata hooks deactivate
   \`\`\`
   This prevents the archived task from continuing to scope future writes.`
                            : command.id === 'kata-wiki-enrich'
                                ? `## Coding-agent Wiki enrichment

This skill is where LLM work happens. Kata binary does **not** call model provider APIs for Wiki enrichment; it emits a deterministic task packet and the current coding agent performs reading, synthesis, and file edits.

1. Get the task packet:
   \`\`\`bash
   kata wiki task --kind enrich --from docs
   \`\`\`

   Do not guess Wiki CLI subcommands. Run \`kata wiki --help\` when discovery is needed. \`kata wiki propose\` is only a compatibility alias for the enrich task packet; it neither creates a governed record nor promotes knowledge. Use \`kata wiki candidate\` to inspect pending records.

2. Read every path in \`requiredReads\`, especially:
   - \`.llmwiki/SCHEMA.md\`
   - \`.llmwiki/index.md\`
   - \`.llmwiki/log.md\`
   - \`.llmwiki/raw/docs/**\`

3. **Ground every claim in source code.** \`raw/docs/\` are historical design docs — they may be outdated or differ from what was built. Before writing a page, read the actual source under \`packages/\` (\`ports/\`, \`domains/\`, \`infrastructure/\`, \`adapters/\`) to verify each architecture claim, method signature, file path, and table name. If source and design doc disagree, source wins.

4. As the coding agent, synthesize durable project knowledge:
   - concepts: architecture, workflow, invariants, conventions
   - entities: modules, services, commands, schemas
   - comparisons: alternatives and tradeoffs
   - queries: reusable answers worth filing
   - conversation-derived decisions only when the user explicitly asked to remember/capture them, or when they are stable task outcomes backed by files/evidence

5. Conversation capture covenant:
   - Trigger on clear user intents such as “记住这个”, “沉淀到 wiki”, “以后都按这个”, “record this rule”, “add to wiki”.
   - Convert the conversation point into a short source note with date, task id, source context, rule/decision, rationale, and scope.
   - Prefer task-owned notes under \`.kata/tasks/<task-id>/wiki-notes/\` or durable notes under \`docs/conventions/\`; then ingest/register them as candidates.
   - If the point is ambiguous, ask one short confirmation question before writing.
   - Never promote directly from chat; candidates need normal review/promotion.

6. Write only to task packet \`writeTargets\` such as \`.llmwiki/concepts/\`, \`.llmwiki/entities/\`, and \`.llmwiki/comparisons/\`. Do not edit \`.llmwiki/raw/\` manually.

7. Run deterministic checks:
   \`\`\`bash
   kata wiki lint
   kata wiki verify
   \`\`\`

8. Register synthesized pages as governed candidate records:
   \`\`\`bash
   kata wiki register
   \`\`\`

9. Complete the mandatory knowledge-closure decision before \`/kata-verify\` and \`/kata-archive\`. Decide it yourself from the task design, acceptance, source changes, and candidate records: reusable capability/rule/convention means \`captured\`; a local mechanical change with no durable knowledge means \`not_applicable\`. Create and register a grounded candidate before choosing \`captured\`. Only ask the user when those artifacts are genuinely ambiguous or contradictory. Never invoke bare \`kata wiki closure\` merely to make the user classify the task; always pass the selected decision and concrete reason:
   \`\`\`bash
   kata wiki closure --task <task-id> --decision captured --reason "<durable rule>" --candidate <wiki-id>
   kata wiki closure --task <task-id> --decision not_applicable --reason "<why no reusable knowledge changed>"
   \`\`\`

The Wiki helps future agents understand the project. It does not prove code correctness; CI, tests, Reviewer, and Judge own correctness.`
                                : command.id === 'kata-delegate'
                                    ? `## Interactive delegation

Do not require the user to pass command-line parameters. Treat natural language as the primary interface.

1. Discover candidate tasks:
   - Run \`kata status\`.
   - If the user mentioned a change by name or number, inspect that candidate.
   - If multiple same-branch tasks are plausible, present 2–5 options and ask the user to confirm or type a task id.

2. Infer the target role from phase:
   - \`plan\` or \`implement\` → \`implementer\`
   - \`hardVerify\` → \`reviewer\`
   - \`review\` → \`judge\`
   - \`judge\` or \`distill\` → \`distiller\`
   Ask for confirmation if the user intent conflicts with the phase.

3. Discover platforms with \`kata discover\`. Recommend one platform based on role and model policy, but ask the user to confirm when more than one suitable platform is available. Let the user type a custom platform name if needed.

4. Ensure the task is ready for delegation:
   - If missing, open it.
   - If in \`intake\`, design it.
   - Stop and ask before creating broad acceptance criteria that materially change scope.

5. Create and verify the packet:
   \`\`\`bash
   kata handoff create --task <task-id> --from <current-role> --to <target-role>
   kata handoff verify --task <task-id> --id <handoff-id>
   \`\`\`

6. Generate a target-agent prompt that says:
   - verify/show/acknowledge the handoff
   - read every \`requiredReads\` path
   - obey \`allowedWrites\` and guard instructions
   - run the matching \`/kata-*\` skill or CLI phase
   - stop before phases outside the delegated role

7. Return the prompt and next action to the user.`
                                    : command.id === 'kata-collect'
                                        ? `## Interactive collection

Do not ask the user for CLI parameters first. Discover the likely returned task, inspect upstream outputs, then ask for confirmation.

1. Run \`kata collect\` first. It returns same-branch candidates, upstream summaries, and a \`recommended\` task/action.
2. If the recommendation says \`repair_blocking_review_findings\`, \`repair_failed_judge\`, or \`repair_failing_evidence\`, ask the user to confirm repair and then act as implementer.
3. If the recommendation says \`review_fresh_implementation\`, ask the user to confirm review and then run reviewer flow.
4. If the recommendation says \`judge_reviewed_change\`, ask the user to confirm Judge and then run judge flow.
5. Read task state, review/judge/evidence files, and relevant handoff receipts before editing or judging.
6. If evidence is ready and user confirms higher-trust gates, run:
   \`\`\`bash
   kata review --change <task-id>
   kata judge --change <task-id>
   \`\`\`
7. If Judge passes and archive is appropriate, ask for confirmation, then run archive and perform wiki distillation.
8. If Judge fails, return the repair scope and a ready-to-send prompt for the delegated platform.`
                                        : '';
    const automationContent = ['kata-build', 'kata-review', 'kata-judge', 'kata-verify', 'kata-archive'].includes(command.id)
        ? `## Skill automation contract

The Skill MUST run these commands itself. Do not ask the user to copy or type them unless the platform cannot execute shell commands.

Skill-first means the slash command is the agent interface and the CLI is the internal execution layer. The user may provide no task id, a natural-language task hint, or only "continue"; the Skill must discover candidates and ask for a short confirmation only when needed.

1. Run \`kata status\` to read the active or current-branch discovered task, relation redirects, phase, next skill, task title, acceptance criteria, and context summary.
2. Do not require the user to pass parameters. Resolve the task id from active task, same-branch task, relation redirects, or the \`recommended\` task/action from \`kata status\` or \`kata collect\`. If multiple plausible tasks remain, show concise options and ask the user to choose or type a value.
3. Resolve role and task-kind from phase and user intent; if ambiguous, present recommended options and ask for confirmation. Do not default across trust boundaries without confirmation.
4. Run \`kata orient\` without \`--change\` when using the active/single discovered task, or with \`--change <id>\` after the user confirms a task id. Parse its relation redirects, handoff id, state, task, requiredReads, nextAction, and context fields.
5. Run kata handoff verify for that id; stop on an invalid result.
6. Read every requiredReads path from the packet.
7. Run kata handoff acknowledge with platform ${platform} and the current role.
8. ${command.id === 'kata-build'
            ? 'For build, first complete TDD and focused tests (先完成 TDD 与聚焦测试). Do not seal evidence before coding (不要在编码前封存证据). For current_worktree tasks, declare task-owned files with `--owned-path <path>` before sealing. `--seal` creates one immutable revision; `revision_superseded` means an owned file changed and requires Build for a new revision, while workspace drift outside ownership does not invalidate the sealed revision.'
            : 'Run this Skill\'s phase command and collect normal evidence. The next phase creates a fresh packet.'}
9. After the phase command returns, read \`completion.userMessage\` first, then \`nextAction.slashCommand\`, \`nextAction.cliCommand\`, \`recommended.reason\`, and \`askUser\` from the command result. Always tell the user the current phase and the next recommended operation. For every successful phase command—especially \`/kata-build <task> --seal\`—the final user-facing response MUST end with \`completion.userMessage\` verbatim. This is not optional: never finish with only a test summary, and never wait for the user to ask “what next”. If \`completion\` is absent, explicitly render the current phase and \`nextAction.slashCommand\`. Prefer the slash command, for example \`/kata-verify <change-id>\`; show the CLI command only as fallback.
10. Stop after this Skill's own phase command. If the returned \`nextAction.requiresUserConfirmation=true\`, do not invoke the next /kata-* skill. At model trust boundaries, wait for the user to use the host platform's own selector before continuing.

Do not create a receipt for read-only search, explanation, or orientation-only work.`
        : '';
    return `---
name: ${command.id}
description: ${command.summary}
---

# ${command.slashCommand}

platform: ${platform}

${responseLanguageContent ? `${responseLanguageContent}\n\n` : ''}
Use this skill to inspect the Kata ${command.phase} workflow entrypoint.

## Skill-first operating rule

Prefer the \`${command.slashCommand}\` Skill as the human-facing interface. Use \`${command.cli}\` as the deterministic fallback inside the Skill or in non-interactive scripts. If the user passes an explicit task id (e.g. "/kata-build my-task"), use it as the immutable anchor for all subsequent operations; do not re-discover via \`kata status\` or same-branch resolution. If the user gives a short instruction, natural-language hint, or no parameters, discover the active/same-branch task with \`kata status\`, follow relation redirects, and ask for a concise confirmation only when multiple choices remain.

## Startup checklist

Before doing task work, run the project orientation command:

\`\`\`bash
kata status
kata orient --role <designer|implementer|reviewer|judge|distiller> --platform ${platform} --task-kind <read|implementation|security>
kata hooks activate --change <change-id> --role <designer|implementer|reviewer|judge|distiller> --platform ${platform}
\`\`\`

Treat skill use as an interactive agent workflow, not a parameter-only command. First discover the active or same-branch task and any relation redirects; if the task, role, task kind, or target platform is ambiguous, present concise options and ask the user to confirm or type a value. Do not make the user remember command-line flags. After confirmation, run \`kata orient\` with the resolved values, then read the returned task, state, context, required files, guard instructions, relation redirects, and next skill before editing. The hook activation links platform write hooks to the active Kata task so phase/role scope is enforced while you work.

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
kata codegraph status
kata codegraph explore "<feature, symbol, module, or error>"
kata codegraph impact "<symbol-or-file>"
kata codegraph affected <changed-file>...
\`\`\`

Use CodeGraph to find likely source files, call paths, dependents, and affected tests. Then verify with direct file reads and focused \`rg\` searches before editing or reviewing. If CodeGraph is unavailable or stale, note the fallback and use \`rg\` plus requiredReads; do not block the workflow solely on CodeGraph.

## Portable context handoff

Before accepting work from another agent or platform, create or verify the canonical repository packet, read every path in its requiredReads field, then acknowledge the packet with the actual platform and role.

Run kata handoff verify --task <change-id> --id <handoff-id>, kata handoff show --task <change-id> --id <handoff-id>, then kata handoff acknowledge --task <change-id> --id <handoff-id> --platform ${platform} --role <role>.

The packet's allowed writes and guard instructions are authoritative. Model selection belongs to the host platform and never bypasses CI, tests, Reviewer, or Judge.

${automationContent}

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
        : '请在当前平台的模型选择器或平台配置中完成切换，然后继续本次 Kata 命令。'}

${phaseContent}`;
}
function formatBullets(items) {
    return items.map((item) => `- ${item}`).join('\n');
}
function renderResponseLanguageContract(language) {
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
//# sourceMappingURL=manifest.js.map