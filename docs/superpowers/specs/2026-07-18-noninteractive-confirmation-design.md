# Non-interactive Confirmation Boundaries Design

## Goal

Prevent Kata's deterministic CLI from silently selecting user-owned workflow
choices or performing a Git Flow branch creation when invoked non-interactively.

## Scope

This change covers three decision boundaries:

1. `kata open` workflow profile: isolation, development, and review modes.
2. `kata git-flow apply`: creation of the planned Git Flow feature branch.
3. `kata init` without explicit platform and scope.

The slash-command Skill remains the human-facing interface. It discovers
context, explains choices, recommends values, and obtains confirmation. The CLI
is the deterministic execution layer and validates that required choices have
already been supplied.

## Design

### Workflow profiles

`kata open` must require all of `--isolation`, `--development`, and `--review`.
It must reject an invocation missing any of them before creating or changing a
task. The error must identify the missing flags and instruct an agent to use
`/kata-open` to collect user confirmation first.

The CLI will no longer use TTY prompts or `defaultWorkflowProfile()` as an
implicit profile source for `open`. Existing tasks retain their stored profile;
this is a creation-time safeguard only.

### Git Flow branch creation

Creating a branch is a separate confirmation boundary. A task opened with
`--isolation git_flow` records a pending plan. The result must expose a next
action with `requiresUserConfirmation: true` and explain that branch creation
is pending.

`kata git-flow apply --change <id>` must require an explicit `--confirm` flag.
Without it, it returns the pending plan and does not create or switch branches.
The owning Skill asks the user to confirm, then calls the command with
`--confirm`. A direct script can make the same deliberate choice with that
flag.

### Initialization defaults

`kata init` without both `--platform` and `--scope` must not write files in a
non-interactive session. It must return a usage error directing the caller to
use the installation Skill or supply explicit values. `kata init --yes` remains
the explicit automation path and may retain its detected-platform behavior.

Interactive initialization may keep its existing wizard because it visibly
collects language, scope, and platform selection.

## Error Handling

All rejected non-interactive calls must be side-effect free: no task directory,
branch, install manifest, or generated platform files may be created before the
error is returned. Errors must name the command and required next action.

## Tests

Add focused CLI tests that run without a TTY and prove:

- `open` with each omitted workflow flag fails and creates no task;
- `open` with all three explicit flags persists exactly those values;
- `git-flow apply` without `--confirm` leaves the task pending and current
  branch unchanged, while `--confirm` creates the branch;
- bare non-interactive `init` writes nothing, while explicit installer options
  continue to work.

Existing destructive-operation behavior (`uninstall` and `wiki rebuild`) is not
changed; both already reject non-interactive confirmation by default.

## Non-goals

- Change existing task profiles.
- Add model routing or model selection to Kata.
- Remove explicit automation flags such as `init --yes` or destructive
  `--force` flags.
