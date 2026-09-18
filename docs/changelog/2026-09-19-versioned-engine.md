# The engine is versioned, and a mid-task change says so (C7)

§17.4 recorded what an unversioned engine cost, in the same day the rest of this design was measured: **the review gate
gained a node requirement and the brief gained a framing mode while passes were in flight.** Both were improvements; both
cost a diagnostic cycle, because the flow could not tell *"the rules changed"* from *"I did something wrong"*.

## What landed

- **`engine` on the task record** — the kata version, stamped at creation and **restamped as the task advances**. "Last
  seen", not "first seen": the question a reader actually has is *did the engine change since I last ran this?*, and a
  first-seen field answers a less useful one. The restamp rides along inside the state transition, which is the one place
  that already holds the task lock — a separate locked write would re-take a non-blocking lock and throw.
- **`engineVersion()`** reads the version from the package the bundle was built from, through the same asset inlining the
  schemas use, so the running version is a fact about the built artifact rather than an assumption.
- **`engineChangeNote()`** produces the sentence, and **`status` reports it** alongside `engine: { running, task }`. Three
  outcomes, deliberately: no stamp ⇒ nothing said (a task created before the field existed reports *unknown*, never
  *changed*); same version ⇒ nothing said; different version ⇒ the note names both versions and states what it explains.
- **`stampEngineVersion()`** for callers outside a transition, and the unlocked variant the transition itself uses.

## What it deliberately is not

**Not a compatibility gate.** Kata is a tool a project installs and updates at will; refusing to run because the version
moved would break the exact situation the field exists to explain. The mismatch is **reported** — in `status` — and never
enforced, and the restamp is best-effort: a task must not fail to advance because a diagnostic could not be written.

§17.1 also names the process rule this makes visible rather than the mechanism it replaces: *engine changes land between
tasks*. The field is what lets a project notice when that did not happen.

## Verification

`tests/unit/engine-version.test.ts` (5): the version is read from the built package; a task is stamped at creation; a task
that last ran under another version produces the note naming both sides, while an unchanged one and an unstamped one
produce nothing; a restamp reports what it replaced and happens under the lock (a task file holding `0.0.9` comes back as
the running version); and advancing a task restamps it inside the transition, after which `status` agrees and stays quiet.

Full kata suite: 777 tests in 96 files; `tsc` clean; `dist/cli.js` rebuilt.
