## ADDED Requirements

### Requirement: Cross-platform compatibility fixtures
The project SHALL test that each supported adapter installs the same command manifest, task schema, and guard contract.

#### Scenario: Adapter manifest comparison
- **WHEN** Codex, Claude Code, and OpenCode fixtures are generated
- **THEN** their normalized command and protocol manifests SHALL be equivalent

### Requirement: Workflow evaluation
The evaluation harness SHALL measure task pass rate, acceptance pass rate, repair count, escalation rate, token/cost usage, latency, and Wiki rejection rate using repeatable task fixtures.

#### Scenario: Cost regression
- **WHEN** a workflow revision increases cost beyond its configured threshold without improving acceptance pass rate
- **THEN** the release evaluation SHALL fail or mark the revision for review

### Requirement: Release safety
Release SHALL require passing core state-machine tests, Wiki governance tests, installer/update/uninstall tests, adapter fixtures, and representative end-to-end workflow evaluations.

#### Scenario: Update would overwrite user files
- **WHEN** the release test detects an unconfirmed overwrite path
- **THEN** the release gate SHALL fail
