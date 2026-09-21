## MODIFIED Requirements

### Requirement: Bounded repair loop
The runtime SHALL permit repair only for failed acceptance conditions and SHALL return every repair to hard verification before another Judge decision.

A repair obligation SHALL be answerable by the revision's evidence, and a seal SHALL NOT refuse an obligation that the run being refused would itself answer. The seal and the resolver SHALL decide answerability by the same rule, and the seal SHALL deny only obligations that would remain unresolved once the run's evidence exists.

#### Scenario: Repair changes unrelated files
- **WHEN** a repair diff exceeds its failed scope or configured file/diff budget
- **THEN** the runtime SHALL block the loop and require a new planning decision

#### Scenario: A task with no acceptance matrix carries an unresolved obligation
- **WHEN** a seal runs on a task that declared no acceptance matrix and whose obligation this run's checks can answer
- **THEN** the seal SHALL run the checks, resolve the obligation from the evidence they produce, and seal

#### Scenario: An obligation the current run cannot answer
- **WHEN** a seal runs on a task carrying an obligation that this run's evidence would not answer
- **THEN** the seal SHALL refuse, name the criterion, and state that supplying evidence or an acceptance matrix is the remedy

#### Scenario: The seal and the resolver disagree about one obligation
- **WHEN** an obligation's answerability is computed for the preflight and for resolution
- **THEN** both SHALL consult one rule, so a seal can never pass while leaving the obligation unresolved

#### Scenario: A planned check the run will defer
- **WHEN** the plan contains a check the run will not execute, such as a frozen-tier check without the flag that includes it
- **THEN** the dry run SHALL NOT count it as evidence the run will produce, because a deferred check produces none

#### Scenario: A batch closes with answered findings
- **WHEN** a repair batch closes and names findings as answered
- **THEN** each answered finding SHALL be marked fixed, so the round framing stops reporting it as unrepaired, and a
  failure to record that SHALL be reported rather than swallowed
