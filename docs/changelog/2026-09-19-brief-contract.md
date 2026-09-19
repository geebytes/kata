# The brief contract of §18, filled in

§18.5 asks a brief to carry six things and to withhold two. Four were already there (the delta surface with paths, the
reading set, the sealed evidence ids with their paths, and the batching instruction); two were not, and the reading set was
there without the detail the token account says matters most.

## What changed

- **Reading set entries carry their size** (`~1200 lines`). The measured round re-read a ~1200-line helper four to five
  times per hypothesis set at ~15k tokens a read; a size turns *"read this file"* into *"this file is ~40 lines, this one
  ~1200"* — which is what lets a reviewer decide to read a region instead of the whole thing. Deliberately sizes and not
  line *numbers*: a region of interest cannot be known without reading the file, and a fabricated one is worse than none.
  An unreadable path (a directory-shaped owned path, a file since removed) carries **`null`**, printed as no size at all —
  "empty" and "not readable" are different claims, and conflating them would teach a reviewer to trust an unmeasured size.
- **The round states its scope and why, in the text.** `scopeReason` was computed by C4 and returned on the brief but never
  rendered, so "what this round does not cover" was available and invisible. It now appears beside the framing, with the
  sentence that stops an unexamined area reading as verified: a delta round's excluded paths were covered **on an earlier
  revision**, and the gate decides whether that is still enough.
- **The attempt cap, with its escape hatch.** At most **six attempts**, exceeded only with a **reproduction** — a concrete,
  repeatable command, input or sequence. The reason is stated where it applies: round cost grows with the square of the
  turns, so the last attempts are the most expensive ones, and what the cap rules out is not thoroughness but attempt nine
  restating attempt two.

## What it deliberately still withholds

The author's conclusions, and any mutable state the act of recording rewrites — both §18.5's prohibitions, and both still
enforced by the issued-brief binding.

## Verification

`tests/unit/adversarial-review.test.ts` gains the contract case: a reading set entry is printed with its size, an
unreadable one is printed **without** a fabricated `~0 lines`, the cap and its reproduction escape hatch are present, and
the scope's reason appears in the text. Full kata suite: 779 tests in 96 files; `tsc` clean; `dist/cli.js` rebuilt.
