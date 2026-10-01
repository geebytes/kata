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
            return `## Repairs, and growing the audited surface

Both are recorded on the ledger, and both change what the next round costs — so they belong here, where the work happens.

**One revision, not one per finding.** A repair changes content, the sealed revision derives from content, and the review
verdict is bound to the revision it was recorded against — so **sealing after each repair buys a round per repair**. Repair
everything together and seal once. What a repair owes is a **claim whose evidence does not support it**, and the ledger is
where that is written down:

\`\`\`bash
kata-cli ledger status --cost --change <task-id>   # per claim: state, reasons, evidence, and the author-side re-openings
kata-cli ledger decide --change <task-id>          # the verdict the gates read: pass, fail or insufficient
\`\`\`

A claim is repaired by giving it evidence that holds, not by editing prose: \`ledger evidence add\` then
\`ledger evidence verify\`, which runs the check and, where the evidence declares a mutation, the reddening that proves
the check can fail. A change that needs to leave a problem unfixed says so as a decision
(\`ledger claim waive <id> --reason "<why>"\`) rather than by leaving the claim unsupported.

**Growing the audited surface is a decision.** Adding an owned path expands what the gate re-verifies **and** invalidates
evidence, restarting the search. Say so, with a reason; the platform records the base the next round narrows against:

\`\`\`bash
kata-cli scope change --change <task-id> --add <path> --reason "<why the surface has to grow>"
\`\`\`

If you wrote tooling during this task to check its own deliverables (a claim checker, a probe harness, a shadow runner),
**declare it as an instrument** — that is what stops an adversarial search against it from becoming an arms race, because it
is then judged against a **declared** boundary instead of being audited like a deliverable:

\`\`\`bash
kata-cli scope declare --change <task-id> --instrument <path>
kata-cli scope boundary --change <task-id> --instrument <path> --statement <doc> \
  --covers "<what it does check>" --excludes "<what it does not>: <why not>"
\`\`\`

The \`--statement\` document is the **single** canonical description of that boundary, it must exist, and a finding is only
closeable against it when the finding quotes a dimension declared in advance.

## Knowledge capture during implementation

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
            return `## What Verify validates, and what it does not write

Verify validates declared evidence: that it is current, complete and attributable to the acceptance criteria it was
declared against. It never authors the test that would produce evidence it is missing — a test written here would have no
RED step, no owner and no place in the acceptance matrix. Missing coverage is reported as a \`missing-test\` finding and
becomes a **Build repair obligation**, so the fix lands in the phase that owns tests.

## Findings about a declared instrument

A finding whose target is one of this task's **declared instruments** is judged differently from one about the deliverable:
an adversarial search on a guard always finds the dimension it does not cover, so a guard is answerable for what its
declaration **says** it covers and nothing more.

- **Within** the declared coverage: a real gap — repair it like any other claim.
- **Beyond** it: the answer is the declaration itself. Record the decision with the declaration as its reason
  (\`ledger claim waive <id> --reason "<why the declaration already excludes this>"\`) — the reason must **quote a dimension
  declared in advance**, and the waiver is reported at review, judge and archive, and must be carried to a named
  destination before the archive gate lets it through.
- **No declaration means no exclusions**: declare the boundary (\`kata-cli scope boundary …\`) rather than arguing it
  finding by finding.

## Frozen-tier checks

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

3. **Fix every open finding in one revision, then seal once.** A seal mints a revision, and a revision invalidates the review
   record that produced the findings — so **sealing after each finding buys a round per finding**. Measured: \`closure-gate\` had five
   review rounds and could not close one of them; with its repairs batched into one revision and a record the gate would admit, it
   needed two. The batch closes when its findings are answered, and each finding now names the class it belongs to
   (\`classInstances\`) and what its repair will touch (\`impact\`), so one revision can answer all of them.

4. **The repair is made by a session that did not write the code the finding is about.** That is the whole reason the repair layer
   exists: measured on this line, seven of the tests written during repairs could not fail, two repairs fixed one instance of a
   class with several, and every one of those was written by the author whose blind spot the review round exists to find. Dispatch
   the repair to a fresh session — \`.pi/agents/kata-implementer.md\` is one, with write access confined to a scratch copy — and
   **say so where the record is**: the ledger's producer fields name who submitted each claim and each piece of evidence
   (\`ledger status --cost\` reports them per run), so a repair that arrived with evidence from another session is visible
   rather than asserted.

5. **Rebuild** — first repair and test the scoped implementation, then collect fresh evidence:
   \`\`\`bash
   kata-cli build --change <taskId> --seal
   \`\`\`

6. **Re-verify**
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

        case 'kata-judge':
            return `## Deciding from evidence scoped to each criterion

The Judge does not re-derive the match between a criterion and the evidence. It reads the same AC-scoped answer Verify
reads, so the ladder, the vocabulary and the priorities are shared rather than restated — and a criterion passes on
evidence for *that* criterion, never on an unrelated passing test.

