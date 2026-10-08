# A test must not read the live checkout

**Change:** `a-test-must-not-read-the-live-checkout`
**Status:** approved design
**Scope:** remove the last read of this checkout's live state from the suite, and make the existing guard cover the shape it could not see.

## 1. Problem, measured twice in one session

`tests/unit/owner-rule-covers-evidence-and-trace.test.ts` hard-codes the repository root and asks git about it:

```ts
const repoRoot = '/data/work/ahaeureka/k2skills/kata';
const listed = execFileSync('git', ['add', '-An', '.kata/'], { cwd: repoRoot, encoding: 'utf8' });
```

Two cases do this (`the .gitignore whitelist and the record files agree, measured against git itself`, and `the two tables
that must agree are actually compared`). Both then assert on what the **live index** answers, so both are a function of
whatever else is happening in this checkout. Measured, in this session, twice:

| # | what was happening | what git answered | result |
| --- | --- | --- | --- |
| 1 | another session had staged `.kata` records | `git add -An` prints nothing for already-staged paths | `admitted.length` 0 → the case failed, and the seal that ran it failed with it (`Evidence sealing failed`, 5 checks, 1 failing) |
| 2 | another session's transient lock file (`.kata/tasks/adequacy-task/.transition.lock/holder.json`) was removed between git's directory scan and its `stat` | `fatal: 无法对 …/holder.json 执行 stat: 没有那个文件或目录` | `execFileSync` threw → the case failed inside a full-suite run; the next run passed with nothing changed |

The second one is the worse of the two: it is not even a wrong answer, it is a crash from a race with a file this test does
not own. And because the seal runs `npm test`, **a concurrent session can block any change's seal** — which is how it
presented: a seal that failed for a reason no code in the change could explain.

This is the class the project already named twice (`a-check-that-can-only-pass`, `a-test-that-never-reaches-the-code`) and
already guards once — `tests/unit/tests-do-not-read-the-live-task-store.test.ts` forbids reading the repository's own
**governed store**. That guard covers `process.cwd()`-rooted record reads and hand-written revision records. It does not
cover **asking git about the live checkout**, which is the same defect from the other side: the test reads state that the
seal's snapshot does not carry and that another process can change.

## 2. Decisions

1. **The case builds the repository it measures.** A temp directory, the repository's own `.gitignore` copied into it, the
   fixture `.kata/**` paths written into it, `git init`, then `git add -An .kata/` **in the fixture**. The `.gitignore` is
   the artefact under test and is tracked, so reading it from the workspace is legitimate; what stops being read is the
   live *index*, which is not an artefact but a moment.
2. **The assertions keep their substance.** Machinery (`.kata/worktrees/`, `.kata/runtime/`, `.kata/locks/`,
   `.kata/evidence/`) must not be admitted; traces under `.kata/tasks/` must be; and every path git admits under `.kata/`
   must be excluded from identity (`isIgnoredRepositoryPath`). The fixture has to contain at least one path of each kind,
   or the case would pass on an empty answer — which is exactly how failure 1 hid.
3. **The guard learns the shape.** A new pattern list in `tests-do-not-read-the-live-task-store.test.ts` for live-checkout
   reads — a hard-coded absolute path into this checkout, `git` invoked against the real repository, `process.cwd()` used to
   locate a record — with **control cases** proving its reach: one fabricated instance it must flag, one clean case it must
   not. The guard's own comment says why this matters: a guard that matches nothing proves nothing.
4. **The reproduction stays as the falsifier.** The original failure is reproducible on demand (stage a `.kata` path, then
   run the case), so the repair is accepted only if the new form is green in exactly the condition that made the old one
   red — and the old form red in that condition.

## 3. Behaviour

### 3.1 The fixture repository

