# One subprocess facility

The architecture review's L5-01 finding: eleven modules spawned child processes directly, each with its own
conventions. The evidence collector had a carefully bounded async runner (process-group `SIGTERM`→`SIGKILL`, timeout
mapped to exit code 124, captured output, abort signal) while `revision.ts`, `acceptance-matrix.ts`, `comet/install.ts`,
`comet/compat.ts`, the CLI and the archive path used one-line `execFileSync` calls with no timeout, no captured
stderr and inconsistent environments. Behaviour that should be invariant was reinvented per call site, and the
differences stayed invisible until a particular environment exposed one.

One had already become a defect: `codegraph` was invoked in four places, and three passed the PATH fix plus a working
directory while the archive-time refresh passed **neither** — so the one call that runs when a task is archived was the
one that could not find a codegraph installed beside the running Node, and it did not run in the workspace root.

## What is one facility now

**`process/run.ts`** has two documented shapes:

- `runProcess(command, args, options)` — the default. Async, bounded, spawns in its own process group so a kill stops
  what the child started, captures stdout and stderr (including a per-chunk callback for progress), maps a timeout to
  124 and an abort to 130, and returns a `ProcessResult` with `ok`, `exitCode`, `signal`, `stdout`, `stderr`, an
  optional `failure` reason and an environment summary. A child that fails is a result, not an exception.
- `runProcessSync(...)` — for the callers that genuinely cannot await (git reads, the CLI's subcommands, the Comet
  probes). It reports `{ ok, exitCode, stdout, stderr, error? }` instead of throwing, so the caller decides whether
  that means "not installed" or "failed".

Migrated: the evidence collector's bounded runner, `core/git.ts`'s git reads, `comet/compat.ts`'s runtime probe, npm
root lookup and `which` check, the CodeGraph candidate query, the archive-time index refresh, and the CLI's three
CodeGraph invocations.

**Binary resolution has one home too.** `codeGraphBinary`/`codeGraphInvocation(root)` in `codegraph/runtime.ts` return
the command, the environment (the PATH fix that reaches a binary installed beside Node) and the working directory
together, so a call site cannot pass one and forget the other — which is exactly how the archive-time defect happened.
`archive`'s index refresh now uses it, and its "not initialized" case is distinguished from a failure by asking
whether the index exists rather than by reading an errno out of a caught exception.

## What still spawns directly, and why

- `core/git-flow.ts` — its version probe, installer, git executor and the interactive branch-creation spawn. These are
  *executions with a user watching*, not bounded captures; L5-03 owns unifying that execution model.
- `comet/install.ts` — the npm/comet install, which streams to the terminal with `stdio: 'inherit'` so the user can
  see progress. Capturing it would hide exactly the output an install needs to show.

## Verification

- `tests/unit/process-run.test.ts` — captured output/exit/environment; a timeout mapped to 124 with the process group
  killed even when the child traps `SIGTERM`; cancellation via `AbortSignal` mapped to 130; a missing binary reported as
  `spawn_failed` (127) in both shapes; and the synchronous shape reporting failure and timeout rather than throwing.
- The collector's own tests still pin its log format (`[TIMEOUT after …ms]`, `[CANCELLED]`) and its progress contract,
  which is the evidence that the facility reproduces the runner it replaced.
- Full suite: 522 tests in 60 files, all passing; `tsc --noEmit` clean; `dist/cli.js` rebuilt.
