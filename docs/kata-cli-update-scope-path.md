# `kata-cli update` scope root

## Root cause

`update` forwarded the caller's default `project` scope directly to the installer. The ownership manifest already records the scope selected by `init`, but the update path did not consult that manifest when the requested scope had no matching installation. As a result, a globally initialized installation could be recreated under the project root.

## Fix

Before writing, a default project-scope `update` keeps the project scope when it owns the platform and otherwise follows the global ownership manifest. An explicitly requested global scope remains authoritative, and a missing installation still uses the requested scope, preserving normal first-install behavior.

## Verification

The regression test initializes a global installation, invokes update with the project default, and asserts that only the global root receives the managed file.
