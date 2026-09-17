# A superseded seal authorises the re-seal from hardVerify

The error a re-seal hit today, after changing code at a sealed revision:

```
Build cannot run from hardVerify without a repairable verify FAIL result
```

The only way forward was to run `kata-cli verify` — knowing it would FAIL on `revision_superseded` — so that the phase
moved back to `implement`, and *then* seal. A pure extra round-trip per re-seal, and the same "authorised but
unrecognised" shape as the two deadlock fixes (`cfe616a` review → build, `be7b196` judge → build).

## What changed

`authorizeVerifyRepair` now authorises re-entry when the **sealed revision no longer matches the workspace**, for the
same reason the review entry does: once the revision is superseded, the recorded verdict cannot describe the current
implementation, and the only alternative is to judge with evidence that no longer matches. It records
`reason: 'revision_superseded'` with no scopes, so the seal is still bounded by the normal preflight.

When neither drift nor a repairable verdict applies, the refusal now names the one thing to run
(`kata-cli verify --change <task>`) instead of leaving the agent to read the bundle.

## Verification

- `tests/unit/repair-entry.test.ts` — the superseded case authorises with `revision_superseded`, and a PASS verdict with
  a matching seal still refuses **and** reports the remedy in its message. Full kata suite: 572 tests in 67 files.
