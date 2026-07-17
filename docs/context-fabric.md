# Context Fabric

Kata lets any supported coding agent hand work to another agent in the same Git worktree and branch. The shared context is repository state, not a platform chat transcript.

## Canonical context

- `.llmwiki/` holds governed project knowledge.
- `.kata/tasks/<task-id>/` holds task state, acceptance criteria, packets, receipts and role artifacts.
- `.kata/evidence/` holds commands and results bound to a diff hash.
- Git HEAD, branch and working-tree diff bind a handoff to the code the next agent must inspect.

Wiki improves project understanding only. CI, tests, Reviewer and Judge remain responsible for code correctness.

## Active task resolution

Kata skills should avoid asking "which Change is this?" when the repository already has an unambiguous same-branch active task.

Resolution order:

1. Use the explicit task id passed to the skill, such as `/kata-build context-fabric`.
2. Otherwise run `kata status` and use the active task only when its recorded Git branch matches the current branch. The response includes the task title, acceptance criteria, current state, required reads, and context summary.
3. If no active task exists, `kata status` may use the single non-archived Kata task whose `task.json` was created on the current Git branch.
4. If no same-branch task exists, multiple same-branch tasks exist, or an active task points at another branch, ask the user for the task id before editing.

Activation records the task, phase, role, platform and branch:

```sh
kata hooks activate --change <task-id> --role implementer --platform opencode
```

After that, same-branch phase commands may omit `--change` for skill-driven use:

```sh
kata status
kata orient --role implementer --platform opencode
kata build
kata review
kata judge
```

## Handoff

Create a packet before changing platform or role:

```sh
kata handoff create --task <task-id> --from implementer --to reviewer --platform opencode
kata handoff verify --task <task-id> --id <handoff-id>
kata handoff show --task <task-id> --id <handoff-id>
kata handoff acknowledge --task <task-id> --id <handoff-id> --platform github-copilot --role reviewer
```

The consumer reads every `requiredReads` path, obeys the packet's allowed writes, and writes only the canonical role artifact. If `requiredReads` includes `.kata/tasks/<task-id>/model-routes/<role>.json`, the consumer must read its `decision` field:

- `recommended` — use the Kata-recommended platform model option when the host supports switching.
- `current` — keep the model already active in the host tool.
- `custom` — use the user-supplied `decision.model`.

Any HEAD, branch or diff change invalidates the packet, so create a new one before handing work to the next role.

Acknowledgement also activates the task locally:

```text
.kata/runtime/active-task.json
```

The active record stores task id, receiving role, platform, branch, phase, and an `origin` such as `handoff`, `workflow`, `discovered`, or `manual`. This lets a receiving platform run `/kata-build` or `kata status` without asking the user to repeat the task id. If there is exactly one unfinished same-branch task and no active task, `kata status` auto-activates it with the next suggested role; if there are multiple unfinished tasks, Kata reports candidates and asks for confirmation.

This is intentionally limited to one local worktree and Git branch. Kata does not move private conversation history, synchronize multiple clones, or launch provider-specific models. Model routes remain optional, auditable execution hints; they record both Kata's recommendation and the user/agent decision, but they do not prove the host actually selected that model.
