# `stale` is a state, not a sentence: revalidating a Wiki record

`verifySources` marks a record `stale` when its sources change — and nothing could move it back. `register` skips an id
that already exists, `promote` requires `candidate`, `rebuild` clears the whole store. So a record for a page that was
edited even once was stale **forever**, and because the closure gate reads records, it could keep reading a record whose
sources no longer matched — indefinitely, and for every task in the project. The remedy was a `wiki refresh --record`.

## What changed

- **`revalidateWikiRecord(root, id)`** is the missing transition: it recomputes the record's `sourceHashes` from the
  sources as they are now and returns the record to **`candidate`** — not to `verified`. Refreshing a hash is a mechanical
  fact about the files; "verified" is a governance claim that goes through promotion (and its passing validation task)
  like any other record. The state machine keeps its meaning instead of gaining a bypass for the case that mattered today.
- Sources that no longer exist are **reported, not dropped**: the ref stays on the record so the gap remains visible and
  the next drift check says so again.
- **`revalidateStaleRecords(root)`** sweeps the store, and `kata-cli wiki revalidate --record <id> | --all` exposes both.
- An unreadable record is named with its validation error rather than reported as missing (the tolerant read from the
  previous commit is what makes that distinction possible).

## Verification

- `tests/unit/wiki-revalidation.test.ts` — an edited source makes the record stale and revalidation returns it to
  `candidate` with the refreshed source recorded, after which the drift check reports it intact; the sweep handles every
  stale record; a deleted source is reported instead of hidden. Full kata suite: 587 tests in 70 files; `dist/cli.js`
  rebuilt.
