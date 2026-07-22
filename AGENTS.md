<!-- STRATA:BEGIN -->
# Kata Agent Contract

Before non-trivial work in this project:

1. Run `kata orient --change <id> --role <role> --task-kind <kind>`.
2. Read AGENTS.md plus the returned `.llmwiki/SCHEMA.md`, `.llmwiki/index.md`, and `.llmwiki/log.md` entries when present.
3. Use the matching `/kata-*` skill and follow its startup checklist.
4. Kata 不配置、不路由也不记录宿主平台模型。若需切换，请直接使用宿主平台自己的模型选择器或配置后继续。
5. Do not treat Wiki as proof of code correctness: CI, tests, Reviewer, and Judge own correctness.

## Development constraint: skill-first

For Kata development and dogfooding, the `/kata-*` skill is the human-facing workflow entrypoint. The `kata ...` CLI is the deterministic execution layer used inside skills and scripts.

- Prefer short skill invocations such as `/kata-build <intent>`, `/kata-review`, `/kata-collect`, or `继续`.
- A skill must first discover the active/same-branch task with `kata status`, follow relation redirects, and read `nextAction`.
- Do not ask the user to provide CLI flags such as `--change`, `--role`, or `--task-kind` unless discovery leaves multiple plausible choices.
- At `review_gate` and `judge_gate`, stop so the user can use the host platform's own model selector before continuing. At `archive_gate`, stop for the user's archive decision.
- Use CLI commands directly only for non-interactive automation, tests, CI, or when the host platform cannot execute slash-command skills.

Protected Kata paths and phase gates are enforced by the CLI.

<!-- STRATA:END -->

<comet-ambient-resume>
<!-- Managed by Comet. Edits inside this block may be replaced by comet init/update. -->

## Comet Ambient Resume

In this repository, before starting work that may need code changes or investigation, run the Comet resume probe (read-only) if a Comet workflow may already be active.

- If the probe returns `auto_resume`, briefly state the selected active change and continue through its `nextCommand`.
- If the probe returns `ask_user`, ask one short question and wait.
- If the probe returns `out_of_scope` or `none`, do not enter the Comet workflow.
- Never attach unrelated work to an active Comet change only because `.comet.yaml` exists.
</comet-ambient-resume>
