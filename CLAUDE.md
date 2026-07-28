<comet-ambient-resume>
<!-- Managed by Comet. Edits inside this block may be replaced by comet init/update. -->

## Comet Ambient Resume

In this repository, before starting work that may need code changes or investigation, run the Comet resume probe (read-only) if a Comet workflow may already be active.

- If the probe returns `auto_resume`, briefly state the selected active change and continue through its `nextCommand`.
- If the probe returns `ask_user`, ask one short question and wait.
- If the probe returns `out_of_scope` or `none`, do not enter the Comet workflow.
- Never attach unrelated work to an active Comet change only because `.comet.yaml` exists.
</comet-ambient-resume>
