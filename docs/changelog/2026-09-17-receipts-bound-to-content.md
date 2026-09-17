# A handoff receipt is bound to what the task owns, not to a commit

Measured cost of the old rule, for one task in one day: **40 packets, 18 receipts (908 KB)**, and the implementer's
packet rebuilt 13 times. Every commit invalidated every receipt, including commits that touched only `docs/` or
`.llmwiki/` — paths no revision covers. Committing a wiki page was being read as a change to the artefact under review.

## What changed

`verifyContextPacket` no longer fails on a moved HEAD. What it compares is the packet's **anchor**:

- `sameScopeIdentity` now checks the anchor's kind, its paths **and its manifest hash** — it used to compare the
  revision *id*, so sealing the same content again produced a new id and every receipt expired with it;
- `diffHash` (the anchor hash, i.e. the owned paths' content) remains the gate: if what the task owns changed, the
  packet is still refused — with the 40-packet history, never at the expense of the thing the check exists for;
- `branch_mismatch` and `packet_hash_mismatch` are unchanged.

`head_mismatch` is gone from `ContextPacketVerification`; the packet still records the head it was created at, it just is
not what the packet is about.

## Verification

- `tests/unit/context-fabric.test.ts` — a packet stays valid after a commit that touches nothing the task owns (the test
  moves HEAD and asserts the head actually moved first), and still fails with `diff_mismatch` when the task's own context
  changes. Full kata suite: 566 tests in 67 files.
