# One rule per identifier, and the upstream document keeps its own ids

`task.schema.json` demanded `^REQ-[0-9]+$` for an **upstream requirement id** — an id kata does not mint. A task that
quoted its upstream document honestly (`AC-R1`, `AC-C2`, `GUARD-3`, `PREVALIDATE-6`, `SLICE-S2` — the names the design
document uses) could therefore not be written at all: the record failed validation, and the author renamed every
requirement by hand before the task could be sealed. That is the opposite of what upstream coverage is for — the mapping
is supposed to name the requirement it is about.

## What changed

- **`core/ids.ts` is the one place each identifier's shape is decided**, with the distinction stated: task ids and
  acceptance ids are **minted by kata** and stay strict (`AC-1`, `AC-2`, …); a requirement id is **quoted from an
  upstream document**, so its rule is "an identifier" (`^[A-Za-z0-9][A-Za-z0-9._:-]*$`), not one invented prefix.
- **The schema asset follows the same rule** (it cannot import the constants — kata vendors the schemas into projects),
  and `tests/unit/id-rules-agree-with-schemas.test.ts` asserts the agreement the way the evidence kinds are asserted:
  every schema that polices an acceptance id uses `^AC-[0-9]+$`, the task schema uses the requirement rule, and the old
  invented namespace is gone from the assets.
- **Ids are checked where they are supplied.** `kata open` validates caller-supplied acceptance and requirement ids, so
  an acceptance id that is not kata's numbering, or a requirement id that is not an identifier, fails at the command with
  a message that says where the id belongs — instead of at seal, or when the record is written.
- Requirements supplied **without** an id keep the deterministic `REQ-<n>` fallback (a task-local index, documented as
  such); an id from the document is always better and is now accepted.

## Verification

- `tests/unit/id-rules-agree-with-schemas.test.ts` — the document's real ids are accepted, kata's numbering stays strict,
  and the schemas match the constants.
- `tests/unit/open-with-ids.test.ts` — a task opened with `AC-R1`/`GUARD-3`/`SLICE-S2` records them verbatim; a
  non-kata acceptance id and a non-identifier requirement id are refused at the command.
- Full kata suite: 584 tests in 69 files; `dist/cli.js` rebuilt.
