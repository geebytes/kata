# A reviewer subagent must reach the routed provider, and stay read-only

Status: implemented, measured on this host
Date: 2026-10-04
Related: `2026-10-03-all-phase-ledger-repair-admission.md`, `2026-09-18-what-an-adversarial-pass-costs.md`

## What broke

Every independent review round dispatched through the `kata-reviewer` agent failed before it
started. Three different errors appeared, and they looked like three problems:

| Attempt | Error |
| --- | --- |
| original definition (`isolated: true`) | `400 MissingSessionID` from the upstream |
| after dropping `isolated` | `400 {"model":"deepseek-v4.1-flash"}` |
| after re-adding `extensions: false` | `400 MissingSessionID` again |
| `kata-cli` main process, any of the above | works |

## Root cause

Two independent constraints were being asked of one field.

1. **The routed model provider is registered by an extension.** `custom-providers.json` is read by
   `@esuyo/pi-esuyo-custom-provider`'s factory, which calls `pi.registerProvider(...)`. Nothing in
   the kernel knows about `litellm-go`; if that extension does not run for a session, the session
   cannot resolve the provider, its requests leave for the upstream directly, and the upstream
   refuses them (`MissingSessionID` — the `x-opencode-session` header is injected only for a
   provider resolved through the router).

2. **`isolated: true` suppresses exactly that.** In `@tintinweb/pi-subagents`
   (`src/agent-runner.ts`), `isolated` overrides `extensions` to `false`. So the field that reads
   as "make this agent safe" is also the field that cuts off the provider registration the round
   needs to reach the model at all.

The third error came from the honest fix for (1)–(2): running with extensions *enabled* but no
tool scoping injects **every** extension tool into the child session. Measured through a local
echo provider: `tools: 53`. The upstream rejects that request body, which is why a full tool set
fails while a small one succeeds.

## The fix

`kata-reviewer.md` now declares both halves explicitly:

```yaml
tools: read, grep, find, ls
extensions: [pi-esuyo-custom-provider]
```

- `extensions: [<name>]` is a loader-level **allowlist**: only that extension is loaded, so the
  provider is registered. It is not "load everything".
- The extension that registers the provider registers **no tools** — it has no `registerTool` call —
  so loading it costs no tool surface.
- Tool surface is governed separately, by the `tools:` list. A bare `read, grep, find, ls` with no
  `ext:` selector means extension tools are never injected.

Read-only is therefore a property of the tool allowlist, not of process isolation.

### Measured

Through a local echo server that logged each request body:

| Configuration | provider reached | `tools` count | round outcome |
| --- | --- | --- | --- |
| default (all extensions) | yes | 53 | upstream refuses |
| `extensions: false` | **no** | 4 | `MissingSessionID` |
| `isolated: true` | **no** | — | `MissingSessionID` |
| `extensions: [pi-esuyo-custom-provider]` | **yes** | **4** | **round completed** |

The last row is a real round, not a probe: 424.7 s, 63 tool calls, 225.5 k tokens, a full
per-claim verdict set with the reviewer's own negative results.

## What this costs, stated honestly

- The reviewer loads one extension. It is no longer extension-free. Independence rests on the
  **read-only tool surface** and on a cold context, not on a separate extension environment; a
  round that needs the latter must say so in its record rather than assume it.
- A host that routes through a different provider extension must add that extension's name to the
  allowlist, or the same `MissingSessionID` returns.

## What was rejected, and why

- **`isolated: true`** — cuts the provider registration (measured above).
- **`extensions: false`** — same cut, one level down.
- **`extensions: true` / omit the field** — provider reachable, but 53 tools reach the upstream and
  the request is refused.
- **Fixing it in `pi-subagents`** (inherit the parent's provider table into the child session) —
  addresses the class properly but is a vendored dependency; the three-field combination above is
  available now and is measured.

## The diagnostic trap, recorded

Each error looked like an independent fault — a session-id bug, then a model-name bug, then a
tool-count bug — and two of my explanations were wrong before measurement:

- "the model name is wrong" — a local echo capture showed the child sending
  `deepseek-v4.1-flash-go`, exactly right.
- "an extension is half-registering and corrupting the body" — plausible from the error shapes, and
  falsified once the tool count was visible.

Both were settled only by logging the request body at the boundary. Reading the source produced a
hypothesis each time; only the boundary measurement decided.
