# Four rules the check transcript's promise turned out to rest on

The change that made `logArtifact` honest about a missing file (`2026-09-20-log-artifact-claimed-must-exist.md`, landing
as `check-log-artifact-missing`) was reviewed adversarially, and the review found three more ways the field could lie.
All four are the same property — *when `logArtifact` is present, the file exists and holds the whole output of that run* —
and each was a separate defect.

| defect | measured | now |
|---|---|---|
| the write directory was created **after** the checks | a first seal's artifact was absent | `orchestrator.ts` creates it before collecting |
| the artifact was opened with `appendFile` and named without a revision | collecting one check twice gave 50 000 bytes and 10 000 marker lines where one run prints 5 000 | the run opens the file once, truncating, and appends thereafter |
| `writeEvidence` archived only `*.json` | a superseded revision's `.log` stayed at the active path, the same name the next seal writes | `.log` files move into `superseded/<revision>/` with the envelopes |
| the name fell back to the raw command | an id-less check produced `<logDir>/<task>-/usr/bin/node.log` and an ENOENT that read like a missing directory | a separators-free slug, and the path is checked to exist before it is stamped — for imported results too |

The third and fourth were found because the review attacked the **claim** rather than the diff: the change's own docs
said the artifact "holds the complete output", so the question was what could make that false. The append was the sharp
one — pre-existing, but the change is what started advertising the field as trustworthy, which is the difference between
a latent defect and a reported one.

Two things about that review are worth recording as process, not as outcome:

- The review pass reported its findings through `kata-cli adversarial finding add` and the review node **refused
  approval** on the `major` one, opening a repair batch — `kata-cli review --approve` answered "The independent
  adversarial pass confirmed 1 defect(s) at blocking or major severity". The gate worked; no manual bookkeeping was
  needed to make it.
- One finding was recorded as `nit` and **not** repaired on the grounds of being unreachable, then repaired anyway once
  the other three were in the same code: `planCheckReuse` forwards only `exitCode`/`log`/`environment`, so an imported
  `logArtifact` never reaches production — but the contract is stated on the field, and the guard now covers both paths.

Suite: 891 passed, 0 failed.
