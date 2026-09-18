# The lifecycle prompts are a catalogue with a language

L2-08: the rest of the product carries a configured language (`language: 'en' | 'zh'` in the installer and the skill
rendering), but the workflow surface hardcoded text — `statusActionPrompts` held fifteen Chinese strings, the
trust-boundary instructions held three Chinese ones **and one English one** ("Stop after Judge. Ask the user whether to
archive now…"), and the delegation prompt mixed both. A user who configured English still got Chinese from `status`, and
one function emitted both languages for the same kind of message.

## What changed

- **`src/workflow/prompt-catalogue.ts`** holds the prompts as data: one entry per reason (and per trust boundary), each
  with both languages, plus the generic fallbacks and `promptLanguage()` (explicit argument, else `KATA_LANGUAGE`, else
  Chinese — the previous default).
- `navigation.ts` renders through it: `statusActionPrompts(suggestion, language)` and
  `pauseInstructionForBoundary` → `boundaryPromptFor(boundary, language)`. The English-only archive instruction now has a
  Chinese counterpart instead of being the odd one out.
- Adding a language is adding a column; adding a reason forces a decision because the catalogue is typed against the
  reason vocabulary.

## Verification

- `tests/unit/workflow-navigation.test.ts` — a rendered prompt contains one language of prose (commands and vocabulary
  tokens like `RED`/`--seal` are identifiers and stay), every reason renders in the requested language, and no boundary
  instruction is left English-only.
- Full kata suite: 623 tests in 76 files; `tsc` clean; `dist/cli.js` rebuilt.
