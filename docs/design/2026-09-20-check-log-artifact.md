# The log artifact a truncated check promises

A check that prints more than 2 MB produces an envelope carrying `logTruncated: true` and a `logArtifact` path. The path
is a **promise**: "the excerpt above is bounded, the whole transcript is at this file". The file is not written on the
first seal of a task, and nothing reports that.

This document records the measured behaviour, the two mechanisms that produce it, why an earlier phase's scope note is
not the reason to leave it, and what the fix has to satisfy so the class of defect cannot recur.

## What is actually broken

Measured through the real collector (`collectEvidence` with a `checkLogDir`), 3 MB of stdout:

| state of `.kata/evidence/` | `logTruncated` | `log` bytes | `logBytes` | artifact exists |
|---|---|---|---|---|
| absent (first seal of a task) | `true` | 20 000 | 3 145 728 | **no** |
| present (second seal onwards) | `true` | 20 000 | 3 145 728 | yes — 3 145 728 bytes, complete |

So the trigger is not intermittent. `.kata/evidence/` is created by `writeEvidence`, which runs *after* the checks, so
**the first `--seal` of every task** writes into a directory that does not exist yet.

This is not a correctness defect:

- `exitCode`, `passed` and `logBytes` are unaffected. Truncation applies only to the display copy (`maxLogLength =
  20_000`); the verdict reads the exit code.
- Nothing accumulates. No `.tmp` file is left, nothing is truncated on disk, and no later read trips over it.
- No code consumes `logArtifact` (`grep -rn "logArtifact" src/` finds readers only in `evidence.ts` itself), so this is
  a silent dead reference rather than a crash.

It is a **diagnosability** defect, and it lands exactly where the cost is highest:

1. The excerpt is head **+ tail** with the middle elided (`BoundedCapture.value()`), so the line that explains a failure
   is frequently in the dropped middle — *and* the pointer to the complete output is the thing that is missing.
2. `logBytes: 3145728` sits beside `log: '…'` (20 000 chars), which tells the reader a transcript exists and where it is.
   The reader who follows it gets ENOENT.
3. The asymmetry is backwards: the *first* seal of a task has no artifact, and later seals do. The failure a developer
   knows least about is the one with the least evidence.
4. It got worse in the same body of work: scoping Wiki diagnostics (`docs/changelog`) reduced unrelated drift to a
   count, on the premise that the few records relevant to the task keep their detail. That premise holds for Wiki
   records; the check transcript for the same task now routinely does not.

## Why it happens

Two independent mechanisms, and fixing either alone is not enough to *see* the problem.

**1. The directory is created after the checks.** `src/workflow/orchestrator.ts`:

```ts
// line 569 — the checks are handed a log directory…
checkLogDir: evidenceDir(root),
// …
// line 576 — …and the checks run here…
await writeEvidence(root, taskId, evidence);
// line 784 — …while the directory is created in here, afterwards.
await mkdir(evidenceDirectory, { recursive: true });
```

**2. The write failure is swallowed silently.** `src/process/run.ts` tees chunks to the artifact with:

```ts
artifactQueue = artifactQueue.then(() => appendFile(options.captureArtifact!, text, 'utf8')).catch(() => undefined);
```

`appendFile` with a missing parent directory is ENOENT, and `.catch(() => undefined)` turns it into nothing. The
envelope is built from `logArtifactPath` — the path that was *requested*, not a path that was written — so the field is
populated regardless of whether anything exists at it.

Mechanism 2 is the more general defect: it is what makes mechanism 1 silent instead of loud. A missing directory is one
cause; a full disk, a permission change or a read-only mount are others, and each would be equally invisible.

## Non-goals

- **Not a redesign of evidence capture.** The bounded excerpt stays bounded, head+tail stays, and `maxCaptureBytes` stays
  the documented bound. This change makes the existing contract true; it does not renegotiate it.
- **Not a change to what a check's output is used for.** The verdict still reads the exit code. Nothing here moves a
  judgement onto the log.
