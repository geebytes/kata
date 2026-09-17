# Wire the bounded repair scope, and let the evidence level rule decide

Two gates in the quality boundary were declared, typed and unit-tested, but never reached from a live path. Wiring
them closes the first gap the `strata-foundation` verification found.

## `enforceRepairScope` is now a real gate

`src/quality/repair.ts` exported `enforceRepairScope`, `Finding`, `DiffSummary` and `DiffBudget`; nothing in `src/`
imported them, and the generated skill text nevertheless promised that "unrelated changes will be rejected by
`enforceRepairScope`". The seal path now enforces it: while a repair is active, `cmdBuild` derives the repair's
declared scope from the acceptance matrix rows of the criteria that repair was authorized for
(`repairScopePaths`), compares it against the paths the workspace has actually changed since `HEAD`
(`outOfScopeRepairPaths` over `inferOwnedPathsFromWorkspace`), and refuses to seal when the repair reached outside
it:

```
Repair touched files outside the failed acceptance scope: unrelated.md.
Fix only the failing acceptance criteria, or confirm with --allow-out-of-scope-repair.
```

Two properties are deliberate. A repair that records no acceptance scope — drift-authorized
`revision_superseded` repairs, whose whole purpose is to re-seal a revision the workspace has already moved past —
is not constrained, because there is no failed scope to exceed. And the refusal is acknowledgeable through a new
`--allow-out-of-scope-repair` flag, so a genuinely needed extra change has a discoverable, recorded exit rather than
an unreachable gate.

## The evidence-level rule decides once

`hasRequiredEvidenceLevel` and `isEntrypointEvidenceKind` were exported helpers with no callers, while `judge()` and
verify's readiness each inlined their own version of the level check. Now:

- `evidenceMatchesRow` requires the declared evidence kind to satisfy the row's level
  (`hasRequiredEvidenceLevel`), so an entrypoint-level acceptance cannot be satisfied by unit-test evidence;
- `validateMatrix` rejects such a matrix up front, with "declares a entrypoint-level acceptance but only test
  evidence", instead of leaving an unsatisfiable row to fail later as `insufficient_evidence_level`;
- `judge()` and verify's readiness call `isEntrypointEvidenceKind(row.verificationLevel)` instead of repeating the
  two-value comparison.

Behaviour change to note: a matrix row at `entrypoint` level that declared `test` evidence is now rejected at seal
preflight and no longer matched at Judge time. Integration-level rows are unaffected, since the level rule accepts
`test` evidence there.

## Verification

- `tests/unit/repair.test.ts` — scope derivation from the matrix (unknown criteria and drift-authorized repairs yield
  no scope) and out-of-scope path detection.
- `tests/e2e/repair-scope.test.ts` — the gate end to end in a git workspace: a repair that touches a file outside the
  failed acceptance scope is refused with `unrelatedRepairPaths`, the same repair seals with
  `allowOutOfScopeRepair`, an in-scope repair seals unchanged (phase `hardVerify`), and a drift-authorized repair is
  not constrained.
- `tests/e2e/quality-gates.test.ts` — the matrix level rule and the level-aware `evidenceMatchesRow`.
- `tests/unit/installer.test.ts` — its hook-guard helper spawned a hardcoded
  `/home/work/.nvm/versions/node/v22.23.1/bin/node`, which made the suite fail on any machine without that exact
  path and would have failed the repository's own declared `npm test` seal check. It now uses `process.execPath`.
- Full suite: 432 tests in 44 files, all passing; `tsc --noEmit` clean; `node scripts/build.mjs` rebuilt.
