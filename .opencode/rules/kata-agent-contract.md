# Kata Agent Contract

Wiki helps agents avoid project-context mistakes; CI, tests, Reviewer, and Judge prevent code-correctness mistakes.

Before non-trivial work:

1. Run `kata orient --change <id> --role <role> --task-kind <kind>`.
2. Read returned AGENTS, .llmwiki, model-route, and guard instructions before editing.
3. Use the matching /kata-* skill or its platform command bridge.
4. Capture durable project knowledge into .llmwiki, but never treat Wiki as proof that code is correct.
5. Let tests, CI, reviewer findings, judge results, and phase gates decide correctness.

## Development constraint: skill-first

The /kata-* skill or platform command bridge is the human-facing workflow entrypoint. The kata CLI is the deterministic execution layer used inside skills and scripts.

- Prefer short skill invocations such as /kata-build <intent>, /kata-review, /kata-collect, or 继续.
- A skill must first discover the active/same-branch task with kata status, follow relation redirects, and read nextAction.
- Do not ask the user to provide CLI flags such as --change, --role, or --task-kind unless discovery leaves multiple plausible choices.
- At review_gate and judge_gate, stop, show the recommendation, and wait for the user to switch the host-platform model and resume. Do not claim a switch or write a route before confirmation. At archive_gate, stop for the user's archive decision.
- Use CLI commands directly only for non-interactive automation, tests, CI, or when the host platform cannot execute slash-command skills.