```ts
const root = await mkdtemp(join(tmpdir(), 'kata-whitelist-'));
await writeFile(join(root, '.gitignore'), await readFile(new URL('../../.gitignore', import.meta.url), 'utf8'));
await mkdir(join(root, '.kata', 'tasks', 'fixture', 'review'), { recursive: true });
// …one path per kind: a task record, a wiki page, and one of each machinery directory
execFileSync('git', ['init', '-q'], { cwd: root });
const listed = execFileSync('git', ['add', '-An', '.kata/'], { cwd: root, encoding: 'utf8' });
```

Every input is either the tracked `.gitignore` or something the fixture wrote. Nothing else in this checkout can change the
answer, and a file appearing or disappearing elsewhere cannot crash it.

### 3.2 The guard's new pattern list

```ts
const READS_LIVE_CHECKOUT = [
    /\/data\/work\/[^\s'"]*kata/,                 // an absolute path into this checkout
    /exec(?:File)?Sync\(\s*['"]git['"]/,           // git asked about the live repository
    /join\(\s*process\.cwd\(\),\s*['"`]\.kata\//,  // the live store, spelled out
];
```

with the same two control cases the other list carries: a fabricated statement that must be flagged, and a statement that
reads the fixture's own temp root and must not be.

## 4. Tests and falsifiers

| AC | Selector | Reversible falsifier |
| --- | --- | --- |
| AC-1 | `tests/unit/owner-rule-covers-evidence-and-trace.test.ts` | delete the trace whitelist line (`!.kata/tasks/**`) from the fixture's `.gitignore` before `git init`: the whitelist case must redden (no traces admitted), and the two-tables case must redden for the same reason |
| AC-1 (reproduction) | same | restore the live-index form and stage one `.kata` path: the case must redden in exactly the way measured above, which is what makes the repair the cause of the change |
| AC-2 | `tests/unit/tests-do-not-read-the-live-task-store.test.ts` | inject a fabricated live-checkout read (an absolute repo path plus `execFileSync('git', …)`) into the fixture text the guard scans: the control case must flag it; remove it and the guard must be green |

Both mutations are applied to a committed tree, restored byte-for-byte, with the SHA checked, and the final verification
runs the full suite plus `tsc --noEmit`.

## 5. Ownership

| Path | Also owned by |
| --- | --- |
| `tests/unit/owner-rule-covers-evidence-and-trace.test.ts` | `task-records-outlive-the-worktree` (hardVerify) |
| `tests/unit/tests-do-not-read-the-live-task-store.test.ts` | `gate-input-integrity` (implement) |

Both are shared, so the declaration is applied with `--allow-ownership-conflicts` and the conflicts are recorded as an
audit fact. Consequence, stated rather than discovered later: an edit by either of those changes to a shared path makes this
change's revision `superseded`, and the reverse is true too.

## 6. Rejected alternatives

- **Keeping the live read and retrying the case.** A retry loop around a race is a mechanism that hides its own failures:
  the case would still be measuring another process's timing, and the seal would still fail when it lost the race twice.
- **Deleting the two cases.** They assert something real — the whitelist admits traces and no machinery, and identity
  excludes everything git admits — and the repository would lose the only check that ties `.gitignore` to
  `isIgnoredRepositoryPath`. The subject is right; the source of the answer was wrong.
- **Reading git's answer for a *committed* revision instead of the index.** `git ls-files .kata/` answers from the commit,
  which is stable, but it answers "what is tracked **now**" for a checkout that has never committed `.kata` at all (measured:
  `git ls-files .kata` is empty in this repository), so the case would assert on an empty list and pass for the wrong
  reason. A fixture repository is the only form where the answer is both real and owned by the case.
- **Extending the guard to *all* reads of the checkout rather than the state it holds.** Reading `src/` from the repository
  is legitimate and several checks depend on it; the guard's subject is governed state and git's live index, not the source
  tree the snapshot carries.

## 7. What this change does not claim

It does not make the suite hermetic: other cases may still read tracked configuration from the workspace, which the seal's
snapshot carries and which is therefore safe. It does not fix the sibling class where a case's assertions cannot fail for
the property its title names — that is the subject of its own change. And it does not change any production code: the two
files it owns are test files and the guard that reads them.
