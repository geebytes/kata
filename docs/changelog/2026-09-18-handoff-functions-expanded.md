# The handoff integrity comparison reads as a sequence

L2-07, the review's formatting-only polish: `verifyContextPacket` performed the whole
branch/scope/diff-hash/packet-hash comparison as a single 1,000-character expression with embedded returns, and
`acknowledgeContextPacket` mixed verification, hashing and file writing in one line. The integrity check between a packet
and the live repository was the least reviewable code in its layer — and a reorder of those checks would silently change
which mismatch a caller is told about.

All three are now normal functions: one check per branch, one reason per failure, in the documented order, with the reason
that the order is the contract written down beside it. No behaviour change — the suite that pins the four mismatch
reasons is unchanged.

## Verification

- `tsc --noEmit` clean; the full kata suite passes (610 tests in 74 files), including the context-fabric suite that
  asserts each mismatch reason; `dist/cli.js` rebuilt.
