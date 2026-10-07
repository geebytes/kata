# One source for the protocol and for the tests

**Change:** `one-source-for-the-protocol-and-the-tests`
**Status:** approved design
**Supersedes:** `a-test-must-not-read-the-live-checkout`, `an-assertion-about-a-call-reads-that-call` (folded in here rather than
split, because all three are one class: **an artefact that measures something other than what it names** — the environment
instead of its own fixture, process-global state instead of the call under test, and a hand-copied instruction instead of the
contract it restates).

## 1. Three defects, each measured

### 1.1 The protocol is written twice, so it drifts in 55 places

`kata-cli update` renders the platform assets it has a manifest for — skills (`src/adapters/manifest.ts`'s `skillCommands`,
rendered from `src/adapters/phase-guidance.ts`) and, where a platform declares them, rules and commands. It does **not** manage
agent definitions, and the reason is not a design decision: `subAgents` is a declared platform capability
(`src/adapters/manifest.ts:462-470`; pi declares `false` at `src/adapters/platforms.ts:133`) that **nothing consumes** —
`grep -rn subAgents src/` finds only the declaration and `init-wizard.ts:137`, and there is no `platformAgentPath`, no agent
entry in the manifest and no guard.

So the reviewer's protocol is written twice: once in the render source, and once **by hand** in every agent definition.
Measured on this machine: **55 copies of `kata-reviewer.md`** (36 of them inside `.kata/worktrees/*`, plus the global
`/data/work/pi/agents/`, plus each project checkout, e.g. `/data/work/ahaeureka/zenmpai/.pi/agents/`). When the protocol
changed — a probe answer stopped being a reading, and a request began withholding questions bound to another revision — `update`
refreshed every rendered skill and left all 55 hand copies saying `2. **Answer the probes.**`. The consequence was measured in
zenmpai: a cold reviewer followed the stale sentence, read `probes.json` behind a request whose `probes` was empty, and filed a
blocking finding about its own brief.

### 1.2 Two cases read the live checkout, and one of them blocks seals

`tests/unit/owner-rule-covers-evidence-and-trace.test.ts` hard-codes `/data/work/ahaeureka/k2skills/kata` and asks git about
it (`git add -An .kata/`). Both of its cases therefore answer from the live index. Measured twice in one session: with another
session's `.kata` records staged, git printed nothing and the case failed; with another session's transient lock file removed
mid-scan, `execFileSync` threw `fatal: 无法对 …/holder.json 执行 stat`. Because the seal runs `npm test`, a concurrent session
can block **any** change's seal — which is how it presented: a seal that failed for a reason no code in the change explained.

### 1.3 Assertions that read process-global state, not the call they name

`process.exitCode` is process-wide: a `decide` that refuses leaves it at 1, and a later successful command does not clear it.
Measured: in the archived change's `probe-answer-binding.test.ts`, `expect(process.exitCode).toBe(1)` after a re-answer stayed
green while the write-once guard was deleted, because the value came from the earlier `decide`. Measured repo-wide: **16
`expect(process.exitCode)` assertions across 6 files**, of which 10 in 4 files have no reset before the call they name
(`discovery-challenge-binding` 5, `ledger-cli-end-to-end` 4, `sandboxed-retirement` 1; `policy-write-is-atomic` and
`review-cli-io` only set and restore it). The one file already repaired is not this change's.

## 2. Decisions

1. **The agent definitions stop restating the protocol.** Each keeps only what the host owns — its tool surface and the
   extension registration it needs — plus a pointer to the skill text `update` already maintains
   (`.agents/skills/kata-review/SKILL.md`, `.agents/skills/kata-build/SKILL.md`). A protocol change then has exactly one place
   to land, and the 55 copies carry nothing that can go stale.
2. **The `subAgents` declaration gets a consumer, and stops being wrong about pi.** `platformAgentPath(platform, scope, id)`
   is added beside the existing `platformSkillPath`, and a guard iterates the platforms that declare `subAgents: true` and
   checks the agent definitions that exist there. pi is corrected to `true`: this repository dispatches `kata-reviewer` and
   `kata-implementer` on pi today, so `false` was a declaration nobody had exercised.
3. **The guard asserts the absence of protocol, not the presence of a phrase.** For each covered agent definition: it must
   name the skill it defers to, and it must not contain the protocol's own markers (`kata-cli ledger answer`,
   `kata-cli ledger challenge`, `kata-cli review --change`, `probes`). Two control cases prove the reach: a fabricated
   definition that restates the protocol must be flagged, and a definition that only points must not.
4. **The owner-rule cases build the repository they measure.** A temp directory, the repository's own tracked `.gitignore`,
   one fixture path per kind (a task record, a wiki page, and one path under each machinery directory), `git init`, then
   `git add -An .kata/` **in the fixture**. The assertions keep their substance, and the fixture must contain a path of each
   kind or the case would pass on an empty answer — which is exactly how failure 1.2 hid.
