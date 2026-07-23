# Cross-agent task-root discovery

## Problem

An agent can start in a parent workspace while the explicitly named Kata task is
owned by a nested Git worktree. Ancestor-only lookup fails even though exactly
one task exists locally. Generic workspace-marker lookup is unsafe because it
can instead mutate an unrelated `.kata` state tree.

## Resolution order

1. An explicit `--root` remains authoritative.
2. Search the current directory and its ancestors for an exact task state path.
   One result wins; multiple results are ambiguous and fail closed.
3. If no ancestor owns the task, search descendant Git worktree roots beneath
   the current workspace for the exact task state path. Skip dependency,
   metadata, build, and Kata-internal directories. A single result wins;
   multiple results fail closed with all candidate roots.
4. If no result exists, report that neither the current/ancestor workspace nor
   an eligible nested worktree owns the requested task.

The descendant fallback is task-addressed only. It never runs for `open`, so a
new task cannot accidentally be created inside a nested repository.

## CLI scope

Every local command that accepts an explicit task ID must use this resolver,
including `status`, workflow phase commands, and `recover`. Commands that use
`--task` (such as handoff operations) must derive the same root before reading
or writing task files.
