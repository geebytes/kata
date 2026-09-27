# Retire the round-shaped route

## Why

The repository certifies a change through a persisting evidence ledger now: a subject frozen by content digest, claims,
evidence with verdicts, a pure decision function, and gates that read all of it. The mechanism it replaced — one review
*round* producing one document, judged by a citation guard, an admissibility conjunction and a findings table — is deleted:
fourteen source modules, six schemas, two generated skills, the CLI commands that drove them and forty-three fixtures.

The specification was not deleted with them. Five live requirements still describe the route: a findings-reporting
command that exits 1 with "unknown command", a repair obligation store nothing writes, a repair batch nothing opens, and
a severity rule the approval no longer applies. This is the defect this repository removes most often — a declaration that
outlives what it declares — and here the declaration is the durable cross-session contract, so a reader who trusts the
spec would look for mechanisms that do not exist.

## What changes

- **`Adversarial pass reporting surface` is removed.** Its only scenario names `kata-cli adversarial finding add`, a
  command deleted with the route.
- **`Bounded repair loop` is rewritten.** Repair still exists and still returns to hard verification; what a repair owes is
  now expressed as the claim it must support, not as an obligation or a batch.
- **Three requirements are added**, describing what actually decides a review: the evidence-decided route, the
  deterministic kernel and its platform boundary, and the two ways a change may leave the archive gate with known problems.

## Impact

- `openspec/specs/model-policy-and-evidence/spec.md` — one requirement removed, one rewritten, three added.
- No production code changes: every requirement here describes behaviour the landed code already has, and each scenario is
  answerable by naming the file and case that holds it.
