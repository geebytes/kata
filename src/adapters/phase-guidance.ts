/**
 * The phase-specific prose each command carries, as catalogue data (L6-02).
 *
 * `renderSkill` held this as a 356-line ternary keyed on `command.id`, so the module carried both the machine-readable
 * catalogue and the human-facing documentation for every command, joined by string comparisons — adding a command meant
 * adding data *and* a branch. The prose is data now; rendering is layout plus capability substitution, and the shared
 * policy sentences come from `policy/guard-instructions.ts` (L2-06).
 */
import { HOST_MODEL_POLICY_SENTENCE } from '../policy/guard-instructions.js';
import { renderRepairScopeGuide } from '../quality/repair-scope-guide.js';

/** The phase guidance for one command, or an empty string when a command carries none. */
export function phaseGuidanceFor(command: {
    id: string;
    slashCommand: string;
    cli: string;
    phase: string;
}): string {
    switch (command.id) {
        case 'kata':
            return `## Smart dispatch

Read the current task state and upstream artifacts to determine the next action:

\`\`\`bash
kata-cli status  # show current phase and next skill
\`\`\`

For a specific change:

\`\`\`bash
kata-cli status --change <change-id>
\`\`\`

With one active or same-branch task, the output includes a \`nextSkill\` field that tells you which /kata-* command can happen next. With multiple same-branch tasks, \`kata-cli status\` returns \`candidates\` and a \`recommended\` action. Prefer the recommendation and ask the user for a short confirmation instead of asking them to remember command-line flags or change ids.

When \`phase === "dispatch" && candidates.length === 0 && recommended === null\`, do not display raw CLI diagnostics and do not ask for a task id, change id, or CLI flags. Tell the user: “当前分支没有活跃的 Kata 任务。你想开启什么工作？请用一句话描述目标，例如‘修复登录超时’或‘新增导出功能’。” Wait for their answer. 收到自然语言目标后，进入 /kata-open；由该 Skill 解释并确认隔离、开发和审查方式，然后使用显式参数调用 \`kata-cli open\`。

Skill-first rule: treat slash-command Skills as the user interface and CLI commands as the deterministic execution layer inside the Skill. A user should be able to say \`/kata-build 修复代码规范\` or \`继续\`; the Skill must discover the task, relation redirects, current phase, and next action before asking for missing choices. Do not ask the user to run \`kata-cli build --change ...\` unless the host platform cannot execute shell commands.

Workflow control is task-scoped: Change is the target/scope container, Task is the smallest governed control unit, Artifact is evidence, and Step is agent-local execution detail. Do not drive build/review/judge from a Change directly; resolve the canonical Task first.

If a placeholder task or earlier change is covered by a more specific governed task, do not ask future agents to guess. Record the relation:

\`\`\`bash
kata-cli tasks relate --from <source-task> --to <target-task> --type <covered_by|superseded_by|duplicate_of|merged_into> --reason "<why>"
\`\`\`

\`kata-cli status --change <source-task>\` and \`kata-cli orient --change <source-task>\` follow terminal relations and return \`relationRedirects\`.

For change-to-task, task-to-change, and change-to-change context, use the generic graph:

\`\`\`bash
kata-cli relations add --from change:<change-id> --to task:<task-id> --type contains --reason "<why>"
kata-cli relations add --from task:<task-id> --to change:<change-id> --type implements --reason "<why>"
kata-cli relations show --id change:<change-id>
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
kata-cli <design|build|review|judge|verify|archive|hotfix|tweak> --change <change-id>
\`\`\`

You can also check Comet directly:

\`\`\`bash
kata-cli comet verify  # check if Comet is installed and compatible
kata-cli comet version # show compatibility and installed versions
\`\`\`

## Wiki maintenance

The project wiki (\`.llmwiki/\` + \`.kata/wiki/\`) accumulates knowledge across tasks. Over time, sources drift, links break, and candidates pile up.

Periodically run:

\`\`\`bash
kata-cli wiki lint
\`\`\`

Fix reported issues: broken wikilinks, orphaned pages, missing frontmatter. Re-run until clean.

## Ongoing discipline

- If you discover a decision, constraint, or norm **during** task work, capture it immediately via \`kata-cli wiki ingest --from <source-path>\`. Don't wait for archive.
- If the user says “记住这个”, “沉淀到 wiki”, “以后都按这个”, “record this rule”, “add to wiki”, or gives an equivalent durable-knowledge instruction, do **not** treat the chat transcript itself as authoritative. Create a concise source note under the task-owned path or docs/conventions, then ingest/register it as a governed Wiki candidate. Ask a short confirmation only when the instruction is ambiguous.
- Do not promote conversation-derived knowledge directly. It must remain a candidate until reviewed/promoted; stale ideas and temporary discussion should not pollute authoritative Wiki.
- Before starting a new task, run \`kata-cli wiki orient\` to refresh context.`;

        case 'kata-design':
            return `## Knowledge capture during design

Design decisions often establish lasting constraints and norms. Capture them as you go:

1. After accepting or rejecting an approach, run:
   \`\`\`bash
   kata-cli wiki ingest --from docs/decisions/<decision-log>.md
   \`\`\`
   This creates a \`candidate\` wiki record linking the decision to source evidence.

2. If you identify new rules, conventions, or architectural constraints, write a brief summary page and ingest it:
   \`\`\`bash
   kata-cli wiki ingest --from .llmwiki/concepts/<topic>.md
   \`\`\`

3. These candidates are available to future tasks once promoted. The earlier you capture, the less context later agents will miss.`;

        case 'kata-build':
            return `## Knowledge capture during implementation

Implementation reveals concrete constraints that design alone cannot foresee:

1. If you discover an unexpected limitation, workaround, or invariant, document it:
   \`\`\`bash
   kata-cli wiki ingest --from src/<relevant-file>.ts
   \`\`\`

2. If you establish new conventions (naming, structure, error handling), write a short convention note and ingest it:
   \`\`\`bash
   kata-cli wiki ingest --from docs/conventions/<topic>.md
   \`\`\`

3. Don't wait for archive. Mid-task capture means the knowledge is available for the verification phase and for future tasks.`;

        case 'kata-verify':
            return `## Frozen-tier checks

A project may declare verification it wants when the artefact is frozen rather than on every seal — a check with
\`tier: "frozen"\` in \`.kata-config.json\`'s \`quality.buildChecks\`. Check before concluding this node:

\`\`\`bash
kata-cli build --change <taskId> --list-checks
\`\`\`

If any check is listed with \`"tier": "frozen"\`, seal the frozen tier before verifying — Verify refuses to conclude
while a frozen check has no passing evidence for the current revision, and says so:

\`\`\`bash
kata-cli build --change <taskId> --seal --frozen
\`\`\`

## Repair loop

If Judge returns FAIL for any acceptance criterion:

1. **Read** the \`repairScope\` in the judge result — it tells you which evidence categories failed and what to fix:
${renderRepairScopeGuide()}

2. **Fix only the scoped files** — Judge reports which acceptance criteria failed. Don't touch unrelated code. Unrelated changes will be rejected by \`enforceRepairScope\`.

3. **Rebuild** — first repair and test the scoped implementation, then collect fresh evidence:
   \`\`\`bash
   kata-cli build --change <taskId> --seal
   \`\`\`

4. **Re-verify**:
   \`\`\`bash
   kata-cli verify --change <taskId>
   \`\`\`

## Wiki closure is a governance action, not an implementation repair

When Verify reports implementationReady: true, governanceReady: false, and reason: resolve_wiki_closure, do **not** run build or modify implementation. Read the task acceptance, design artifacts, changed source, and existing Wiki candidates, then decide the closure yourself.

- Choose \`captured\` when the task establishes a reusable capability, architecture rule, workflow constraint, or domain convention. Create and register the grounded candidate first, then reference its id.
- Choose \`not_applicable\` when the task is a local mechanical change and establishes no reusable project knowledge.
- Only ask the user when the task artifacts are genuinely ambiguous or contradictory. Do not invoke bare \`kata-cli wiki closure\` and make the user classify an otherwise clear task.

After making the decision, record it non-interactively and re-verify:

\`\`\`bash
kata-cli wiki closure --task <taskId> --decision captured --reason "<durable rule>" --candidate <wiki-id>
kata-cli wiki closure --task <taskId> --decision not_applicable --reason "<why no reusable knowledge changed>"
kata-cli verify --change <taskId>
\`\`\`

The deferred decision intentionally blocks review and archive, but it does not mean acceptance criteria, tests, or evidence failed.

## Escalation

If repair fails repeatedly, use the host platform's own selector to choose a more capable model before continuing. Kata does not prescribe or record that choice.`;

        case 'kata-archive':
            return `## Knowledge distillation

The \`kata-cli archive\` command transitions the task from \`distill\` to \`archive\` phase — a **deterministic** CLI operation. It does NOT generate wiki content. That is your job as the agent.

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
   kata-cli wiki ingest --from .kata/tasks/<taskId>/task.json
   \`\`\`

4. **Promote** (optional):
   \`\`\`bash
   kata-cli wiki promote wiki-<taskId> --by <your-id> --role distiller
   \`\`\`

5. **Deactivate active hook task**:
   \`\`\`bash
   kata-cli hooks deactivate
   \`\`\`
   This prevents the archived task from continuing to scope future writes.`;

        case 'kata-wiki-enrich':
            return `## Coding-agent Wiki enrichment

This skill is where LLM work happens. Kata binary does **not** call model provider APIs for Wiki enrichment; it emits a deterministic task packet and the current coding agent performs reading, synthesis, and file edits.

1. Get the task packet:
   \`\`\`bash
   kata-cli wiki task --kind enrich --from docs
   \`\`\`

   Do not guess Wiki CLI subcommands. Run \`kata-cli wiki --help\` when discovery is needed. \`kata-cli wiki propose\` is only a compatibility alias for the enrich task packet; it neither creates a governed record nor promotes knowledge. Use \`kata-cli wiki candidate\` to inspect pending records.

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
   kata-cli wiki lint
   kata-cli wiki verify
   \`\`\`

8. Register synthesized pages as governed candidate records:
   \`\`\`bash
   kata-cli wiki register
   \`\`\`

9. Complete the mandatory knowledge-closure decision before \`/kata-verify\` and \`/kata-archive\`. Decide it yourself from the task design, acceptance, source changes, and candidate records: reusable capability/rule/convention means \`captured\`; a local mechanical change with no durable knowledge means \`not_applicable\`. Create and register a grounded candidate before choosing \`captured\`. Only ask the user when those artifacts are genuinely ambiguous or contradictory. Never invoke bare \`kata-cli wiki closure\` merely to make the user classify the task; always pass the selected decision and concrete reason:
   \`\`\`bash
   kata-cli wiki closure --task <task-id> --decision captured --reason "<durable rule>" --candidate <wiki-id>
   kata-cli wiki closure --task <task-id> --decision not_applicable --reason "<why no reusable knowledge changed>"
   \`\`\`

The Wiki helps future agents understand the project. It does not prove code correctness; CI, tests, Reviewer, and Judge own correctness.`;

        case 'kata-delegate':
            return `## Interactive delegation

Do not require the user to pass command-line parameters. Treat natural language as the primary interface.

1. Discover candidate tasks:
   - Run \`kata-cli status\`.
   - If the user mentioned a change by name or number, inspect that candidate.
   - If multiple same-branch tasks are plausible, present 2–5 options and ask the user to confirm or type a task id.

2. Infer the target role from phase:
   - \`plan\` or \`implement\` → \`implementer\`
   - \`hardVerify\` → \`reviewer\`
   - \`review\` → \`judge\`
   - \`judge\` or \`distill\` → \`distiller\`
   Ask for confirmation if the user intent conflicts with the phase.

3. Discover platforms with \`kata-cli discover\`. Recommend one platform based on role and model policy, but ask the user to confirm when more than one suitable platform is available. Let the user type a custom platform name if needed.

4. Ensure the task is ready for delegation:
   - If missing, open it.
   - If in \`intake\`, design it.
   - Stop and ask before creating broad acceptance criteria that materially change scope.

5. Create and verify the packet:
   \`\`\`bash
   kata-cli handoff create --task <task-id> --from <current-role> --to <target-role>
   kata-cli handoff verify --task <task-id> --id <handoff-id>
   \`\`\`

6. Generate a target-agent prompt that says:
   - verify/show/acknowledge the handoff
   - read every \`requiredReads\` path
   - obey \`allowedWrites\` and guard instructions
   - run the matching \`/kata-*\` skill or CLI phase
   - stop before phases outside the delegated role

7. Return the prompt and next action to the user.`;

        case 'kata-collect':
            return `## Interactive collection

Do not ask the user for CLI parameters first. Discover the likely returned task, inspect upstream outputs, then ask for confirmation.

1. Run \`kata-cli collect\` first. It returns same-branch candidates, upstream summaries, and a \`recommended\` task/action.
2. If the recommendation says \`repair_blocking_review_findings\`, \`repair_failed_judge\`, or \`repair_failing_evidence\`, ask the user to confirm repair and then act as implementer.
3. If the recommendation says \`review_fresh_implementation\`, ask the user to confirm review and then run reviewer flow.
4. If the recommendation says \`judge_reviewed_change\`, ask the user to confirm Judge and then run judge flow.
5. Read task state, review/judge/evidence files, and relevant handoff receipts before editing or judging.
6. If evidence is ready and user confirms higher-trust gates, run:
   \`\`\`bash
   kata-cli review --change <task-id>
   kata-cli judge --change <task-id>
   \`\`\`
7. If Judge passes and archive is appropriate, ask for confirmation, then run archive and perform wiki distillation.
8. If Judge fails, return the repair scope and a ready-to-send prompt for the delegated platform.`;

        case 'kata-open':
        case 'kata-hotfix':
        case 'kata-tweak':
            return sharedProfileDecision(command);
        default:
            return '';
    }
}

