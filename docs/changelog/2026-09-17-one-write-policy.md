# One write policy, embedded where it is enforced

The architecture review's L1-04 finding: the policy that blocks a write existed twice. `src/policy/permissions.ts`
held a typed implementation with no production caller, and the platform hook script the installer emits carried its
own hand-written copy of the same role/scope matrix — with its own path normalizer, its own denial vocabulary, and
details that had already diverged (the emitted copy added a phase rule; the typed copy rejected absolute paths
outright and still declared an unused `task_scope_violation` reason). The copy that ran on a developer's machine was
the untestable one, and the copy the suite exercised could not block anything.

## The policy now lives in one place

`src/policy/hook-policy.ts` holds the rule as a dependency-free pair of functions:

- `normalizeHookPath(projectRoot, targetPath, pathApi)` — root-bounded normalization; refuses empty paths, NUL bytes,
  Windows drive paths, any path containing a `..` segment, and anything resolving outside the project root. The path
  API is injected so the function stays self-contained.
- `evaluateHookWrite(actor, normalizedPath, task)` — the role/scope matrix, including the phase rule that only the
  emitted copy had (`intake`/`plan`/`archive` may not write `src/` or `tests/`), and one denial vocabulary:
  `invalid_path`, `phase_scope_violation`, `protected_rules_or_verified_wiki`, `role_scope_violation`, `unknown_role`.

`renderHookGuardScript` embeds both functions into the emitted guard with `Function.prototype.toString()`, so the
script that runs and the module that is tested are the same source text — no build artifact, no second copy to keep
in step. `renderPolicySource()` renders the pair; `validateWrite` calls the same two functions in process. The
protocol half of the guard (arg parsing, stdin payload, active-task lookup, exit codes) is unchanged.

`validateWrite` gained an optional `root` (defaulting to `process.cwd()`) and now normalizes through the shared
function, so an absolute path inside the project root is allowed where it was previously refused as `invalid_path`,
and a path containing `..` is refused as `invalid_path` on both sides.

## Verification

- `tests/unit/hook-policy-parity.test.ts` — 20 cases (roles, phases, protected paths, traversal, drive paths,
  absolute paths inside and outside the root, unknown role, the phase rule) executed twice: through `validateWrite`
  in process and through the generated guard script, asserting the same allow/deny outcome *and* the same denial
  reason. Drift between the two now fails the suite.
- `tests/unit/installer.test.ts` — the existing hook-driven test still spawns the installed guard and passes
  unchanged, which is the evidence that the swap kept behaviour.
- Packaged artifact: `dist/cli.js` installed the guard into a scratch project, the file contains the embedded policy,
  and running it allowed a `src/` write (exit 0) while blocking `docs/superpowers/rules/` (exit 2,
  `protected_rules_or_verified_wiki`).
- Full suite: 436 tests in 46 files, all passing; `tsc --noEmit` clean; `dist/cli.js` rebuilt.
