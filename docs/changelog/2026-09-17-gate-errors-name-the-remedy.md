# Gate errors name the remedy, and an unrelated record stops blocking the workflow

Three gate failures today each left the remedy to be recovered from the bundle — the pattern that cost the most, because
the answer was known to the code that refused.

## What changed

- **Wiki closure**: `wikiClosureRemedy(reason, taskId)` names the command for every way a closure can be incomplete, and
  the verify-node messages (`Implementation verification passed; the Wiki closure is incomplete (…)`) carry it. Before:
  `complete Wiki closure (candidate_required) before review/judge`, with the actual command (`kata-cli wiki closure
  --task <id> --decision captured --candidate <registered-id> --reason "<why>"`) nowhere.
- **Artefact validation**: every `readValidated` failure now appends the schema's accepted top-level fields
  (`Allowed fields: …`). A field-name error without the allowed set sends the reader to the schema to find what the error
  already knew.
- **The closure no longer reads the whole Wiki as a gate.** `readWikiRecords` throws on the first invalid file, and the
  closure read every record — so one drifted legacy record (a field the schema does not allow) blocked **every** workflow
  mutation in the project, not just the task that owned it. `readWikiRecordsTolerant` returns the invalid ones instead,
  the closure treats them as *not candidates*, and fails closed with `unevaluatable_records` only when a record the
  closure **names** cannot be read.
- **Re-seal**: a superseded seal already authorises `build --seal` from `hardVerify` (the previous commit), and the
  refusal that remains names `kata-cli verify --change <task>` as the one thing to run.

## Verification

- `tests/unit/wiki-closure.test.ts` — the remedy names its command for each reason; an unrelated invalid record leaves a
  valid closure valid; a candidate that cannot be read fails closed with `unevaluatable_records`.
- `tests/unit/schema-validation.test.ts` — a rejected field's error lists the accepted fields.
- Full kata suite: 577 tests in 67 files; `dist/cli.js` rebuilt.