/**
 * The three-choice flow open/hotfix/tweak share, written once.
 *
 * Its text is what the ternary held for all three, with two substitutions kept (`slashCommand` and `cli`) and the
 * host-model sentence taken from the policy catalogue rather than restated a fourth time.
 */
function sharedProfileDecision(command: { slashCommand: string; cli: string; phase: string }): string {
    return `## Skill-level workflow profile decision

\`${command.slashCommand}\` owns the user-facing decision flow. Do **not** rely on CLI TTY prompts for isolation, development, or review mode; many host platforms invoke the CLI non-interactively.

Before running \`kata-cli ${command.phase}\`, resolve these three choices in the agent conversation:

1. Isolation mode:
   - \`current_worktree\` — use the current checkout; fastest, least isolated.
   - \`isolated_worktree\` — use kata's isolated worktree: \`kata-cli worktree create --change <task>\` (linked worktrees live under \`.kata/worktrees/\`, ignored by git and by repository identity); preferred for larger implementation work.
   - \`git_flow\` — use a Git Flow branch: ordinary tasks use a feature branch; hotfix tasks use a hotfix branch.
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

Do not ask the user to run \`/comet-open\` manually after \`/kata-open\`. When \`workflowProfile.comet.openStatus\` is \`required\`, \`/kata-design <task>\` performs the required acknowledgement before entering \`plan\`. Follow the returned next action after \`${command.slashCommand}\` completes.`;
}

