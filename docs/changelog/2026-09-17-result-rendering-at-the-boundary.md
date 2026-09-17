# Result rendering belongs to the boundary, not to a result sniff

L0-01's handler extraction needs a printer a handler module can import without importing the entry point that routes to
it. The printer that existed sniffed the result object instead:

```ts
if (output.format === 'human' && isUpdateResult(result)) { output.stdout.write(renderUpdateSummary(result)); return; }
output.stdout.write(JSON.stringify(result) + '\n');
```

`isUpdateResult` recognised `{ command: 'update' }` and any object carrying `platform` + `written` + `unchanged`, so the
generic *boundary* knew one command's field names — it would have had to change whenever that command's result did.

## What changed

`src/cli/output.ts` now owns result rendering and progress text (`outputResult`, `writeProgress`), and the human shape is
supplied by the caller that knows it: `outputResult(result, { human: renderUpdateSummary })`. The update family passes it
at both of its print sites (the aggregate run and the per-platform run); every other command keeps the JSON printer.
`isUpdateResult` is gone — nothing sniffs results any more. `cli.ts` no longer defines `outputResult` or a progress
writer; its 24 call sites import the boundary's.

This is the same boundary L0-03 established (an invocation-local output context) extended to the *result* half of it, and
it is what makes the handler moves mechanical.

## Verification

- `tsc --noEmit` clean; the full kata suite passes (565 tests in 67 files).
- The installer suite's rendering test is the evidence the behaviour is unchanged: by default the update summary reaches
  `stdout` (the "完成" / "变更：写入" / "运行时：Comet 更新" lines), `--quiet` writes nothing, and `--json` emits the object.
  It failed the moment the human renderer was passed at only one of the two print sites, which is exactly the coverage a
  boundary change needs.
- `dist/cli.js` rebuilt.
