# C1 had no producer, so C4 could not fire (and two defects in my own C1 code)

Reported from outside, and it reproduces exactly: **`openRepairBatch` and `closeRepairBatch` had zero production callers.**
The mechanism was complete, correct and reachable in the bundle, and nothing ever opened a batch — so `defaultBriefScope`
always found none and C4's delta default always fell back to full with the reason *"no repair batch has closed"*. Two
delivered features, one of them inert, and the inert one silently disabled the other. This is the same shape as the write
policy's string copy, the four drift sources, and the dead gates: **a mechanism that exists but is not wired.**

## The wiring, at the four moments that matter

- **Open, at the write.** `recordPassFindingsForBatching` runs when `adversarial record` writes a pass's findings — the
  moment they become known, and reached regardless of *which* refusal the node reports first. A `verify` command can stop
  earlier for its own reasons (evidence, obligations, the Wiki closure) and never reach the gate that reports the same
  findings; hooking the write makes the batch independent of that order.
- **Open, at the node's refusal too.** The verify and review gates call it when they refuse over blocking/major findings,
  and a **Judge FAIL** opens a batch from its failed acceptance criteria — same reason, same batch.
- **Close, after a successful seal.** That is the batch's own contract: one seal and one delta round per node per batch.
  `closeBatchAfterSeal` asks the obligations store and the disposition records which findings are accounted for rather than
  trusting a caller's list.
- **Only gating findings.** A `nit` has no batch to belong to, and recording one would inflate the saving the batch exists
  to measure.

## Two defects the report did not name, found while wiring it

**The base revision was named backwards.** C4 reads `closedByRevisionId` as the revision the next round narrows *against* —
so a producer passing the revision sealed **at close** would make the delta empty forever, base and result being the same
content. "Closed by" invites exactly that reading. The field is now **`baseRevisionId`** (`baseManifestHash` beside it, so
a re-seal of unchanged content still narrows), and it is **stamped when the batch opens**, where the artifact the repair
starts from is a fact rather than a caller's recollection. `closeBatchAfterSeal` then takes no revision parameter at all,
because deriving it is the only way that mistake cannot be made.

**An option inverted its own meaning.** The parameter that lists findings *not* blocking a close was called `stillOpen` —
the opposite of what it does, on the one path in the module whose job is to refuse. Renamed `noLongerReported`, with the
three ways a terminal finding is accounted for spelled out: repaired, deferred with a reason, or no longer reported.

## And it is visible

`adversarial status` reports the batch the platform now opens and closes on the task's behalf — its id, its findings, its
base revision, and what batching saved — because a mechanism that acts for the user without saying so is the same failure
in a friendlier costume.

## Verification

`tests/e2e/repair-batch-is-wired.test.ts` (4) drives the chain the report asked for — **record a pass with a blocking
finding → the batch opens with the base stamped → repair → seal → the batch closes → the next brief carries a delta with
`reason` no longer "no repair batch has closed"** — plus the property that the base is never the revision just sealed, and
the reverse case (no closed batch ⇒ still full, with its reason) which already existed in `tests/unit/repair-batch.test.ts`
(9 cases), and the last case asserts that `adversarial status` reports the open batch and then the counted saving (**2
findings in one batch ⇒ 1 seal avoided**). Full kata suite: 790 tests in 98 files; `tsc` clean; `dist/cli.js` rebuilt with
the producers present.
