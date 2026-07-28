# Harden local multi-agent workflow integrity

## Background

Multiple coding agents can operate in one checkout, but a nested Git repository can
make workspace-root discovery select a different `.kata` directory. Handoff receipts
are advisory, and state changes are not serialized across processes.

## Decision

Workflow mutation will be fail-closed: commands require an explicit canonical
workspace identity and a receipt anchored to the current task/revision. A task-level
cross-process lock protects state changes. Result envelopes report the exact runtime
identity and state snapshot consumed by the command.

## Non-goals

This change does not add remote synchronization or host-model routing. It protects
agents sharing one filesystem workspace.
