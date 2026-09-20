## MODIFIED Requirements

### Requirement: Pinned git classification
Kata SHALL NOT decide behaviour by matching git's human-readable output where a structural answer exists. A failure that
depends on repository state (whether a commit exists, whether a ref resolves) SHALL be classified by asking git the
question rather than by parsing the message, and git invoked through `runGit` SHALL run with a pinned locale so parsed
output cannot change with the operator's environment.

#### Scenario: A repository with no commit
- **WHEN** a worktree is created in a repository that has no commit
- **THEN** the command SHALL refuse and SHALL name the remedy, because the classification asks git whether `HEAD`
  resolves rather than matching the failure message

#### Scenario: A healthy repository
- **WHEN** a worktree is created in a repository that has a commit
- **THEN** the worktree SHALL be created, so the structural check does not turn a healthy repository into a refusal

#### Scenario: A failure that is not the no-commit case
- **WHEN** a worktree fails for another reason, such as an unresolvable base or an occupied path
- **THEN** git's own detail SHALL be reported without the no-commit remedy, so the message does not claim a cause that
  did not occur

#### Scenario: Parsed git output under a non-English locale
- **WHEN** git is invoked through `runGit` in an environment whose locale is not English
- **THEN** git SHALL run with `LC_ALL=C`, so output kata parses does not depend on the operator's environment