- **Not a new field.** `logTruncated` and `logArtifact` are already the contract, and adding a third state
  ("artifact expected but absent") would move the problem to every reader instead of fixing the writer.

## Decisions

### D1 — Create the directory where it is used, not where it is written

`collectEvidence`'s caller owns the directory, so `orchestrator.ts` creates it before collecting. Placing the `mkdir`
in `runProcess` was considered and rejected: `runProcess` is the shared process facility (`src/process/run.ts` is used
by checks, CodeGraph and Git Flow), and giving it an opinion about artifact parent directories spreads one caller's
requirement into every caller's contract.

### D2 — A requested artifact that cannot be written is an error, not a silence

`runProcess`'s tee currently discards the write failure. It must instead record it, and the envelope must stop claiming
an artifact it does not have. The failure surfaces as a `ProcessResult` field (the tee already has a queue and a
`finish` that awaits it, so the error is available at the seam that already exists), and `collectEvidence` either keeps
`logArtifact` when the write succeeded or reports why it did not.

The distinction that matters for the envelope: **`logArtifact` must name a file that exists.** A reader that follows the
field must never get ENOENT, whatever the cause.

### D3 — The guarantee gets a test, so the next cause cannot be silent

The defect was invisible for the ordinary reason: nothing asserted the relationship the field implies. A test that
collects a >2 MB check and requires `logArtifact` to resolve covers mechanism 1. A test that forces a write failure
covers mechanism 2. Both are cheap, and together they make "the artifact exists" a property rather than a hope.

## Acceptance criteria

- **AC-1** — A check whose output exceeds the capture bound yields an envelope whose `logArtifact`, when present, names
  an existing file, and that file holds the complete output. Verified for both a pre-existing and an absent
  `checkLogDir`.
- **AC-2** — When the artifact cannot be written (unwritable parent), the envelope does not claim it: `logArtifact` is
  absent, and the failure is reported rather than swallowed.
- **AC-3** — A first seal (`.kata/evidence/` absent) of a task with a >2 MB check produces a complete artifact.
- **AC-4** — No behaviour change to the verdict path: `exitCode`, `passed`, `logBytes` and `logTruncated` are unchanged
  for a check whose output is and is not bounded.

## Verification notes

- The reproduction is a node script printing 3 MB to stdout, collected with `checkLogDir` pointing at an absent
  directory; the assertion is on `stat(logArtifact)`.
- AC-2 needs a genuinely unwritable parent (a file where the directory should be, or a read-only directory), not a mock
  — the point is that the real `appendFile` failure is observed.
- `tests/unit/process-run.test.ts` already owns `runProcess`'s captured-output contract and is the natural home for the
  write-failure case; the evidence collector's own tests cover AC-1 and AC-4.

## What implementation corrected

Two things the design did not anticipate, recorded here rather than only in a report:

1. **The collector does not create the directory; the orchestrator does (D1 held, but the seam moved).** Creating it in
   `collectEvidence` was the obvious reading of "give it a place to write", and it is wrong: `checkLogDir` is an option,
   and a collector that invents its argument's directory would make every future caller's directory its business. The
   `mkdir` went to `orchestrator.ts` before `collectEvidence`, and the collector's contract became the narrower,
   testable one — *never name a file that is not there*. AC-3 is the orchestrator's guarantee, AC-2 the collector's, and
   they are asserted separately for that reason.

2. **`ProcessResult.artifactFailure` was not a field on `ImportedCheckResult` either.** A check declared with
   `importResult` never spawns, so it never writes an artifact — the seam had to accept the failure channel to keep the
   envelope honest for both paths, which is why the interface grew alongside the process result.

Also worth recording: `design` itself creates `.kata/evidence/` (the design gate runs evidence), so a literal "make the
directory absent" reproduction has to remove it after `design`. The first-seal state is real, but it is not simply "call
`collectEvidence` on a fresh root".