## Naming the repair owner

A criterion that fails for a reason only a test can close — \`missing_test_evidence\`, \`insufficient_evidence_level\` or
\`no_acceptance_matrix_row\` — carries \`repairOwner: "build"\` in \`judge.json\`. The owner is the phase that owns tests:
a counterexample written here has no RED step, no owner and no place in the acceptance matrix. Report the missing
coverage; do not author the test that would close it.

Let the reported \`repairOwner\` decide where the repair is sent rather than inferring it from the scope name, and let the
ledger's own deficits decide what the repair is: \`ledger decide\` names each claim it cannot support and why.`;

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

/**
 * **What the independent review node is told, on the route that actually decides.**
 *
 * This used to describe the round-shaped protocol step by step — render a brief with `adversarial brief`, run it in a
 * clean context, report what came back with `adversarial note`/`finding add`/`record`, and decide each finding with
 * `findings defer`. Every one of those commands was deleted with the mechanism, so the text was an operating manual for a
 * route that exits 1 — and because generated skills are what a fresh session reads, it was the most consequential stale
 * text in the repository. The check that catches this class now reads the dispatcher's own vocabulary
 * (`tests/unit/generated-skills-name-live-commands.test.ts`), which is why the rewrite cannot drift back unnoticed.
 *
 * The route it describes now: a **subject** frozen by content digest, **claims** with severities, **evidence** that a
 * verifier decides by running it, and a **decision** the gates read. Independence is still the point, and the honest
 * boundary is stated: the ledger records what was verified, not who wrote the claims.
 */
export function ledgerReviewGuidanceFor(command: { id: string; cli: string }): string {
    if (command.id !== 'kata-verify' && command.id !== 'kata-review') return '';
    return `## Independent review, on the evidence ledger

Both nodes below must answer to a **different context than the one that wrote the change**. The same context that
implemented a change shares its assumptions, its blind spots and its reading of its own evidence, so its own confirmation
is the weakest possible evidence that the change is sound.

What makes the pass independent is not a field in a record: it is that **every claim rests on evidence a verifier
re-executed**, and that the decision is derived from that evidence by a pure function rather than reported by the party
being judged. The ledger does not verify *who* wrote a claim, and it does not pretend to — \`limits\` in the approval
record says exactly that.

Do this:

1. Read what the ledger already decides, and what it cannot:
   \`\`\`bash
   kata-cli ledger status --cost --change <task-id>   # per claim: state, reasons, evidence, challenges, cost
   kata-cli ledger decide --change <task-id>          # pass | fail | insufficient, with the reasons
   \`\`\`
2. Issue the review request. It carries the claim's reading set, the evidence type and strength that claim requires, a
   numeric deadline, and the probes a reader must answer — and it deliberately carries no platform, session, model or
   receipt, because assurance is a separate axis:
   \`\`\`bash
   kata-cli ledger run --change <task-id> --out request.json
   \`\`\`
3. **Dispatch exactly one subagent with the ReviewRequest as its only payload.** The subagent receives the request file, reads no author-written brief, stays read-only on the code under review, and returns a structured result to this Skill. The Skill writes that result through the only result path:
   \`\`\`bash
   kata-cli review --change <task-id> --result-file result.json
   \`\`\`
   Do not launch a separate process or use a process fallback — but **do check that the subagent can start at all**, because
   a fresh context is a fresh process and it does not inherit everything this one has:

   - **A model provider that this session registered at startup is not visible to the new context.** Where the default
     model comes from such a registration, a dispatch fails with a message like \`Model "<provider>/<model>" not found\` —
     which reads like a typo and is not one. Give the new context the registration explicitly, or pick a model it can
     resolve on its own. How a platform expresses that is that platform's business; what matters here is that the round
     comes back, because **a round that never started is not a round**, and a finding that never arrived is not a pass.
     If neither is possible, say so and stop rather than reporting the round as done.
   - **The same is true of anything else this session registered at startup** — skills, hooks, providers. A new context's
     capabilities are the ones you hand it, not the ones you happen to have.

   Kata records none of this: the request carries no platform, session or model, and how the round was launched is
   organizational process rather than a checked criterion. The check above is about the round existing, not about what
   kata believes about it.
4. **A probe is not a quiz.** \`ledger answer\` records the command that was run and what it printed, and a probe is answered once — so a wrong answer cannot be retried until something passes. Answering from having read the revision is
   the only way to get them right:
   \`\`\`bash
   kata-cli ledger ask --change <task-id>              # the probes this ledger asks, derived from its own claims
   kata-cli ledger answer --change <task-id> --probe <id> --command "<what you ran>" --observed "<what it printed>"
   \`\`\`
5. **Record what you found as evidence, not as a claim about yourself.** A counterexample is a challenge the author has to
   answer, and it is recorded as one; it is withdrawn only when the ledger can see that it does not reproduce:
   \`\`\`bash
   kata-cli ledger challenge add --change <task-id> --claim <id> --command "<what reproduces it>" --fails-on <revision>
   kata-cli ledger challenge check --change <task-id>
   \`\`\`
6. **Never write the code under review.** A review that repairs what it reviews has replaced the judgement rather than
   informed it, and its evidence would be its own work. Report it; the author repairs it. When a check can only be
   falsified by a test that does not exist, report that as a gap rather than authoring the test here.

What the gate refuses, so the request can be satisfied rather than guessed at: an unreadable ledger is refused (written
and unparseable is not the same fact as never written); a verdict outlives its content, so a declared path that moved
after the decision refuses the approval and names it; and the assurance floor is \`observed\` under \`strict\` **and** under
\`security\` — the platform owns execution isolation, so no tier asks Kata for a sandbox — while \`security\` still asks
for two independent reviewers, always-quorum and the privilege/provenance risk classes, so evidence nothing re-executed
cannot carry either tier.`;
}

