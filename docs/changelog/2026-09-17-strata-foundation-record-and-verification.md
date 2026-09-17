# Reconcile the strata-foundation record, and record what verification actually found

`strata-foundation` is the change that produced the first release. Its record had drifted from the repository in
three ways, and reconciling it was a precondition for archiving the change rather than a formality: the verification
that followed found three capability gaps, one of which is a spec-versus-product contradiction that needs a decision
instead of a fix.

## The record

- **Stale metadata.** `.comet.yaml` still pointed `design_doc`, `plan` and `handoff_context` at the paths the change
  had before it was renamed from `kata-foundation` to `strata-foundation`. All three files exist under the new names;
  `comet classic validate` went from 3 errors to 0.
- **No stable task identity.** The 35 items in `tasks.md` had no ids, so 51 implementation-plan steps had nothing to
  map to and the build guard failed on "plan task mapping is valid". Each task now carries its own id
  (`<!-- comet-task:1-1 -->` … `6-6`), and the plan is canonical: a single
  `<!-- comet-task-authority: …/tasks.md -->`, no second checkbox ledger, and a `comet-task-ref` for every task id.
  The plan's own checkboxes were a projection of `tasks.md`, never an authority, and the projection disagreed with it
  (the plan still showed Tasks 7–10 open) — the migration removes the second ledger rather than trusting it.
- With that, the build guard passed 14/14 and advanced the change to `verify`.

## The verification

`docs/superpowers/reports/2026-09-17-strata-foundation-verify.md` records the full result: 16 of 19 requirement
scenarios in the change's five capability specs are satisfied with evidence (type check, the 432-test suite, the
build, and a module-by-module mapping), and three are not:

1. **Bounded repair loop / "Repair changes unrelated files"** — `enforceRepairScope` existed, was typed and tested,
   and had no production caller: nothing in the runtime ever computed a diff summary, so a repair that reached
   outside its failed acceptance scope was not blocked. Fixed separately (repair-scope gate).
2. **Workflow evaluation / "Cost regression"** — `runEvaluation` derived every metric from the manifest's declared
   expectations and hardcoded tokens, cost and latency to `0`; the published dogfood report is arithmetic on
   `evals/dogfood-app.json`. Still open.
3. **Vendor-neutral model policy** — the spec and the Design Doc required capability tiers, per-task budgets and
   escalation, while the product had deliberately removed model management ("Kata 不配置、不路由也不记录宿主平台模型").
   No implementation or test has existed for it since.

The report is deliberately not registered as `verification_report` and the verify guard was not applied: its
structural checks would pass on the strength of the file existing, and the substance does not. `comet classic state
transition strata-foundation verify-fail` returned the change to `build`.

## Spec drift handled as a decision

Items 1 and 2 are already-accepted findings of the architecture review, with fixes decided. Item 3 cannot be fixed
by code, so it was handled the way the verify skill requires — by the user choosing among recording the divergence,
returning to build to amend the documents, or confirming the deviation. The choice was to amend the documents, so
the capability now reads **Host-owned model selection**: the runtime SHALL NOT configure, route or record the host
platform's model choice and SHALL NOT store provider credentials, while the role write scopes stay Kata-owned. The
same correction was applied to the delta spec, the change's `design.md` (layout, decisions, risks, migration plan),
the Design Doc and the change's `proposal.md`, so the four documents that describe this capability agree with the
implementation the suite actually exercises.
