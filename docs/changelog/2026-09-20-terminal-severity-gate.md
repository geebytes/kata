# The severity gate is one rule, and two sites stopped guessing at it

Two disagreements inside the same gate, both surfaced by reviewing a change whose claim was that the terminal-severity
rule now decides every severity decision.

**The approval guard refused a `major` finding unconditionally.** The gate is *"blocking, and major in strict"*
(`docs/design/2026-09-18-what-an-adversarial-pass-costs.md`), and the navigation ladder gates the major-to-repair branch
on `reviewMode === 'strict'`. In std — the default — a task carrying one major review finding could be neither approved
nor routed to the repair that would clear it: the ladder said `/kata-review` while the approval error said to resolve the
finding. The guard now reads the mode.

**The first fix went the wrong way, and that is the useful part.** I widened the ladder to match the guard, which made std
behave like strict and contradicted the stated invariant. The existing test
`standard review mode does not route major findings to Build` failed, and the design doc settled which side was
authoritative. Two sites disagreeing does not tell you which is wrong.

Also in this round: `adversarial record` opened a repair batch but created no obligation for the terminal finding in the
verdict, so that finding had nothing that could ever answer it — the same gap the `finding add` path had, on the path a
verdict actually takes.

Suite: 913 passed, 0 failed.