/** The Skill automation contract, carried by the phases that drive a command to a verdict. */
export function automationGuidanceFor(command: { id: string }, platform: string): string {
    if (!['kata-build', 'kata-review', 'kata-judge', 'kata-verify', 'kata-archive'].includes(command.id)) return '';
    return `## Skill automation contract

The Skill MUST run these commands itself. Do not ask the user to copy or type them unless the platform cannot execute shell commands.

Skill-first means the slash command is the agent interface and the CLI is the internal execution layer. The user may provide no task id, a natural-language task hint, or only "continue"; the Skill must discover candidates and ask for a short confirmation only when needed.

1. Run \`kata-cli status\` to read the active or current-branch discovered task, its relation redirects, the phase and
   the next skill. Status is light: it reports the dispatch decision, not task context — step 4's \`orient\` is the
   packet that carries \`task\`, \`state\`, \`requiredReads\` and \`context\`. **When the user supplied an explicit task id,
   skip this step and go straight to step 4.** Do not add \`--with-context\` here; the packet already carries it.
2. Do not require the user to pass parameters. Resolve the task id from active task, same-branch task, relation redirects, or the \`recommended\` task/action from \`kata-cli status\` or \`kata-cli collect\`. If multiple plausible tasks remain, show concise options and ask the user to choose or type a value.
3. Resolve role and task-kind from phase and user intent; if ambiguous, present recommended options and ask for confirmation. Do not default across trust boundaries without confirmation.
4. Run \`kata-cli orient\` without \`--change\` when using the active/single discovered task, or with \`--change <id>\` after the user confirms a task id. Parse its relation redirects, handoff id, state, task, requiredReads, nextAction, and context fields.
5. Run kata-cli handoff verify for that id; stop on an invalid result.
6. Read every requiredReads path from the packet.
7. Run kata-cli handoff acknowledge with platform ${platform} and the current role.
8. ${command.id === 'kata-build'
            ? 'For build, first complete TDD and focused tests (先完成 TDD 与聚焦测试). Do not seal evidence before coding (不要在编码前封存证据). For current_worktree tasks, declare task-owned files with \`--owned-path <path>\` before sealing. \`--seal\` creates one immutable revision; \`revision_superseded\` means the sealed revision no longer describes the task — an owned file changed, or the task\'s declared surface moved — and requires Build for a new revision, while workspace drift outside ownership does not invalidate the sealed revision.'
            : 'Run this Skill\'s phase command and collect normal evidence. The next phase creates a fresh packet.'}
9. After the phase command returns, read \`completion.userMessage\` first, then \`nextAction.slashCommand\`, \`nextAction.cliCommand\`, \`recommended.reason\`, and \`askUser\` from the command result. Always tell the user the current phase and the next recommended operation. For every successful phase command—especially \`/kata-build <task> --seal\`—the final user-facing response MUST end with \`completion.userMessage\` verbatim. This is not optional: never finish with only a test summary, and never wait for the user to ask “what next”. If \`completion\` is absent, explicitly render the current phase and \`nextAction.slashCommand\`. Prefer the slash command, for example \`/kata-verify <change-id>\`; show the CLI command only as fallback.
10. Stop after this Skill's own phase command. A Skill invocation has exactly one phase-command authority: Build may invoke only \`kata build\`; it MUST NOT invoke verify, review, judge, archive, or any other \`/kata-*\` command after Build returns. The same rule applies to every phase Skill: render its next action for the user, then end the invocation. If the returned \`nextAction.requiresUserConfirmation=true\`, do not invoke the next /kata-* skill. At model trust boundaries, wait for the user to use the host platform's own selector before continuing.

Do not record ledger evidence for read-only search, explanation, or orientation-only work: a claim nobody made does not
need evidence, and a verdict is only required for the claims a change declares.`;
}