5. **The live-checkout guard learns the shape.** A pattern list for reads of this checkout's git state — an absolute path into
   it, `git` invoked against the real repository, `process.cwd()` used to locate a record — with the same two control cases the
   guard's other lists carry.
6. **Exit-code assertions read their own call.** Each covered file resets `process.exitCode` immediately before invoking the
   command it asserts about (the shape already used in the repaired file), and each is demonstrated by a mutation that
   reddens the case it guards.
7. **A guard flags a polluted exit-code assertion.** It scans the suite for `expect(process.exitCode …)` whose case has no
   reset between the invocation it names and the assertion, with two control cases, and the scanned suite must be clean.

## 3. Behaviour

```ts
// .pi/agents/kata-reviewer.md — after: host surface + a pointer, no protocol
---
name: kata-reviewer
tools: read, grep, find, ls
extensions: [pi-esuyo-custom-provider]
---
You are the independent reviewer for one kata governed change. **The protocol you follow is the kata-review skill**:
read `.agents/skills/kata-review/SKILL.md` before anything else, and treat the ReviewRequest you were handed as your payload.
This file carries only your tool surface, so that a protocol change lands in one place.
```

```ts
// src/adapters/platforms.ts — the declaration gets a consumer
export function platformAgentPath(platform: Platform, scope: InstallScope, id: string, baseRoot?: string): string | null;
```

## 4. Tests and falsifiers

| AC | Selector | Reversible falsifier |
| --- | --- | --- |
| AC-1 | `tests/unit/agent-definitions-carry-no-protocol.test.ts` | paste a protocol step (`kata-cli ledger answer …`) back into `.pi/agents/kata-reviewer.md`: the guard must flag it; a definition that only points must stay clean |
| AC-2 | `tests/unit/owner-rule-covers-evidence-and-trace.test.ts` | delete the trace whitelist line from the fixture's `.gitignore`: the whitelist case must redden; and with the live-index form restored, staging one `.kata` path must redden it exactly as measured |
| AC-3 | `tests/unit/tests-do-not-read-the-live-task-store.test.ts` | inject a fabricated live-checkout read into the fixture text the guard scans: its control case must flag it |
| AC-4 | `tests/unit/discovery-challenge-binding.test.ts tests/unit/ledger-cli-end-to-end.test.ts tests/unit/sandboxed-retirement.test.ts` | for each file, mutate the guard the assertion is about (e.g. delete the refusal it asserts) and require the case to redden once the reset is in place — where it stayed green before |
| AC-5 | `tests/unit/exit-code-assertions-read-their-own-call.test.ts` | add a fabricated assertion with no reset before its call: the guard must flag it; the clean fixture must not |

Every mutation is applied to a committed tree, restored byte-for-byte with the SHA checked. Final verification runs the full
suite and `tsc --noEmit`.

## 5. Ownership

| Path | Also owned by |
| --- | --- |
| `tests/unit/owner-rule-covers-evidence-and-trace.test.ts` | `task-records-outlive-the-worktree` (hardVerify) |
| `tests/unit/tests-do-not-read-the-live-task-store.test.ts` | `gate-input-integrity` (implement) |
| `tests/unit/discovery-challenge-binding.test.ts` | `harden-ledger-discovery-contract` (plan) |
| `tests/unit/ledger-cli-end-to-end.test.ts` | `harden-ledger-discovery-contract` (plan), `repair-discovery-floor-semantics` (intake) |
| `tests/unit/probe-answer-binding.test.ts` (read only, by the guard) | `harden-ledger-discovery-contract` (plan), `finish-the-retired-answer-semantics` (hardVerify) |
| `.pi/agents/*`, `src/adapters/platforms.ts`, the two new guards, this design | free |

The shared paths are declared with `--allow-ownership-conflicts` and the conflicts are recorded as an audit fact, not resolved
by narrowing the repair.

## 5b. What the build measured, and one limitation stated rather than papered over

**AC-1** — the guard was RED against the unmodified tree (`pi:kata-implementer.md restates the protocol`), and GREEN after both
definitions were thinned. Falsifier: pasting one protocol step (`kata-cli ledger answer …`) back into `.pi/agents/kata-reviewer.md`
reddens it. The guard also asserts the two capability tables agree, and names the platforms that declare sub-agents without an
agent directory.

**AC-2** — the original failure was **reproduced on demand**, not inferred: with every `.kata` path staged (776 paths) the old
live-index form fails exactly as the seal did (`expected 0 to be greater than 0`, both cases), while the fixture-based form is
green in that same condition. Second falsifier: dropping `!.kata/tasks/*/task.json` from the fixture's `.gitignore` reddens the
whitelist case at the assertion that names the trace.