/** The independent adversarial step, carried by exactly the two nodes that conclude a change. */
export function adversarialGuidanceFor(command: { id: string; cli: string }): string {
    if (command.id !== 'kata-verify' && command.id !== 'kata-review') return '';
    const node = command.id === 'kata-verify' ? 'verify' : 'review';
    return `## Independent adversarial review (clean context)

Both nodes below must answer to a **different context than the one that wrote the change**. The same context that
implemented a change shares its assumptions, its blind spots and its reading of its own evidence, so its own
confirmation is the weakest possible evidence that the change is sound.

Before this Skill's node can conclude — before \`kata-cli verify\` reports success, and before
\`kata-cli review --approve\` records an approval — kata requires a recorded adversarial pass over the sealed revision,
or an explicit recorded waiver. The gate is not advisory: the command fails while the pass is missing.

Do this:

1. Render the brief. It is self-contained and states the revision, the claims under test, the recorded evidence and
   the exact result shape:
   \`\`\`bash
   kata-cli adversarial brief --change <task-id> --node ${node}
   \`\`\`
2. **Run that brief in a clean context.** Use the host platform's own subagent facility — a fresh session, no prior
   conversation, no summary of this one — and hand it the brief text verbatim. Do not run the pass in this context, and
   do not paraphrase the brief: a fresh context has nothing but what the brief says. The brief asks it to try to *falsify*
   every claim, to run the attempts, and to return one JSON object.
3. Record what came back, unchanged — **and report how long the pass took**:
   \`\`\`bash
   kata-cli adversarial record --change <task-id> --node ${node} --from-file <result.json> --elapsed-ms <milliseconds the pass took>
   \`\`\`
   Report the wall-clock time of the whole pass honestly, including the subagent's runtime. This is the only place the
   number exists: the design's own §11 could not answer "what does a narrower re-verification actually save?" because
   nothing recorded a pass's duration, and the baseline is destroyed the moment the next pass overwrites the record.
   \`kata-cli adversarial status --change <task-id>\` then reports \`deltaSaving\` (the previous full pass, this one, the
   difference) — or says plainly that it is not measurable yet, which is the honest answer for the first passes.
4. **If the brief was a delta brief** (\`--since\` was used, and its result reported a change surface rather than
   \`delta_unavailable\`), pass the same \`--since\` to \`record\`. Kata measures the change surface itself and stamps the
   pass's \`scope\`; the gate then verifies that the declared paths cover **every** difference between the two revisions
   and refuses the pass as \`delta_stale\` otherwise. Never hand-write \`scope\`: a scope kata did not measure is a scope
   the gate will refuse, and it is right to.
5. Read the gate's answer in the command output. Blocking or major findings from the pass stop the node until they are
   repaired; a pass recorded against an older revision or against a different brief does not satisfy the gate
   (\`kata-cli adversarial status --change <task-id>\` shows both nodes).
6. If the pass confirmed findings, decide what each one is worth: \`kata-cli findings defer --change <task-id> --id <id>
   --reason "<why not now>"\` records a decision to live with a minor finding (and it stays visible at verify and
   archive); \`blocking\` and \`major\` must be repaired — the command refuses them. And tell the truth about where your
   findings came from: a pass whose findings were caused by the previous repair says so in
   \`findingOrigins.causedByPreviousRepair\`, so "fix one, grow two" is a number in the record rather than an impression.
7. Then run this Skill's own command again (\`${command.cli.replace(' <change-id>', ' --change <task-id>')}\`).

If the pass genuinely cannot run (no subagent facility on this platform, or the revision is trivial), record that
decision explicitly instead of skipping it silently — the gate reports a waiver as a waiver:

\`\`\`bash
kata-cli adversarial waive --change <task-id> --node ${node} --reason "<why this node proceeds without an independent pass>"
\`\`\`

Kata cannot start a subagent or inspect the host's session: it renders the brief, checks the result against the revision
and that brief, and holds the gate. Who ran it, in which context, is reported by the executing agent in
\`executedInFreshContext\`/\`contextNote\` — the same way host model confirmation is reported.

`;
}

