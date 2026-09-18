# Where the finding-lifecycle design stands, and what is left open

> Status: **standing document**, not a changelog entry — it answers "what exists and what is deliberately absent" for the
> 2026-09-18 design (`2026-09-18-finding-lifecycle-and-proportional-reverification.md`), with the measurements in
> `2026-09-18-finding-lifecycle-measurements.md`. Moved here from `docs/changelog/` because a reader looking for the state
> of a design should not have to find the commit that happened to record it.

## Delivered, in the design's own priority order

| Feature | Commit | What it does |
|---|---|---|
| **F1** finding lifespan | `e872ada` | optional `disposition`/`Reason`/`By`/`At` on both finding records (absent = open); `kata-cli findings list\|defer\|accept\|carry`; blocking/major refuse defer and accept; the decision is printed by the brief, verify (without failing on it) and archive (which requires an explicit carry) |
| **F2** proportional re-verification | `7e57214` | `pathDigests` recorded **beside** an unchanged `manifestHash` (byte-identical regression lock); `adversarial brief --since`; the gate recomputes the change surface and refuses an incomplete delta (`delta_stale` / `delta_unavailable`); kata measures the scope itself at record time |
| **F3** the price of a repair | `c0c5ded` | `reverificationCost` in every brief; `findingOrigins.causedByPreviousRepair` on the pass |
| **F4** derived check set | `c0c5ded` | `relevant-checks.ts`: change surface + matrix, **falling back to the full set** when the mapping cannot be made, with the reason reported; freeze points still require everything |
| **F5** review scope | `c0c5ded` | `reviewedPaths`, read conservatively — no scope means the whole revision; the matrix's suggestion is offered, never written behind the reviewer's back |
| **Measurement** | `7e448f1` | §11 answered: the `pathDigests` cost risk is closed, F4's mapping rate is 79.5% (0 path-less rows), and **F2's headline saving is not supported** — the whole suite is a median 4.5% of a seal, and the dominant cost was the project's own `make test`, already fixed (569.3s/604.0s serial → 165.4s parallel) |
| **Making F2 measurable** | `ed04fdc` | a pass reports `elapsedMs`; the previous pass is snapshotted before replacement; `adversarial status` reports `deltaSaving` or says plainly it is not measurable yet |
| **The procedure in the skill** | `5530b21` | the verify/review text states it, and the printed `recordCommand` carries `--since` and `--elapsed-ms` |

## Open, and whose decision it is

1. **F2's real saving** — needs one task's next two rounds (a full pass and a delta pass with `--elapsed-ms`); the
   mechanism and the instruction both exist now. Nobody has to decide anything; it arrives with the next work.
2. **L1-08** (`.rpiv/artifacts/architecture-reviews/…`) — the five platform renderer shims are still in place. The review
   records the two candidates (delete, or make them a real facade) and that the user declined the deletion when it was
   proposed. Nothing else waits on it.
3. **The 43 regenerated platform assets** in the kata working tree (`.codex/`, `.opencode/`, `.claude/`, `.agents/`) belong
   to another session and have been left untouched throughout.

Nothing in this note changes any code: it is the index the changelogs would otherwise require reading a dozen of to
rebuild.

## Also open: the cost of the pass itself

`2026-09-18-what-an-adversarial-pass-costs.md` is the proposal for the **reviewer loop** rather than for findings: it
measures seven passes on one task (median ≈16 min, machine idle, cost dominated by reviewer turns, not by the checks it
runs), and asks for the brief to hand over the sealed evidence, to rotate between an author-claims mode and a cold mode,
and to carry a cost signal in both directions. It builds on F2/F3 and proposes nothing that replaces them.

