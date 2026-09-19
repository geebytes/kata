# Three surfaces, and the seal no longer expires the pass that judged it (§24.3–§24.5)

§24 read the source and found the classification further along than §22 assumed — and three gaps. Two of them are closed
here; the third is named rather than half-built.

## §24.4 — instruments were falling into the code bucket

`splitOwnedPaths` had exactly **two** outputs, so a declared instrument was "code" and its edits invalidated a pass about the
**deliverable**. That is the structural cause of four wasted rounds in one day: the rounds audited an instrument, and the
instrument's edits kept expiring verdicts about the product.

Now three: **instrument / code / governance**, with the instrument class subtracted **before** the code-governance split (an
instrument written in Markdown is still an instrument — the declaration is the more specific statement). `surfaceDigests`
returns all three from one reader, they travel on every binding artefact and on the adversarial record, and the six schemas
that carry a revision binding declare them.

## §24.3 — the declaration exists; declaring it is the project's call

`validateBoundaries` refuses a boundary for an instrument that is not declared, and that is correct: a task that has not
admitted a path is an instrument has not had the conversation that stops the arms race. §24.3's fix — declaring
`instruments[]` for the measured task — is a **project-side** act (it edits that task's record), so it is not done here; the
mechanism and its acceptance test are, and `kata-cli scope declare` is the one command it takes.

## A defect in my own first attempt, worth recording

The first version of the sparing rule had a **second** branch keyed on the *instrument* surface being unchanged. It was
unsound: *"the instrument did not change"* is trivially true when the code changed, so it spared passes it should have
expired — and the test caught it immediately (the case asserting that a moved deliverable is never spared). The rule that
survives is one sentence: **the deliverable pass stands while the code surface it verified is unchanged**, with the claims
precondition on top. The other two surfaces are stamped **for reporting**, not for sparing.

## §24.5 — not built, and why

Non-path inputs (a provider or model identity, a container image, an environment variable) can change behaviour with every
path digest unchanged — and §24.5 is right that this is not hypothetical: the design requires a different representation
identity for the same PDF when the OCR provider or model changes. An `environmentInputs` digest belongs in the classification,
and it is **project-specific**: kata cannot enumerate what a project's behaviour depends on. Building it as a kata-side
constant would be the false-safety it is meant to prevent. Recorded here as open, with §24.5's acceptance test as the shape
it should take (a seeded change to a provider model identity invalidates the affected surface with no owned path changed).

## Verification

`tests/unit/instrument-boundary.test.ts` (+3): the three-way split with instruments subtracted first, including the Markdown
instrument; the surfaces moving independently (editing the checker leaves the code surface bit-identical); the sparing rule —
governance moved ⇒ spared, instrument moved ⇒ spared, deliverable moved ⇒ **not** spared, and every path still requiring the
claims precondition; and `bindsToRevision` per surface, with the default still `full`. Full kata suite: 804 tests in 99
files; `tsc` clean; `dist/cli.js` rebuilt.