**AC-3** — the scan found a **second instance of the same defect** while being written:
`tests/unit/record-location-statements-follow-the-code.test.ts` hard-coded this checkout's absolute path to read the source. It
is fixed here (resolved from the file's own location) rather than excluded. Falsifier: a fabricated test file containing
`execFileSync('git', …, { cwd: '/data/work/…' })` is flagged at its line; removing it returns the guard to green.

**AC-4** — the property is demonstrated by evidence that fails when the fix is removed, on a **single-site** mutation: deleting
the write-once guard in `answerProbe` reddens `probe-answer-binding.test.ts`'s re-answer case *with* the reset in place, and
leaves all six cases green *without* it, because the assertion then reads the exit code an earlier `decide` left behind. That
pair is the measured instance this class comes from.

**Limitation, stated because it is real.** For the three files this AC names, no *single-site* runtime mutation isolating the
same effect was found: each refusal is a chain of three gates (the claim must name the falsifier, the item must be an
`executable_falsifier`, the bound command must exist), so removing one gate leaves the command refusing for another reason. The
rule is therefore enforced where it can be enforced mechanically — the guard in AC-5 — and the three files' resets are the same
rule applied where no instance had yet been measured, not three measured defects. A reviewer who wants the stronger claim can
attack this: the honest form of the claim is "the shape is now right and the guard holds it", not "three defects were found".

**AC-5** — the guard was RED against the unmodified tree (five assertions with no reset: the waiver case and four in
`probe-answer-binding.test.ts`), and the waiver case was fixed. The other four are **not** offenders: that file routes every
invocation through a `ledger()` helper that resets first, which the checker now reads — the rule is "the value is reset before
the call", not "the reset is written inside the case". Control cases drive the checker with a fabricated case that resets and
one that does not.

**Consequences recorded because they are not obvious.** Correcting pi's `subAgents` declaration to `true` required updating the
two cases that asserted the old one — `tests/golden/adapters.test.ts` (whose title said "without hooks, subagents, or rules") and
`tests/unit/installer.test.ts`'s discovery expectation. Both now assert the corrected fact, and the golden case's title says what
it checks. The change's owned surface therefore grew by five paths beyond the design's first draft: `src/adapters/manifest.ts`
(the second table), `tests/unit/record-location-statements-follow-the-code.test.ts` (the second live-checkout instance),
`tests/golden/adapters.test.ts` and `tests/unit/installer.test.ts` (the corrected declaration), and
`tests/unit/probe-answer-binding.test.ts` (read and edited by the guard's rule).

## 6. Rejected alternatives

- **Render the agent definitions (implement `subAgents` fully).** It would make `update` own the files, but the frontmatter
  carries host configuration (`extensions: [pi-esuyo-custom-provider]`, the tool list), and kata's design says it does not
  choose the host's execution surface. Carrying those fields as manifest data would put a host's registration inside kata's
  manifest — the coupling this project keeps refusing. Pointing at the rendered skill gets the same single source without it.
- **Keep the duplicated prose and add a golden check (guard only).** Cheaper to write, but leaves two sources of truth: every
  protocol change would still have to be made twice, and the guard would only make the second edit *loud*.
- **Retry the live-index case instead of rebuilding it.** A retry around a race hides its own failures and keeps measuring
  another process's timing.
- **Delete the two owner-rule cases.** They assert something real (the whitelist admits traces and no machinery; identity
  excludes everything git admits). The subject was right; the source of the answer was wrong.
- **Read git's committed answer (`git ls-files .kata/`) instead of the index.** Measured: this repository has never committed
  `.kata`, so the case would assert on an empty list and pass for the wrong reason.

## 7. What this change does not do

- It does not fold in `finish-the-retired-answer-semantics`, which is mid-review with a sealed revision and five rounds of
  evidence: merging it would void that evidence to fix unrelated files.
- It does not fix the caller-side three-state class (`wiki/provenance-gate.ts:37`, `quality/change-record.ts:327`,
  `quality/review-ir.ts:273`, `workflow/verdict-binding.ts:106`, `workflow/revision.ts:110` wrap a correct reader in
  `.catch(() => null)`): that is production code with a per-caller decision to make, not a test-measurement defect.
- It does not mechanize "a case's title must be falsifiable". A mechanism that judged titles would need a model call, which
  kata does not hold; the tractable half — the assertion must read the fact its call produced — is AC-4/AC-5.
- It does not sync the copies outside this repository (the global `/data/work/pi/agents/`, other checkouts). Those are host
  configuration and other projects' trees; the change makes them thin and stable, and the sync is an operational step reported
  rather than performed here.
