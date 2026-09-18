# The round's framing rotates, and never past an unrepaired blocker (M2)

The pass-cost proposal's M2: every brief the author writes leads with *their* claims ("the fix does X, verify it"), so a
fresh context is asked to check the author's framing rather than to form its own — and the largest defect of the measured
session sat in a file the author had not mentioned, found only because that reviewer went looking on its own.

## The two modes

- **`verify`** — the author's claims are listed, each falsification attempt is required per claim.
- **`cold`** — **no claims**: the brief says so, states that the search is unframed on purpose, and asks the reviewer to
  decide what to attack from the criteria, the change, the sealed evidence and the previous attempts.

## The rotation, and its two limits

`resolveBriefMode` defaults the mode by rotation (an explicit `--mode` still wins) and **writes its reason into the brief**,
so the framing is never something the reader has to guess:

- **an open `blocking`/`major` finding forces `verify`.** A repair round must check the repair; rotating into `cold` would
  let a known defect go unexamined because the coin came up that way. This is a **deploy-time decision recorded in the
  code**, not an open design question.
- the mode is stored on the **record** and as a **property of the brief** — never as an *input* to it. That distinction is
  what keeps M2 from re-creating the D2 defect: recording a pass cannot change the brief it answered.

Verified against the real task: the brief renders `mode: verify` with the reason *"an open major finding
(…-method-row-evidence-hash-shape) is unrepaired, so this round checks the repair rather than opening a new search"* — the
rotation working as intended on a task that has an unrepaired major.

## The skill text

The verify/review guidance now says to read the framing before dispatching, and that a round which reports it is cold
*because the previous one was not* is doing its job rather than asking to be corrected — plus the K1/K2 write-as-you-go
commands and the one-append-per-batch rule.

## Verification

- `tests/unit/adversarial-review.test.ts` — `cold` carries **no** author claim text and says why; `verify` lists the claims
  and still requires one falsification attempt per claim.
- `tests/unit/adversarial-progress.test.ts` — opens cold on a task with no pass, alternates afterwards, **refuses to
  rotate while a major finding is unrepaired**, and honours an explicit `--mode`.
- The generated-asset guard caught this prose change immediately: five assets went stale, all were re-rendered.
- Full kata suite: 723 tests in 85 files; `tsc` clean; `dist/cli.js` rebuilt.
