# One vocabulary for repair scopes and next-action reasons

The architecture review's L2-04 finding: the vocabulary that gates the repair path was a typed union in exactly one
place — `JudgeAcceptanceResult.repairScope` — and bare strings everywhere else. Navigation declared
`repairScopes: string[]`, compared scopes against literals, and the orchestrator carried two hand-written `Set`s of
repairable scopes plus a fourth copy of the scope→reason chain. The installer's skill text listed five of the eight
scopes and had no link to the type, so a scope the Judge could emit was simply undocumented. Nothing failed when a
member was added or misspelled; the compiler could not see the vocabulary at all.

## What is one authority now

**`quality/judge.ts` owns the repair vocabulary.** `repairScopes` is a const tuple and `RepairScope` is derived from
it, alongside the two authorisation sets (`repairableJudgeScopes`, `repairableVerifyScopes` — verify authorises drift
repairs, a Judge FAIL does not) and `isRepairableScope`. The orchestrator's two inline `Set`s are gone; both the
verify-FAIL and Judge-FAIL authorisation checks call the same helper, and the Judge's `repairScope` field is the union
rather than an inline literal list.

**`workflow/navigation.ts` owns the next-action vocabulary.** `nextActionReasons` is a const tuple with
`NextActionReason` derived from it; `nextActionForTask`, `SuggestedAction.reason`, `NextAction.reason`,
`statusActionPrompts` and the CLI's recommendation record all use it instead of `string`.

**Two mappings are `Record`s over the whole vocabulary, so a new member fails compilation until it is decided:**

- `reasonForUniformScope: Record<RepairScope, NextActionReason | null>` — the reason a repair carries when every
  failed acceptance shares one scope. It replaced the four-branch if-chain in navigation *and* the separate
  four-branch chain in the orchestrator, which were the same table written twice. `null` is an explicit "the caller's
  default applies", so the four scopes that have no scope-specific reason are decisions rather than omissions.
- `trustBoundaryByReason: Record<NextActionReason, TrustBoundary | null>` — which reasons stop at a gate. Previously
  four `if`s and a `null` default meant a new gate reason silently stopped gating.

`uniformScopeReason(scopes)` is the shared reading of a failed set: it returns the reason only when the set is uniform
and the scope maps to one, otherwise `null`. Both callers keep their own fallback (`repair_failed_verify` /
`repair_failed_judge`), so behaviour is unchanged.

**The skill text is generated from the same vocabulary.** `manifest.ts` renders the repair loop's scope guide from
`Record<RepairScope, string>`, so all eight scopes are documented — including the three that were missing
(`cross_revision_evidence`, `insufficient_evidence_level`, `unresolved_repair_obligation`) — and a new scope cannot be
added to the Judge without a documented meaning.

**Producer types replace ad-hoc reads.** The three inline structural copies of the acceptance shape are gone: the
orchestrator's `verify.json` and `judge.json` reads use `JudgeAcceptanceResult[]`, and the repair record's `reason`
and `scopes[].repairScope` are the unions.

## Verification

- `tests/unit/repair-vocabulary.test.ts` — every scope has a uniform-scope decision and a documented guide entry;
  uniform and mixed failed sets map correctly; the two repairable sets stay derived from one another and only verify
  authorises `revision_superseded`; every next-action reason has a trust-boundary decision, round-trips through
  `nextActionForTask`, and sets `modelOrPlatformSwitchAllowed` exactly when it gates; every scope appears in the
  rendered `kata-verify` skill text.
- Full suite: 449 tests in 48 files, all passing; `tsc --noEmit` clean; `dist/cli.js` rebuilt.
