# One place for the environment variables, and a test that keeps it honest

Five variables decide behaviour a user may need to change — how many checks a seal runs at once, how long a CodeGraph
rebuild may take, how long a git operation may take, how long the runtime refresh may take, and what language the prompts
are written in. Four of them were discoverable **only by reading changelogs**: each was added for a real problem and
documented in the entry that introduced it, which is not where a reader looks.

## What changed

- `docs/operations.md` gains an **Environment variables** section: one row per variable, with its default and the thing it
  actually changes.
- `tests/unit/environment-variables-are-documented.test.ts` reads the **source** for every `KATA_*` it consumes and requires
  the section to match it in both directions: a variable the code reads must have a row, and a row must be a variable the
  code reads. The reference therefore cannot outlive the code, and a new variable cannot exist undocumented.

## Why the test and not just the section

The same rule as the generated assets, the schema kinds and the guard instructions: a document written by hand beside code
written by hand drifts, and the fix is not care but a check. Here the check is cheap because the source of truth is
mechanically findable.

## Verification

Full kata suite: 741 tests in 89 files; `tsc` clean; `dist/cli.js` rebuilt.
