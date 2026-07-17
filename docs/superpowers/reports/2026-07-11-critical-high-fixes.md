# 2026-07-11 CRITICAL/HIGH audit fixes

This note records the CRITICAL/HIGH remediation pass before continuing Kata Wiki and release-flow implementation.

## Fixed

- Centralized task id validation before `.kata/tasks/<id>` and evidence path construction.
- Bound distill/archive eligibility to fresh hard evidence, reviewer clearance, and Judge PASS for the same current `diffHash`.
- Added Judge `diffHash` to persisted Judge results and upgraded tests/fixtures to the stricter evidence chain.
- Aligned Wiki write permissions with the actual `.kata/wiki/...` layout.
- Persisted Wiki approval and rejection events on promoted/rejected records.
- Treated sourced Wiki records without source hashes as stale, and archived implementation summaries with concrete source hashes.
- Restored workflow CLI parsing for `--change <id>` and updated generated skill command manifests.

## Verification

- `node node_modules/typescript/lib/tsc.js --noEmit`
- `node node_modules/vitest/dist/cli.js run`
