# The brief requires promotion, and prices a turn (§18.5, §18.8, §19.4)

§19's finding is the one that explains a whole class of the measured cost: **a probe is not a test case.** A probe's
expectation is the reviewer's *prediction*, so its failure is ambiguous until "the code is wrong" is separated from "my
experiment is wrong" — and that separation is most of a round's motion. Three consecutive rounds rewrote experiments for the
same class of property because the properties were **re-probed instead of promoted**.

## What the brief now requires

The two halves of a turn, both stated where the reviewer reads them:

- **Batch the commands, concretely.** Not "batch commands" but: **merge several queries against the same file into one**
  (five reads of one artifact are five turns carrying a context that already holds it), **prefer one test invocation over
  several**, one `grep`/`find` sweep with several patterns rather than one per pattern. The §18.8 measurement is quoted in
  the brief so the instruction is credible rather than stylistic: **38 cases in one focused invocation took 57.5 s, four of
  them accounted for 39 of those seconds, and the difference from a 0.14 s case was launching a subprocess** — the cost is
  process launches and unpacking, not case count.
- **Use the cheapest instrument that can answer**, in order: **ask whether an existing test already encodes the property**
  and if so **mutate rather than write** (two commands, no new code); otherwise write a probe but **state the prediction
  before running it**; **assert the injection landed**, because a mutation whose target no longer exists runs **zero** times
  and exits 0 — read naively it says "the guard does not fire" when it says "the probe never fired it"; and **promote**
  anything permanent into the suite, **naming the test**, discarding the rest.

The promotion order is what makes the *next* round cheaper: after a promotion the round writes no experiment at all, it
mutates and observes. It also changes what work is left — only "the property is fixed, the sensitivity deepens" survives,
which is the one class worth paying for.

## Why it is in the brief rather than only in the design note

The design note had it; three rounds of the same motion happened anyway, because the note is not what a reviewer reads
while working. That is the same reasoning as the earlier M-series corrections: **an instruction that is not in the text the
instrument reads is not an instruction.**

## Verification

`tests/unit/adversarial-review.test.ts` gains a case asserting all five required instructions (suite-first-then-mutate, the
prediction, the landed injection, the named promotion, the two concrete batching rules) plus the §18.8 numbers that make the
batching credible. Full kata suite: 791 tests in 98 files; `tsc` clean; `dist/cli.js` rebuilt, and the rendered brief
verified against the real task.
