# Independent adversarial review at the verify and review nodes

Verify and review ask the same context that wrote the change whether the change is sound. That context shares the
implementation's assumptions, its blind spots, and — most importantly — its reading of its own evidence: a test that
passes for the wrong reason looks like proof from inside the context that wrote it. The two nodes where a change is
judged were therefore the two nodes with the weakest available judge.

## What the mechanism is

An **independent adversarial pass**: kata renders a self-contained brief, the host runs it in a *clean-context
subagent*, and the structured result comes back bound to the sealed revision and to the brief it was given.

- **`kata-cli adversarial brief --change <task> --node verify|review`** renders the brief and reports its SHA-256. The
  brief names the sealed revision, the acceptance criteria under test, the evidence the author recorded (id, kind, exit
  code, command, check id), the findings recorded so far, and the exact JSON result shape. It instructs the reviewer to
  read the repository rather than the brief, to form and run **at least one falsification attempt per claim**, to report
  `refuted` when it cannot break a claim, and to report a finding for every defect it confirmed.
- **`kata-cli adversarial record … --from-file <result.json>`** validates and files the result.
- **`kata-cli adversarial waive … --reason "<why>"`** records the explicit decision to proceed without it.
- **`kata-cli adversarial status --change <task>`** reports both nodes.
- The `/kata-verify` and `/kata-review` skill text carries the step — render the brief, *run it in a clean context (the
  host's own subagent facility, no prior conversation), hand it the brief verbatim*, record what came back, read the
  gate's answer, then run the node's own command. The other skills do not carry it: the mechanism belongs to the two
  nodes that conclude about a change.

## What kata can and cannot hold

Kata is a CLI. It cannot start a subagent, and it cannot inspect the host's session — so the claim "this ran in a fresh
context" is an *attestation* by the executing agent (`executedInFreshContext`, `contextNote`), exactly as host model
confirmation is. Being precise about that boundary matters more than pretending otherwise.

Everything else is checked. A pass satisfies the gate only when it names the **current** revision, attests a fresh
context, carries the hash of the brief kata renders **now** (a pass against an older brief answered a different
question), and contains at least one attempt. `status` reports which of those failed. The gate fails closed for every
other reason, and a waiver is reported as a waiver rather than hidden.

**The gate is a hard requirement at both nodes**, which is the consequential part of this change:

- `kata-cli verify` succeeds only with a recorded pass for the current revision, or a waiver.
- `kata-cli review --approve` likewise — an approval is the review's conclusion, and the reviewer may not certify a
  change their own context authored and read.
- Findings at `blocking` or `major` severity from the pass stop the node until they are repaired, through the same
  bounded-repair path reviewer findings already use (`repair_blocking_review_findings`).

Two new next-action reasons (`adversarial_verify_pending`, `adversarial_review_pending`) carry the gate into the
resolver, so the dispatcher, the CLI fallback and the skill text all point at the same next step.

## Consequences, stated plainly

- **Every end-to-end flow gains a step.** Fifteen fixtures that walk a task to verify, review, judge or archive now
  record a pass (`tests/helpers/adversarial.ts`), which is the evidence that the gate bites rather than being decorative.
- **Discovery is not the only option for a project that disagrees.** A repository that does not want the pass at these
  nodes records waivers per node, which are visible in `adversarial status` and in the artefact; the requirement itself
  could be narrowed to strict-mode tasks in one place (`cmdVerify`/`cmdReview`'s gate calls) if that is the preferred
  policy.

## Verification

- `tests/unit/adversarial-review.test.ts` — the brief carries everything a clean context needs (claims, evidence, paths,
  prior findings, the result shape, the record command); the gate accepts only a fresh-context pass over this revision
  and this brief, and reports `missing`/`no_revision`/`stale_revision`/`not_fresh_context`/`brief_mismatch` distinctly; a
  waiver satisfies the gate and is labelled `waived`; confirmed `blocking`/`major` findings travel with the pass; and the
  verify/review skills carry the instruction while the other skills do not.
- `tests/e2e/workflow-resume.test.ts`, `tests/e2e/wiki-distillation.test.ts` — the end-to-end flows record passes at
  both nodes and proceed; the gate is exercised by every one of them.
- Full suite: 527 tests in 61 files, all passing; `tsc --noEmit` clean; `dist/cli.js` rebuilt. `docs/operations.md`
  documents the mechanism, its commands and the gate.
