# A major finding gated the node and then could not be closed

A `major` finding stopped a node and had no way to be accounted for. `blockingAdversarialFindings` refuses approval on
`blocking` **or** `major`; `isTerminalSeverity` names exactly those two classes; and the repair batch opens on both. But
the obligation producer — the thing `closeBatchAfterSeal` reads `answered` from — skipped anything that was not the
literal string `'blocking'`.

So a `major` finding gated approval and was then permanently unclosable. Observed on `check-log-artifact-missing`: three
findings repaired, the content re-sealed to a new revision, and the batch still reported `closed: false, answered: 0`,
while the next adversarial brief went on framing the round as *"an open major finding is unrepaired"*. The platform
reported a completed repair as unmade, forever.

The defect turned out to be three layers deep, and each layer was only visible once the previous one let the next seal get
far enough to fail:

| layer | defect | state |
|---|---|---|
| 1 | `persistBlockingFindings` decided by a literal, not by `isTerminalSeverity`; `recordFinding` refused to call it for anything else | repaired |
| 2 | nothing called it for an **adversarial** finding at all — its only caller handled review findings, so the batch had no finding it could account for | repaired |
| 3 | `collectSealPreflight` refuses on unresolved obligations *before* the checks, and `resolveObligationsForRevision` runs *after* them — so an unresolved obligation blocks the run whose evidence would answer it | **recorded, not repaired** |

Layer 3 is pre-existing and was unreachable because the preflight's obligation check returned early for a task with no
acceptance matrix. Removing that early return — necessary, because closure resolves from acceptance ids and evidence and
does not need a matrix — makes the deadlock reachable on the default task shape. Closing it means deciding *when* an
obligation may be answered by evidence the current run is about to produce: either the preflight stops refusing on
obligations this revision can still answer, or resolution moves ahead of the preflight. Both change what the seal means.

What this change does instead is stop the platform **lying**: on a matrix-less task the seal now refuses and names the
obligations, where before it passed silently and left the batch open forever.

Alongside it, the CLI defect that made the whole mechanism unusable: `kata-cli adversarial finding add --change <id>` —
documented in the generated review and verify Skills, in the adversarial brief, and three times in `docs/operations.md` —
resolved its task id to the literal word `add`, because `parseChangeArg` returns the first non-flag token from a `rest`
that still begins with the action word. The command died with `ENOENT: .kata/tasks/add/adversarial-review.json`, so the
"report a finding as it is confirmed" path the brief depends on was dead: every finding had to wait for the final
`record`, which is exactly the loss the batching rule exists to prevent. It now reads `--change` from the flag, and every
other `parseChangeArg(rest)` call site was checked for the same shape.

Suite: 899 passed, 0 failed.