/** The Skill automation contract, carried by the phases that drive a command to a verdict. */
export function automationGuidanceFor(command: { id: string }, platform: string): string {
    if (!['kata-build', 'kata-review', 'kata-judge', 'kata-verify', 'kata-archive'].includes(command.id)) return '';
    return `## Skill automation contract

The Skill MUST run these commands itself. Do not ask the user to copy or type them unless the platform cannot execute shell commands.

Skill-first means the slash command is the agent interface and the CLI is the internal execution layer. The user may provide no task id, a natural-language task hint, or only "continue"; the Skill must discover candidates and ask for a short confirmation only when needed.

1. Run \`kata-cli status\` to read the active or current-branch discovered task, relation redirects, phase, next skill, task title, acceptance criteria, and context summary.
2. Do not require the user to pass parameters. Resolve the task id from active task, same-branch task, relation redirects, or the \`recommended\` task/action from \`kata-cli status\` or \`kata-cli collect\`. If multiple plausible tasks remain, show concise options and ask the user to choose or type a value.
3. Resolve role and task-kind from phase and user intent; if ambiguous, present recommended options and ask for confirmation. Do not default across trust boundaries without confirmation.
4. Run \`kata-cli orient\` without \`--change\` when using the active/single discovered task, or with \`--change <id>\` after the user confirms a task id. Parse its relation redirects, handoff id, state, task, requiredReads, nextAction, and context fields.
5. Run kata-cli handoff verify for that id; stop on an invalid result.
6. Read every requiredReads path from the packet.
7. Run kata-cli handoff acknowledge with platform ${platform} and the current role.
8. ${command.id === 'kata-build'
            ? 'For build, first complete TDD and focused tests (先完成 TDD 与聚焦测试). Do not seal evidence before coding (不要在编码前封存证据). For current_worktree tasks, declare task-owned files with \`--owned-path <path>\` before sealing. \`--seal\` creates one immutable revision; \`revision_superseded\` means an owned file changed and requires Build for a new revision, while workspace drift outside ownership does not invalidate the sealed revision.'
            : 'Run this Skill\'s phase command and collect normal evidence. The next phase creates a fresh packet.'}
9. After the phase command returns, read \`completion.userMessage\` first, then \`nextAction.slashCommand\`, \`nextAction.cliCommand\`, \`recommended.reason\`, and \`askUser\` from the command result. Always tell the user the current phase and the next recommended operation. For every successful phase command—especially \`/kata-build <task> --seal\`—the final user-facing response MUST end with \`completion.userMessage\` verbatim. This is not optional: never finish with only a test summary, and never wait for the user to ask “what next”. If \`completion\` is absent, explicitly render the current phase and \`nextAction.slashCommand\`. Prefer the slash command, for example \`/kata-verify <change-id>\`; show the CLI command only as fallback.
10. Stop after this Skill's own phase command. A Skill invocation has exactly one phase-command authority: Build may invoke only \`kata build\`; it MUST NOT invoke verify, review, judge, archive, or any other \`/kata-*\` command after Build returns. The same rule applies to every phase Skill: render its next action for the user, then end the invocation. If the returned \`nextAction.requiresUserConfirmation=true\`, do not invoke the next /kata-* skill. At model trust boundaries, wait for the user to use the host platform's own selector before continuing.

Do not create a receipt for read-only search, explanation, or orientation-only work.`;
}
