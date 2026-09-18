# A pass is no longer all-or-nothing (K1–K4)

The pass-cost proposal's §11 split the blame for a review pass that **vanished mid-run** — no error, nothing written, three
minutes of work gone, and the only mitigation a human instruction to "save your findings early". The host lost the job;
**kata made the loss total**, because a pass had exactly one write point at the end while the seal — the other long-running
operation — has had a heartbeat for exactly this reason. These are the four mechanisms the proposal specified.

## K1 — the heartbeat

`adversarial-progress.jsonl` beside `seal-progress.jsonl`, one line per **batch of work**
(`adversarial note --change … --node … --from-file <line.json>`), and `adversarial status` reports the line count and the
last line. A torn final line (what a killed process leaves) is reported as a line count, not as a read error. A write
failure is swallowed: the log observes the pass, and a pass must not die because its observation could not be written —
the same choice the seal's heartbeat makes.

**The trap, from the proposal's own cost table:** one append per hypothesis costs 5–15 turns per pass, which is more than a
crash loses. So the line is per **batch**, and the brief says so (K4).

## K2 — findings land as they are confirmed

`adversarial finding add --change … --node … --from-file <finding.json>` writes one finding onto the node's record
immediately; `record` then seals the verdict and the revision binding. A record that does not exist yet is created as a
**draft with no verdict**, and the gate refuses it exactly as it refuses a missing pass — so "partial" can never be read as
"passed".

## K3 — a partial pass is a valid starting point

The gate binds the brief **as issued**, which turned out not to need a stored copy: after D2 the brief derives only from
durable state, so re-deriving it is an *identity* function and `briefSha256` still matches after a partial record is
written. `BRIEF_DURABLE_INPUTS` / `BRIEF_VOLATILE_INPUTS` write that input surface down where a reviewer of the code can
see it, so a future addition that brings in something volatile has to be made deliberately, next to the rule it breaks.

## K4 — the brief says so

A **Writing as you go** section names both commands, explains that `record` is the conclusion rather than the container,
and states the batching rule verbatim.

## Verification

- `tests/unit/adversarial-progress.test.ts` — the heartbeat holds what the pass established with no record written; a torn
  last line still reads the lines before it; findings land one at a time and a partial record is **not** a satisfied gate; a
  later `record` keeps the findings that arrived separately; and the brief's SHA-256 is identical before and after a partial
  pass writes work.
- Exercised against the real task: `adversarial note` wrote a line and `adversarial status` reported
  `progress: {lines: 1, lastAt, last}` for it (the probe line was removed afterwards).
- Full kata suite: 718 tests in 85 files; `tsc` clean; `dist/cli.js` rebuilt.
