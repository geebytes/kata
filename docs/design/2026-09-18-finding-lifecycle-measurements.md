# Measurements for the finding-lifecycle design (2026-09-18)

> Status: **measurement report**, read-only. Nothing in this file changed kata, and no task was sealed to produce it.
> It answers §11 of `2026-09-18-finding-lifecycle-and-proportional-reverification.md` — the design's own list of things it
> could not verify — because the design says F4's value rests on numbers nobody had taken.

## What was measured, and how

Read-only analysis of the k2skills workspace's own artefacts (220 revisions, 81 tasks, **788 recorded evidence
envelopes**, each carrying `startedAt`/`finishedAt`), plus `git`-free structural facts. No seal was run; no file was
written outside this document. The scripts were throwaway and are not part of the repository.

## 1. F2's cost model — the per-path bookkeeping is cheap

| Fact | Value |
|---|---|
| Revisions recorded | 220 |
| Owned paths per revision | min 1, median **11**, p90 ~24, max **43** |
| Owned paths that are directories (so `pathDigests` must expand them) | 441 of 1728 |
| Consecutive revision pairs | 140 |

**Verdict on the unmeasured risk.** The design worried that expanding directory owned paths "会放大记录体积（估计 10³ 量级条目）".
For a real workspace the expansion is a few hundred entries per task at most (`tests/`, `packages/…/domains/`, …), and the
one revision that already records digests holds **676 entries**. So the estimate was right and the cost is small — this
risk is **closed**.

## 2. F4's mapping rate — 79.5% of owned paths are declared by the matrix

| Fact | Value |
|---|---|
| Tasks with an acceptance matrix | **79 of 81** |
| Matrix rows / declared implementation paths / declared test paths | 504 / 790 / 607 |
| Rows declaring no path at all | **0** |
| Owned paths covered by some row's declaration | **570 of 717 = 79.5%** |

Of the 147 uncovered owned paths, the sample is decisive: `uv.lock`, `packages/…/pyproject.toml`,
`docs/superpowers/plans/…md`, and **directory** entries such as `tests/`, `packages/…/skill_factory/`.

**Verdict.** The design's fear — "矩阵若覆盖不全" causing fallback on every change — is **not** what this workspace shows
at the task level: four fifths of what a task owns is declared by the acceptance criteria it was written against, and no
row is path-less. The `79.5%` figure is also a **lower bound on the fallback rate, not an upper bound**: the derivation
falls back only when a *changed* path is undeclared, and a lockfile or a directory entry changing is exactly the case that
should fall back (running everything).

## 3. The cost the derived set would avoid — measured per seal, and the answer is uncomfortable

80 seals recorded ≥3 checks (up to 1,325s of checks in one seal).

| Fact | Value |
|---|---|
| Seals containing a whole-suite check | 64 of 80 |
| **Share of a seal spent in the whole suite** | min 0.3%, **median 4.5%**, max **34.2%** |
| Per-check duration | p50 **4.2s**, p90 126.1s, max 604.0s |
| Dominant single check | `make test` — **158 runs, avg 165.1s, max 604s, across 79 of 81 tasks** |

**The uncomfortable part.** The dominant check is `make test` (`make` → `uv run pytest tests/ -v`, the project's declared
`buildChecks` entry) at **165s average**, and it runs in **79 of 81 tasks** — which is *correct*: it is declared, and the
matrix often does not declare it, so F4's derivation sees a declared check the change may not "touch" and (per the design's
own rule 4) keeps it whenever the mapping is uncertain.

**So the measurable saving is much smaller than the design projected.** The design expected "把 2 行修复的 pass 从 10–22
分钟压到 2–3 分钟". On this data:

- the whole suite is a **median 4.5%** of a seal, and only the seals where the suite is the bulk (up to 34%) have room;
- what actually dominates a seal is a spread of **many medium checks** (p50 4.2s, but 542 `test` runs totalling 28,885s),
  and those are the *acceptance* checks the change surface genuinely does touch — which is precisely what F4 keeps;
- F2's delta brief shortens the **reviewer's** pass, and that saving is real but is not visible in this data at all: no
  reviewer pass in the workspace was recorded as a delta (the field is one day old), and the design's 619s–1331s figures
  are wall-clock reviewer time, not seal time.

**Verdict.** F2's mechanism is sound and cheap (1), and F4's derivation is accurate enough to be worth having (2) — but
**the projected saving is not supported by the workspace's own data**, and the largest cost is a *declared* check
(`make test`) that no derivation is entitled to drop. That is the finding this measurement was commissioned to produce.

## 4. What this changes about the design

1. **F4 should not be sold as the seal-cost fix.** Its measurable effect here is bounded by the 4.5% median suite share, and
   its larger effect is on *clarity*: a seal says which of its checks the change touches and which it ran anyway.
2. **The declared `make test` is the real cost**, and it is a **project decision**, not a platform one: the project
   declares it in `.kata-config.json`, and the platform's own mechanisms (F4's derivation ✓, `tier: 'frozen'` ✓,
   `coveredBy` ✓) all defer to that declaration by design.
3. **F2's saving must be measured where it lives**: on a reviewer pass recorded as `scope: { kind: 'delta' }`, comparing
   pass duration against the previous full pass. That measurement is possible now and was not before; it needs one task's
   next two rounds, not more analysis.
4. **The design's §11 can be updated**: the `pathDigests` cost risk is closed, the F4 mapping rate is measured (79.5%
   declared, 0 path-less rows), and the projected F2 saving is **not confirmed**.
