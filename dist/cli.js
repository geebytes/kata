#!/usr/bin/env node
var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res) => function __init() {
  return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// kata-asset:/app/kata/schemas/task.schema.json
var task_schema_default;
var init_task_schema = __esm({
  "kata-asset:/app/kata/schemas/task.schema.json"() {
    task_schema_default = '{\n  "$schema": "https://json-schema.org/draft/2020-12/schema",\n  "$id": "https://kata.dev/schemas/task.schema.json",\n  "title": "Kata Task",\n  "type": "object",\n  "required": ["id", "title", "phase", "acceptance", "createdAt", "updatedAt"],\n  "additionalProperties": false,\n  "properties": {\n    "id": { "type": "string", "pattern": "^[a-zA-Z0-9][a-zA-Z0-9._-]*$" },\n    "title": { "type": "string", "minLength": 1 },\n    "phase": {\n      "type": "string",\n      "enum": ["intake", "plan", "implement", "hardVerify", "review", "judge", "distill", "archive"]\n    },\n    "acceptance": {\n      "type": "array",\n      "minItems": 1,\n      "items": {\n        "type": "object",\n        "required": ["statement"],\n        "additionalProperties": false,\n        "properties": {\n          "id": { "type": "string", "pattern": "^AC-[0-9]+$" },\n          "statement": { "type": "string", "minLength": 1 }\n        }\n      }\n    },\n    "relations": {\n      "type": "array",\n      "items": {\n        "type": "object",\n        "required": ["type", "targetTaskId", "createdAt"],\n        "additionalProperties": false,\n        "properties": {\n          "type": {\n            "type": "string",\n            "enum": ["superseded_by", "covered_by", "duplicate_of", "merged_into", "parent_of", "spawned_from", "related_to"]\n          },\n          "targetTaskId": { "type": "string", "pattern": "^[a-zA-Z0-9][a-zA-Z0-9._-]*$" },\n          "reason": { "type": "string", "minLength": 1 },\n          "createdAt": { "type": "string", "minLength": 1 },\n          "createdBy": { "type": "string", "minLength": 1 }\n        }\n      }\n    },\n    "createdAt": { "type": "string", "minLength": 1 },\n    "updatedAt": { "type": "string", "minLength": 1 },\n    "workflowProfile": {\n      "type": "object",\n      "required": ["version", "isolationMode", "developmentMode", "reviewMode", "comet"],\n      "properties": {\n        "version": { "const": 1 },\n        "isolationMode": { "enum": ["current_worktree", "isolated_worktree", "git_flow", "user_decides"] },\n        "developmentMode": { "enum": ["tdd", "standard"] },\n        "reviewMode": { "enum": ["std", "strict", "security"] },\n        "gitFlow": {\n          "type": "object",\n          "required": ["strategy", "branch", "baseBranch", "status"],\n          "properties": {\n            "strategy": { "enum": ["git-flow", "manual"] },\n            "branch": { "type": "string" },\n            "baseBranch": { "type": "string" },\n            "status": { "enum": ["active", "pending_confirmation", "failed"] },\n            "installation": {\n              "type": "object",\n              "required": ["status"],\n              "properties": {\n                "status": { "enum": ["installed", "failed", "unsupported"] },\n                "command": {\n                  "type": "array",\n                  "items": { "type": "string" }\n                },\n                "manualCommand": { "type": "string" }\n              },\n              "additionalProperties": false\n            }\n          },\n          "additionalProperties": false\n        },\n        "comet": {\n          "type": "object",\n          "required": ["projectInit", "openStatus"],\n          "properties": {\n            "projectInit": { "enum": ["not_requested", "initialized", "skipped", "failed"] },\n            "openStatus": { "enum": ["required", "acknowledged"] }\n          },\n          "additionalProperties": false\n        },\n        "strictClosure": { "type": "boolean" }\n      },\n      "additionalProperties": false\n    },\n    "ownedPaths": {\n      "type": "array",\n      "minItems": 1,\n      "uniqueItems": true,\n      "items": { "type": "string", "minLength": 1 }\n    },\n    "acceptanceMatrix": {\n      "type": "object",\n      "required": ["version", "rows"],\n      "additionalProperties": false,\n      "properties": {\n        "version": { "type": "integer", "minimum": 1 },\n        "rows": {\n          "type": "array",\n          "minItems": 1,\n          "items": {\n            "type": "object",\n            "required": ["acceptanceId", "implementationPaths", "testPaths", "evidence", "verificationLevel"],\n            "additionalProperties": false,\n            "properties": {\n              "acceptanceId": { "type": "string", "pattern": "^AC-[0-9]+$" },\n              "designRefs": {\n                "type": "array",\n                "items": { "type": "string", "minLength": 1 }\n              },\n              "implementationPaths": {\n                "type": "array",\n                "minItems": 1,\n                "items": { "type": "string", "minLength": 1 }\n              },\n              "testPaths": {\n                "type": "array",\n                "minItems": 1,\n                "items": { "type": "string", "minLength": 1 }\n              },\n              "evidence": {\n                "type": "array",\n                "minItems": 1,\n                "items": {\n                  "type": "object",\n                  "required": ["kind", "command"],\n                  "additionalProperties": false,\n                  "properties": {\n                    "kind": {\n                      "type": "string",\n                      "enum": ["test", "lint", "typecheck", "integration", "entrypoint"]\n                    },\n                    "command": { "type": "string", "minLength": 1 },\n                    "testSelector": { "type": "string", "minLength": 1 }\n                  }\n                }\n              },\n              "verificationLevel": {\n                "type": "string",\n                "enum": ["unit", "integration", "entrypoint"]\n              }\n            }\n          }\n        }\n      }\n    }\n  }\n}\n';
  }
});

// kata-asset:/app/kata/schemas/workflow-state-record.schema.json
var workflow_state_record_schema_default;
var init_workflow_state_record_schema = __esm({
  "kata-asset:/app/kata/schemas/workflow-state-record.schema.json"() {
    workflow_state_record_schema_default = '{\n  "$schema": "https://json-schema.org/draft/2020-12/schema",\n  "$id": "https://kata.dev/schemas/workflow-state-record.schema.json",\n  "title": "Kata Workflow State Record",\n  "type": "object",\n  "required": ["taskId", "phase", "actor", "updatedAt"],\n  "additionalProperties": false,\n  "properties": {\n    "taskId": { "type": "string", "minLength": 1 },\n    "phase": {\n      "type": "string",\n      "enum": ["intake", "plan", "implement", "hardVerify", "review", "judge", "distill", "archive"]\n    },\n    "actor": {\n      "type": "object",\n      "required": ["id", "role"],\n      "additionalProperties": false,\n      "properties": {\n        "id": { "type": "string", "minLength": 1 },\n        "role": { "type": "string", "minLength": 1 }\n      }\n    },\n    "activeSession": { "type": "string", "minLength": 1 },\n    "updatedAt": { "type": "string", "minLength": 1 }\n  }\n}\n';
  }
});

// kata-asset:/app/kata/schemas/workflow-state-event.schema.json
var workflow_state_event_schema_default;
var init_workflow_state_event_schema = __esm({
  "kata-asset:/app/kata/schemas/workflow-state-event.schema.json"() {
    workflow_state_event_schema_default = '{\n  "$schema": "https://json-schema.org/draft/2020-12/schema",\n  "$id": "https://kata.dev/schemas/workflow-state-event.schema.json",\n  "title": "Kata Workflow State Event",\n  "type": "object",\n  "required": ["taskId", "from", "to", "actor", "at"],\n  "additionalProperties": false,\n  "properties": {\n    "taskId": { "type": "string", "minLength": 1 },\n    "from": {\n      "enum": [null, "intake", "plan", "implement", "hardVerify", "review", "judge", "distill", "archive"]\n    },\n    "to": {\n      "type": "string",\n      "enum": ["intake", "plan", "implement", "hardVerify", "review", "judge", "distill", "archive"]\n    },\n    "actor": {\n      "type": "object",\n      "required": ["id", "role"],\n      "additionalProperties": false,\n      "properties": {\n        "id": { "type": "string", "minLength": 1 },\n        "role": { "type": "string", "minLength": 1 }\n      }\n    },\n    "activeSession": { "type": "string", "minLength": 1 },\n    "at": { "type": "string", "minLength": 1 }\n  }\n}\n';
  }
});

// kata-asset:/app/kata/schemas/evidence.schema.json
var evidence_schema_default;
var init_evidence_schema = __esm({
  "kata-asset:/app/kata/schemas/evidence.schema.json"() {
    evidence_schema_default = '{\n  "$schema": "https://json-schema.org/draft/2020-12/schema",\n  "$id": "https://kata.dev/schemas/evidence.schema.json",\n  "title": "Kata Evidence Envelope",\n  "type": "object",\n  "required": ["id", "taskId", "kind", "command", "exitCode", "startedAt", "finishedAt", "diffHash"],\n  "additionalProperties": false,\n  "properties": {\n    "id": { "type": "string", "minLength": 1 },\n    "taskId": { "type": "string", "minLength": 1 },\n    "name": { "type": "string", "minLength": 1, "pattern": "^[A-Za-z0-9_.-]+$" },\n    "kind": {\n      "type": "string",\n      "enum": ["lint", "typecheck", "test", "ci", "review", "judge", "security"]\n    },\n    "command": { "type": "string", "minLength": 1 },\n    "environment": { "type": "string" },\n    "exitCode": { "type": "integer", "minimum": 0 },\n    "startedAt": { "type": "string", "minLength": 1 },\n    "finishedAt": { "type": "string", "minLength": 1 },\n    "diffHash": { "type": "string", "pattern": "^[a-fA-F0-9]{64}$" },\n    "revisionId": { "type": "string", "minLength": 1 },\n    "scope": {\n      "type": "object",\n      "required": ["paths", "hash"],\n      "additionalProperties": false,\n      "properties": {\n        "paths": { "type": "array", "minItems": 1, "items": { "type": "string", "minLength": 1 } },\n        "hash": { "type": "string", "pattern": "^[a-fA-F0-9]{64}$" }\n      }\n    },\n    "log": { "type": "string" }\n  }\n}\n';
  }
});

// kata-asset:/app/kata/schemas/review-finding.schema.json
var review_finding_schema_default;
var init_review_finding_schema = __esm({
  "kata-asset:/app/kata/schemas/review-finding.schema.json"() {
    review_finding_schema_default = '{\n  "$schema": "https://json-schema.org/draft/2020-12/schema",\n  "$id": "https://kata.dev/schemas/review-finding.schema.json",\n  "title": "Kata Review Finding",\n  "type": "object",\n  "required": ["id", "taskId", "severity", "message"],\n  "additionalProperties": false,\n  "properties": {\n    "id": { "type": "string", "minLength": 1 },\n    "taskId": { "type": "string", "minLength": 1 },\n    "acceptanceId": { "type": "string", "pattern": "^AC-[0-9]+$" },\n    "severity": { "type": "string", "enum": ["blocking", "major", "minor", "note"] },\n    "message": { "type": "string", "minLength": 1 },\n    "path": { "type": "string", "minLength": 1 }\n  }\n}\n';
  }
});

// kata-asset:/app/kata/schemas/judge-result.schema.json
var judge_result_schema_default;
var init_judge_result_schema = __esm({
  "kata-asset:/app/kata/schemas/judge-result.schema.json"() {
    judge_result_schema_default = '{\n  "$schema": "https://json-schema.org/draft/2020-12/schema",\n  "$id": "https://kata.dev/schemas/judge-result.schema.json",\n  "title": "Kata Judge Result",\n  "type": "object",\n  "required": ["taskId", "result", "acceptance"],\n  "additionalProperties": false,\n  "properties": {\n    "taskId": { "type": "string", "minLength": 1 },\n    "result": { "type": "string", "enum": ["PASS", "FAIL"] },\n    "diffHash": { "type": "string", "pattern": "^[a-fA-F0-9]{64}$" },\n    "revisionId": { "type": "string", "minLength": 1 },\n    "acceptance": {\n      "type": "array",\n      "minItems": 1,\n      "items": {\n        "type": "object",\n        "required": ["id", "result"],\n        "additionalProperties": false,\n        "properties": {\n          "id": { "type": "string", "pattern": "^AC-[0-9]+$" },\n          "result": { "type": "string", "enum": ["PASS", "FAIL"] },\n          "evidenceIds": { "type": "array", "items": { "type": "string", "minLength": 1 } },\n          "repairScope": { "type": "string" }\n        }\n      }\n    },\n    "evidenceIds": { "type": "array", "items": { "type": "string", "minLength": 1 } }\n  }\n}\n';
  }
});

// kata-asset:/app/kata/schemas/wiki-record.schema.json
var wiki_record_schema_default;
var init_wiki_record_schema = __esm({
  "kata-asset:/app/kata/schemas/wiki-record.schema.json"() {
    wiki_record_schema_default = '{\n  "$schema": "https://json-schema.org/draft/2020-12/schema",\n  "$id": "https://kata.dev/schemas/wiki-record.schema.json",\n  "title": "Kata Governed Wiki Record",\n  "type": "object",\n  "required": [\n    "id",\n    "statement",\n    "scope",\n    "kind",\n    "sourceRefs",\n    "sourceHashes",\n    "validationTaskId",\n    "evidenceIds",\n    "status",\n    "lastVerifiedAt",\n    "createdAt",\n    "updatedAt"\n  ],\n  "additionalProperties": false,\n  "properties": {\n    "id": { "type": "string", "minLength": 1 },\n    "statement": { "type": "string", "minLength": 1 },\n    "scope": { "type": "array", "minItems": 1, "items": { "type": "string", "minLength": 1 } },\n    "kind": { "type": "string", "minLength": 1 },\n    "sourceRefs": { "type": "array", "minItems": 1, "items": { "type": "string", "minLength": 1 } },\n    "sourceHashes": {\n      "type": "object",\n      "additionalProperties": { "type": "string", "pattern": "^[a-fA-F0-9]{64}$" }\n    },\n    "validationTaskId": { "type": "string", "minLength": 1 },\n    "evidenceIds": { "type": "array", "minItems": 1, "items": { "type": "string", "minLength": 1 } },\n    "status": { "type": "string", "enum": ["candidate", "verified", "stale", "rejected"] },\n    "lastVerifiedAt": { "type": "string" },\n    "createdAt": { "type": "string", "minLength": 1 },\n    "updatedAt": { "type": "string", "minLength": 1 },\n    "approvalEvent": {\n      "type": "object",\n      "required": ["approvedBy", "role", "approvedAt"],\n      "additionalProperties": false,\n      "properties": {\n        "approvedBy": { "type": "string", "minLength": 1 },\n        "role": { "type": "string", "minLength": 1 },\n        "approvedAt": { "type": "string", "minLength": 1 },\n        "notes": { "type": "string" }\n      }\n    },\n    "rejectionEvent": {\n      "type": "object",\n      "required": ["rejectedBy", "role", "rejectedAt", "reason"],\n      "additionalProperties": false,\n      "properties": {\n        "rejectedBy": { "type": "string", "minLength": 1 },\n        "role": { "type": "string", "minLength": 1 },\n        "rejectedAt": { "type": "string", "minLength": 1 },\n        "reason": { "type": "string", "minLength": 1 }\n      }\n    }\n  }\n}\n';
  }
});

// kata-asset:/app/kata/schemas/handoff-packet.schema.json
var handoff_packet_schema_default;
var init_handoff_packet_schema = __esm({
  "kata-asset:/app/kata/schemas/handoff-packet.schema.json"() {
    handoff_packet_schema_default = '{\n  "type": "object",\n  "required": ["protocolVersion", "id", "taskId", "createdAt", "from", "to", "phase", "repository", "task", "context", "permissions", "nextAction"],\n  "properties": {\n    "protocolVersion": { "type": "integer", "minimum": 1 },\n    "id": { "type": "string", "pattern": "^[a-z][a-z0-9-]{0,63}$" },\n    "taskId": { "type": "string", "pattern": "^[a-z][a-z0-9-]{0,63}$" },\n    "createdAt": { "type": "string", "minLength": 1 }\n  }\n}\n';
  }
});

// kata-asset:/app/kata/schemas/handoff-receipt.schema.json
var handoff_receipt_schema_default;
var init_handoff_receipt_schema = __esm({
  "kata-asset:/app/kata/schemas/handoff-receipt.schema.json"() {
    handoff_receipt_schema_default = '{\n  "type": "object",\n  "required": ["protocolVersion", "taskId", "handoffId", "platform", "role", "packetSha256", "acknowledgedAt"],\n  "properties": {\n    "protocolVersion": { "type": "integer", "minimum": 1 },\n    "taskId": { "type": "string", "pattern": "^[a-z][a-z0-9-]{0,63}$" },\n    "handoffId": { "type": "string", "pattern": "^[a-z][a-z0-9-]{0,63}$" },\n    "platform": { "type": "string", "pattern": "^[a-z][a-z0-9-]{0,63}$" },\n    "role": { "type": "string", "pattern": "^[a-z][a-z0-9-]{0,63}$" },\n    "packetSha256": { "type": "string", "pattern": "^[a-f0-9]{64}$" },\n    "acknowledgedAt": { "type": "string", "minLength": 1 }\n  }\n}\n';
  }
});

// src/quality/evidence.ts
var evidence_exports = {};
__export(evidence_exports, {
  checkFreshness: () => checkFreshness,
  collectEvidence: () => collectEvidence,
  computeDiffHash: () => computeDiffHash,
  computeScopeHash: () => computeScopeHash
});
import { createHash, randomUUID } from "node:crypto";
import { readdir, readFile as readFile2, stat } from "node:fs/promises";
import { join as join3, relative, resolve as resolve2 } from "node:path";
import { spawn } from "node:child_process";
async function collectEvidence(taskId, commands, options = {}) {
  const evidence = [];
  const cwd2 = commands[0]?.cwd ?? process.cwd();
  if (commands.some((check) => (check.cwd ?? process.cwd()) !== cwd2)) {
    throw new Error("All evidence checks in one collection must use the same cwd");
  }
  for (const check of commands) {
    if (options.signal?.aborted) break;
    const checkName = check.name ?? check.command;
    const timeoutMs = check.timeoutMs ?? 6e5;
    options.onProgress?.({ type: "quality_check_progress", check: checkName, state: "started", timeoutMs });
    const startedAt = (/* @__PURE__ */ new Date()).toISOString();
    const redactions = collectRedactions(check);
    const command = redact(renderCommand(check.command, check.args ?? []), redactions);
    const result = check.importResult ?? await runBoundedCommand(check, { onProgress: options.onProgress, signal: options.signal });
    const finishedAt = (/* @__PURE__ */ new Date()).toISOString();
    const finalState = options.signal?.aborted ? "cancelled" : result.exitCode === 0 ? "passed" : result.exitCode === 124 ? "timed_out" : "failed";
    options.onProgress?.({ type: "quality_check_progress", check: checkName, state: finalState, timeoutMs, exitCode: result.exitCode });
    evidence.push({
      id: `evidence-${randomUUID()}`,
      taskId,
      ...check.name ? { name: check.name } : {},
      kind: check.kind,
      command,
      environment: redact(result.environment ?? environmentSummary(cwd2), redactions),
      exitCode: result.exitCode,
      startedAt,
      finishedAt,
      diffHash: "",
      ...result.log ? { log: redact(truncate(result.log), redactions) } : {}
    });
  }
  if (evidence.length === 0) return evidence;
  const finalDiffHash = await computeDiffHash(cwd2);
  const scopePaths = options.revision?.ownedPaths ?? options.scopePaths;
  const scope = options.revision ? { paths: options.revision.ownedPaths, hash: options.revision.manifestHash } : scopePaths?.length ? { paths: [...new Set(scopePaths.map((path) => normalizeScopePath(cwd2, path)))].sort(), hash: await computeScopeHash(cwd2, scopePaths) } : void 0;
  return evidence.map((item) => ({
    ...item,
    diffHash: finalDiffHash,
    ...options.revision ? { revisionId: options.revision.id } : {},
    ...scope ? { scope } : {}
  }));
}
function checkFreshness(evidence, diffHash, scopeHash) {
  if (evidence.scope) {
    if (scopeHash === evidence.scope.hash) return { fresh: true };
    return {
      fresh: false,
      reason: "scope_hash_mismatch",
      expectedScopeHash: scopeHash ?? "",
      evidenceScopeHash: evidence.scope.hash
    };
  }
  if (evidence.diffHash === diffHash) return { fresh: true };
  return {
    fresh: false,
    reason: "diff_hash_mismatch",
    expectedDiffHash: diffHash,
    evidenceDiffHash: evidence.diffHash
  };
}
async function computeScopeHash(root, paths) {
  const normalizedPaths = [...new Set(paths.map((path) => normalizeScopePath(root, path)))].sort();
  const hash2 = createHash("sha256");
  for (const path of normalizedPaths) {
    hash2.update(path);
    hash2.update("\0");
    const fullPath = join3(root, path);
    try {
      const entryStat = await stat(fullPath);
      if (entryStat.isDirectory()) {
        await hashDirectoryRecursive(fullPath, root, hash2);
      } else {
        hash2.update(await readFile2(fullPath));
      }
    } catch {
      hash2.update("[missing]");
    }
    hash2.update("\0");
  }
  return hash2.digest("hex");
}
async function hashDirectoryRecursive(dirPath, root, hash2) {
  let entries;
  try {
    entries = await readdir(dirPath, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (shouldIgnore(entry.name)) continue;
    const absolutePath = join3(dirPath, entry.name);
    const relativePath = relative(root, absolutePath).replaceAll("\\", "/");
    if (shouldIgnorePath(relativePath)) continue;
    if (entry.isDirectory()) {
      await hashDirectoryRecursive(absolutePath, root, hash2);
      continue;
    }
    if (!entry.isFile()) continue;
    hash2.update(relativePath);
    hash2.update("\0");
    try {
      hash2.update(await readFile2(absolutePath));
    } catch {
      hash2.update("[missing]");
    }
    hash2.update("\0");
  }
}
function normalizeScopePath(root, path) {
  const absolute = resolve2(root, path);
  const normalized = relative(root, absolute).replaceAll("\\", "/");
  if (!normalized || normalized === ".." || normalized.startsWith("../")) {
    throw new Error(`Evidence scope path must be inside the repository: ${path}`);
  }
  return normalized;
}
async function computeDiffHash(root = process.cwd()) {
  const entries = await collectFileSnapshot(root);
  const hash2 = createHash("sha256");
  for (const entry of entries) {
    hash2.update(entry.path);
    hash2.update("\0");
    hash2.update(entry.content);
    hash2.update("\0");
  }
  return hash2.digest("hex");
}
async function runBoundedCommand(check, options) {
  const cwd2 = check.cwd ?? process.cwd();
  const timeoutMs = check.timeoutMs ?? 6e5;
  const checkName = check.name ?? check.command;
  const child = spawn(check.command, check.args ?? [], {
    cwd: cwd2,
    env: { ...process.env, ...check.env ?? {} },
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
    detached: true
  });
  const exitPromise = new Promise((exitResolve) => {
    child.on("close", (code) => exitResolve(code));
  });
  return new Promise((resolve6, reject) => {
    let settled = false;
    let output = "";
    let terminating = false;
    async function terminateAndWait(exitCode, logNote) {
      const pid = child.pid;
      if (pid === void 0) return;
      terminating = true;
      try {
        process.kill(-pid, "SIGTERM");
      } catch {
      }
      const grace = setTimeout(() => {
        try {
          process.kill(-pid, "SIGKILL");
        } catch {
        }
      }, graceMs);
      await exitPromise;
      clearTimeout(grace);
      if (!settled) {
        settled = true;
        resolve6({
          exitCode,
          log: `${truncate(output)}
[${logNote}]`,
          environment: environmentSummary(cwd2)
        });
      }
    }
    const timer = setTimeout(() => {
      terminateAndWait(124, `TIMEOUT after ${timeoutMs}ms`);
    }, timeoutMs);
    function onAbort() {
      clearTimeout(timer);
      terminateAndWait(1, "CANCELLED");
    }
    const abortSignal = options?.signal;
    if (abortSignal?.aborted) {
      onAbort();
      return;
    }
    abortSignal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      output = truncate(output + chunk);
    });
    child.stderr.on("data", (chunk) => {
      output = truncate(output + chunk);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      abortSignal?.removeEventListener("abort", onAbort);
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    exitPromise.then((code) => {
      clearTimeout(timer);
      abortSignal?.removeEventListener("abort", onAbort);
      if (!terminating && !settled) {
        settled = true;
        resolve6({
          exitCode: code ?? 1,
          log: output,
          environment: environmentSummary(cwd2)
        });
      }
    });
  });
}
async function collectFileSnapshot(root) {
  const files = [];
  async function visit(directory) {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (shouldIgnore(entry.name)) continue;
      const absolutePath = join3(directory, entry.name);
      const relativePath = relative(root, absolutePath).replaceAll("\\", "/");
      if (shouldIgnorePath(relativePath)) continue;
      if (entry.isDirectory()) {
        await visit(absolutePath);
        continue;
      }
      if (!entry.isFile()) continue;
      const info = await stat(absolutePath);
      if (info.size > 2e6) continue;
      files.push({ path: relativePath, content: await readFile2(absolutePath) });
    }
  }
  await visit(root);
  return files.sort((left, right) => left.path.localeCompare(right.path));
}
function shouldIgnore(name) {
  return name === ".git" || name === ".kata" || name === ".llmwiki" || name === ".pytest_cache" || name === ".mypy_cache" || name === ".ruff_cache" || name === ".coverage" || name === "__pycache__" || name === "node_modules" || name === "dist" || name === ".codex" || name === ".claude" || name === ".opencode";
}
function shouldIgnorePath(path) {
  return path === ".github/hooks" || path.startsWith(".github/hooks/") || path === ".github/skills" || path.startsWith(".github/skills/") || path === ".github/instructions" || path.startsWith(".github/instructions/");
}
function collectRedactions(check) {
  return [
    ...check.redact ?? [],
    ...sensitiveEnvironmentValues(process.env),
    ...Object.entries(check.env ?? {}).filter(([key]) => /secret|token|password|key/i.test(key)).map(([, value]) => value)
  ].filter((value) => value.length > 0);
}
function sensitiveEnvironmentValues(env) {
  return Object.entries(env).filter(([key]) => /secret|token|password|key/i.test(key)).map(([, value]) => value ?? "").filter((value) => value.length > 0);
}
function environmentSummary(cwd2) {
  return `node=${process.version} platform=${process.platform} cwd=${cwd2}`;
}
function renderCommand(command, args) {
  return [command, ...args].join(" ");
}
function redact(value, secrets) {
  let redacted = value;
  for (const secret of secrets) {
    redacted = redacted.split(secret).join("[REDACTED]");
  }
  return redacted;
}
function truncate(value) {
  if (value.length <= maxLogLength) return value;
  return value.slice(0, maxLogLength);
}
var maxLogLength, graceMs;
var init_evidence = __esm({
  "src/quality/evidence.ts"() {
    "use strict";
    maxLogLength = 2e4;
    graceMs = 5e3;
  }
});

// src/core/schema.ts
function validate(schemaName, value) {
  const schema = loadSchema(schemaName);
  assertMatches(schema, value, "$");
  return value;
}
function loadSchema(schemaName) {
  if (!/^[a-z][a-z0-9-]*$/.test(schemaName)) {
    throw new Error(`Invalid schema name: ${schemaName}`);
  }
  const cached = schemas.get(schemaName);
  if (cached) return cached;
  const text = schemaText[schemaName];
  if (text === void 0) {
    throw new Error(`Unknown schema: ${schemaName}`);
  }
  const parsed = JSON.parse(text);
  schemas.set(schemaName, parsed);
  return parsed;
}
function assertMatches(schema, value, path) {
  if (schema.enum && !schema.enum.some((allowed) => allowed === value)) {
    throw new Error(`${path} must be one of ${schema.enum.join(", ")}`);
  }
  if (schema.type) assertType(schema.type, value, path);
  if (schema.type === "string" && typeof value === "string") {
    if (schema.minLength !== void 0 && value.length < schema.minLength) {
      throw new Error(`${path} must be at least ${schema.minLength} characters`);
    }
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) {
      throw new Error(`${path} must match ${schema.pattern}`);
    }
  }
  if (schema.type === "integer" && typeof value === "number" && schema.minimum !== void 0) {
    if (value < schema.minimum) throw new Error(`${path} must be >= ${schema.minimum}`);
  }
  if (schema.type === "array" && Array.isArray(value)) {
    if (schema.minItems !== void 0 && value.length < schema.minItems) {
      throw new Error(`${path} must include at least ${schema.minItems} item(s)`);
    }
    if (schema.items) {
      value.forEach((item, index) => assertMatches(schema.items, item, `${path}[${index}]`));
    }
  }
  if (schema.type === "object" && isRecord2(value)) {
    for (const required of schema.required ?? []) {
      if (!(required in value)) throw new Error(`${path}.${required} is required`);
    }
    const properties = schema.properties ?? {};
    for (const [key, childValue] of Object.entries(value)) {
      const childSchema = properties[key];
      if (childSchema) {
        assertMatches(childSchema, childValue, `${path}.${key}`);
        continue;
      }
      if (schema.additionalProperties === false) {
        throw new Error(`${path}.${key} is not allowed`);
      }
      if (typeof schema.additionalProperties === "object") {
        assertMatches(schema.additionalProperties, childValue, `${path}.${key}`);
      }
    }
  }
}
function assertType(type, value, path) {
  if (type === "array") {
    if (!Array.isArray(value)) throw new Error(`${path} must be an array`);
    return;
  }
  if (type === "integer") {
    if (!Number.isInteger(value)) throw new Error(`${path} must be an integer`);
    return;
  }
  if (type === "object") {
    if (!isRecord2(value)) throw new Error(`${path} must be an object`);
    return;
  }
  if (typeof value !== type) throw new Error(`${path} must be a ${type}`);
}
function isRecord2(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
var schemaText, schemas;
var init_schema = __esm({
  "src/core/schema.ts"() {
    "use strict";
    init_task_schema();
    init_workflow_state_record_schema();
    init_workflow_state_event_schema();
    init_evidence_schema();
    init_review_finding_schema();
    init_judge_result_schema();
    init_wiki_record_schema();
    init_handoff_packet_schema();
    init_handoff_receipt_schema();
    schemaText = {
      task: task_schema_default,
      "workflow-state-record": workflow_state_record_schema_default,
      "workflow-state-event": workflow_state_event_schema_default,
      evidence: evidence_schema_default,
      "review-finding": review_finding_schema_default,
      "judge-result": judge_result_schema_default,
      "wiki-record": wiki_record_schema_default,
      "handoff-packet": handoff_packet_schema_default,
      "handoff-receipt": handoff_receipt_schema_default
    };
    schemas = /* @__PURE__ */ new Map();
  }
});

// src/wiki/record.ts
import { createHash as createHash3 } from "node:crypto";
function computeFileHash(content) {
  return createHash3("sha256").update(content).digest("hex");
}
function validateWikiRecord(value) {
  return validate("wiki-record", value);
}
var init_record = __esm({
  "src/wiki/record.ts"() {
    "use strict";
    init_schema();
  }
});

// src/wiki/store.ts
var store_exports = {};
__export(store_exports, {
  deleteWikiRecord: () => deleteWikiRecord,
  findWikiRecord: () => findWikiRecord,
  readWikiRecords: () => readWikiRecords,
  updateWikiRecord: () => updateWikiRecord,
  writeWikiRecord: () => writeWikiRecord
});
import { mkdir as mkdir5, readFile as readFile7, readdir as readdir3, writeFile as writeFile5 } from "node:fs/promises";
import { join as join8 } from "node:path";
function normalizeId(id) {
  return id.replace(/[^a-zA-Z0-9._-]/g, "_");
}
async function readWikiRecords(root) {
  const wikiDir = join8(root, ".kata/wiki");
  let files;
  try {
    files = await readdir3(wikiDir);
  } catch {
    return [];
  }
  const records = await Promise.all(
    files.filter((f) => f.endsWith(".json")).sort().map(async (file) => {
      const raw = await readFile7(join8(wikiDir, file), "utf8");
      return JSON.parse(raw);
    })
  );
  return records;
}
async function writeWikiRecord(root, record) {
  const id = normalizeId(record.id);
  const wikiDir = join8(root, ".kata/wiki");
  await mkdir5(wikiDir, { recursive: true });
  const validated = validateWikiRecord(record);
  const validatedWithId = { ...validated, id };
  await writeFile5(join8(wikiDir, `${id}.json`), `${JSON.stringify(validatedWithId, null, 2)}
`, "utf8");
}
async function updateWikiRecord(root, id, update2) {
  const normalizedId = normalizeId(id);
  const wikiDir = join8(root, ".kata/wiki");
  const filePath = join8(wikiDir, `${normalizedId}.json`);
  const raw = await readFile7(filePath, "utf8");
  const existing = JSON.parse(raw);
  const updated = {
    ...existing,
    ...update2,
    id: existing.id,
    updatedAt: (/* @__PURE__ */ new Date()).toISOString()
  };
  await writeFile5(filePath, `${JSON.stringify(updated, null, 2)}
`, "utf8");
  return updated;
}
async function deleteWikiRecord(root, id) {
  const normalizedId = normalizeId(id);
  const filePath = join8(root, ".kata/wiki", `${normalizedId}.json`);
  const { rm: rm5 } = await import("node:fs/promises");
  await rm5(filePath);
}
async function findWikiRecord(root, id) {
  const records = await readWikiRecords(root);
  return records.find((r) => r.id === id);
}
var init_store = __esm({
  "src/wiki/store.ts"() {
    "use strict";
    init_record();
  }
});

// src/cli/prompt.ts
var prompt_exports = {};
__export(prompt_exports, {
  checkbox: () => checkbox,
  confirmDestructive: () => confirmDestructive,
  select: () => select
});
import { select as inquirerSelect, checkbox as inquirerCheckbox, confirm as inquirerConfirm } from "@inquirer/prompts";
import { stdin as defaultInput, stdout as defaultOutput } from "node:process";
async function select(question, options, io) {
  const input = io?.input ?? defaultInput;
  const output = io?.output ?? defaultOutput;
  if (input === defaultInput && !input.isTTY) {
    return options[0].value;
  }
  return await inquirerSelect({
    message: question,
    choices: options.map((opt) => ({ name: opt.label, value: opt.value })),
    ...io?.input ? { input: io.input } : {},
    ...io?.output ? { output: io.output } : {}
  });
}
async function checkbox(question, options, io) {
  const input = io?.input ?? defaultInput;
  const output = io?.output ?? defaultOutput;
  if (input === defaultInput && !input.isTTY) {
    return options.filter((o) => o.checked).map((o) => o.value);
  }
  return await inquirerCheckbox({
    message: question,
    choices: options.map((opt) => ({ name: opt.label, value: opt.value, checked: opt.checked })),
    ...io?.input ? { input: io.input } : {},
    ...io?.output ? { output: io.output } : {}
  });
}
async function confirmDestructive(message, details) {
  if (!defaultOutput.isTTY) return false;
  const detail = details && details.length > 0 ? `
${details.map((d) => `  ${d}`).join("\n")}` : "";
  return await inquirerConfirm({
    message: `${message}${detail}
Continue?`,
    default: false
  });
}
var init_prompt = __esm({
  "src/cli/prompt.ts"() {
    "use strict";
  }
});

// src/cli.ts
import { readdir as readdir10, readFile as readFile24 } from "node:fs/promises";
import { createHash as createHash7 } from "node:crypto";
import { execFileSync as execFileSync5 } from "node:child_process";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join as join28 } from "node:path";

// src/codegraph/runtime.ts
import { dirname } from "node:path";
function codeGraphExecutionEnv(inherited = process.env, nodeExecutable = process.execPath) {
  const runtimeBin = dirname(nodeExecutable);
  const inheritedPath = inherited.PATH ?? "";
  return {
    ...inherited,
    PATH: inheritedPath ? `${runtimeBin}:${inheritedPath}` : runtimeBin
  };
}

// src/core/layout.ts
import { basename, dirname as dirname2, join as join2, resolve } from "node:path";
import { cwd } from "node:process";
import { accessSync, readdirSync } from "node:fs";

// src/core/config.ts
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
async function loadConfig(root) {
  const parsed = await readConfigObject(root);
  try {
    return {
      ...parsed.language !== void 0 ? { language: parseResponseLanguage(parsed.language) } : {},
      ...isRecord(parsed.quality) ? { quality: parseQualityConfig(parsed.quality) } : {}
    };
  } catch (error) {
    throw new Error(`Invalid Kata config: ${error instanceof Error ? error.message : String(error)}`);
  }
}
async function readConfigObject(root) {
  const configPath = join(root, ".kata-config.json");
  let raw;
  try {
    raw = await readFile(configPath, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return {};
    throw error;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid Kata config JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isRecord(parsed)) throw new Error("Invalid Kata config: root must be an object");
  return parsed;
}
async function writeConfigPatch(root, patch) {
  const current = await readConfigObject(root);
  const next = { ...current, ...patch };
  await writeFile(join(root, ".kata-config.json"), `${JSON.stringify(next, null, 2)}
`, "utf8");
  return next;
}
function parseQualityConfig(value) {
  const buildChecks = Array.isArray(value.buildChecks) ? value.buildChecks.map(parseQualityCheck) : void 0;
  return {
    ...buildChecks ? { buildChecks } : {}
  };
}
function parseQualityCheck(value) {
  if (!isRecord(value)) throw new Error("quality.buildChecks entries must be objects");
  if (typeof value.command !== "string" || value.command.length === 0) {
    throw new Error("quality.buildChecks[].command is required");
  }
  const args = value.args === void 0 ? void 0 : Array.isArray(value.args) && value.args.every((item) => typeof item === "string") ? value.args : (() => {
    throw new Error("quality.buildChecks[].args must be a string array");
  })();
  const kind = value.kind === void 0 ? void 0 : isEvidenceKind(value.kind) ? value.kind : (() => {
    throw new Error("quality.buildChecks[].kind is invalid");
  })();
  return {
    ...typeof value.name === "string" ? { name: value.name } : {},
    ...kind ? { kind } : {},
    command: value.command,
    ...args ? { args } : {},
    ...typeof value.timeoutMs === "number" ? { timeoutMs: value.timeoutMs } : {}
  };
}
function isEvidenceKind(value) {
  return typeof value === "string" && ["lint", "typecheck", "test", "ci", "review", "judge", "security"].includes(value);
}
function parseResponseLanguage(value) {
  if (value === "en" || value === "zh") return value;
  throw new Error('language must be "en" or "zh"');
}
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isNodeError(error) {
  return error instanceof Error && "code" in error;
}

// src/core/layout.ts
init_task_schema();
init_workflow_state_record_schema();
init_workflow_state_event_schema();
init_evidence_schema();
init_review_finding_schema();
init_judge_result_schema();
init_wiki_record_schema();
init_handoff_packet_schema();
init_handoff_receipt_schema();
function hasFileOrDir(dir, name) {
  try {
    accessSync(join2(dir, name));
    return true;
  } catch {
    return false;
  }
}
var workspaceMarkers = [".git", ".opencode", "opencode.json", "package.json", "Cargo.toml", "go.mod"];
var SKIP_DIRS = /* @__PURE__ */ new Set([
  "node_modules",
  ".git",
  "target",
  "dist",
  "build",
  ".kata",
  "coverage",
  "__pycache__",
  ".venv",
  "venv",
  ".env",
  ".opencode"
]);
function resolveWorkspaceRoot(from) {
  let dir = resolve(from ?? cwd());
  while (true) {
    for (const marker of workspaceMarkers) {
      if (hasFileOrDir(dir, marker)) return dir;
    }
    const parent = resolve(dir, "..");
    if (parent === dir) return from ?? cwd();
    dir = parent;
  }
}
function resolveWorkspaceRootForTask(taskId, from) {
  const start = resolve(from ?? cwd());
  const candidates = [];
  let directory = start;
  while (true) {
    if (hasFileOrDir(directory, join2(".kata", "tasks", taskId, "current-state.json"))) {
      candidates.push(directory);
    }
    const parent = resolve(directory, "..");
    if (parent === directory) break;
    directory = parent;
  }
  if (candidates.length === 1) return candidates[0];
  if (candidates.length > 1) {
    throw new Error(`Ambiguous Kata task root for ${taskId}: ${candidates.join(", ")}. Pass --root explicitly.`);
  }
  const workspaceRoot = resolveWorkspaceRoot(start);
  const descendants = findDescendantTaskRoots(taskId, workspaceRoot);
  if (descendants.length === 1) return descendants[0];
  if (descendants.length > 1) {
    throw new Error(
      `Multiple descendant worktrees own task ${taskId}: ${descendants.join(", ")}. Pass --root explicitly to select one.`
    );
  }
  throw new Error(
    `No Kata workspace owns task ${taskId}. Neither the current/ancestor workspace nor any eligible nested worktree contains this task. Pass --root explicitly or run the command from that workspace.`
  );
}
function findDescendantTaskRoots(taskId, root) {
  const candidates = [];
  function scan(dir) {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (SKIP_DIRS.has(entry.name)) continue;
      const fullPath = join2(dir, entry.name);
      if (hasFileOrDir(fullPath, join2(".kata", "tasks", taskId, "current-state.json"))) {
        candidates.push(fullPath);
      }
      scan(fullPath);
    }
  }
  scan(root);
  return candidates;
}

// src/core/recovery.ts
import { mkdir as mkdir4, readFile as readFile6 } from "node:fs/promises";
import { join as join7 } from "node:path";

// src/core/state.ts
init_evidence();
import { appendFile, mkdir as mkdir3, readFile as readFile5, rename, rm, writeFile as writeFile4 } from "node:fs/promises";
import { basename as basename2, dirname as dirname4, join as join6 } from "node:path";
import { randomUUID as randomUUID3 } from "node:crypto";

// src/workflow/revision.ts
import { createHash as createHash2, randomUUID as randomUUID2 } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir as mkdir2, readdir as readdir2, readFile as readFile4, stat as stat2, writeFile as writeFile3 } from "node:fs/promises";
import { join as join5, relative as relative2, resolve as resolve3 } from "node:path";

// src/core/relations.ts
import { mkdir, readFile as readFile3, writeFile as writeFile2 } from "node:fs/promises";
import { dirname as dirname3, join as join4 } from "node:path";

// src/core/ids.ts
var taskIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
function assertValidTaskId(taskId) {
  if (!taskIdPattern.test(taskId)) {
    throw new Error(`Invalid task id: ${taskId}`);
  }
}

// src/core/relations.ts
var terminalRelationTypes = [
  "superseded_by",
  "covered_by",
  "duplicate_of",
  "merged_into"
];
function isTerminalRelation(type) {
  return terminalRelationTypes.includes(type);
}
async function addTaskRelation(input) {
  assertValidTaskId(input.fromTaskId);
  assertValidTaskId(input.toTaskId);
  if (input.fromTaskId === input.toTaskId) throw new Error("Task relation cannot point to itself");
  await assertTaskExists(input.root, input.fromTaskId);
  await assertTaskExists(input.root, input.toTaskId);
  const now = (/* @__PURE__ */ new Date()).toISOString();
  await addKataRelation({
    root: input.root,
    from: { type: "task", id: input.fromTaskId },
    to: { type: "task", id: input.toTaskId },
    type: input.type,
    ...input.reason ? { reason: input.reason } : {},
    ...input.createdBy ? { createdBy: input.createdBy } : {},
    createdAt: now
  });
  const current = await readTaskRelations(input.root, input.fromTaskId);
  const relation = {
    type: input.type,
    targetTaskId: input.toTaskId,
    ...input.reason ? { reason: input.reason } : {},
    createdAt: now,
    ...input.createdBy ? { createdBy: input.createdBy } : {}
  };
  const next = {
    taskId: input.fromTaskId,
    relations: [
      ...current.relations.filter((item) => !(item.type === relation.type && item.targetTaskId === relation.targetTaskId)),
      relation
    ],
    updatedAt: now
  };
  await writeTaskRelations(input.root, input.fromTaskId, next);
  await mirrorRelationIntoTask(input.root, input.fromTaskId, next);
  return next;
}
async function addKataRelation(input) {
  validateEndpoint(input.from);
  validateEndpoint(input.to);
  if (input.from.type === input.to.type && input.from.id === input.to.id) throw new Error("Relation cannot point to itself");
  if (input.from.type === "task") await assertTaskExists(input.root, input.from.id);
  if (input.to.type === "task") await assertTaskExists(input.root, input.to.id);
  const now = input.createdAt ?? (/* @__PURE__ */ new Date()).toISOString();
  const current = await readKataRelations(input.root);
  const relation = {
    kind: input.kind ?? inferRelationKind(input.type),
    type: input.type,
    from: input.from,
    to: input.to,
    ...input.reason ? { reason: input.reason } : {},
    createdAt: now,
    ...input.createdBy ? { createdBy: input.createdBy } : {}
  };
  const next = {
    version: 1,
    relations: [
      ...current.relations.filter((item) => !sameEndpoint(item.from, relation.from) || !sameEndpoint(item.to, relation.to) || item.type !== relation.type),
      relation
    ],
    updatedAt: now
  };
  await writeKataRelations(input.root, next);
  return next;
}
async function readKataRelations(root) {
  try {
    const parsed = JSON.parse(await readFile3(graphPath(root), "utf8"));
    return {
      version: 1,
      relations: Array.isArray(parsed.relations) ? parsed.relations.filter(isKataRelation) : [],
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : ""
    };
  } catch {
    return { version: 1, relations: [], updatedAt: "" };
  }
}
async function findKataRelations(root, endpoint) {
  validateEndpoint(endpoint);
  const graph = await readKataRelations(root);
  return {
    endpoint,
    outgoing: graph.relations.filter((relation) => sameEndpoint(relation.from, endpoint)),
    incoming: graph.relations.filter((relation) => sameEndpoint(relation.to, endpoint))
  };
}
async function readTaskRelations(root, taskId) {
  assertValidTaskId(taskId);
  const path = relationPath(root, taskId);
  try {
    const parsed = JSON.parse(await readFile3(path, "utf8"));
    return {
      taskId,
      relations: Array.isArray(parsed.relations) ? parsed.relations.filter(isTaskRelation) : [],
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : ""
    };
  } catch {
    const task = await readTask(root, taskId).catch(() => null);
    const taskRelations = Array.isArray(task?.relations) ? task.relations.filter(isTaskRelation) : [];
    return { taskId, relations: taskRelations, updatedAt: typeof task?.updatedAt === "string" ? task.updatedAt : "" };
  }
}
async function readTerminalTaskRelation(root, taskId) {
  const record = await readTaskRelations(root, taskId);
  return record.relations.find((relation) => isTerminalRelation(relation.type)) ?? null;
}
async function resolveTerminalTask(root, taskId) {
  assertValidTaskId(taskId);
  const seen = /* @__PURE__ */ new Set();
  const redirects = [];
  let current = taskId;
  for (let depth = 0; depth < 16; depth += 1) {
    if (seen.has(current)) throw new Error(`Task relation cycle detected at ${current}`);
    seen.add(current);
    const relation = await readTerminalTaskRelation(root, current);
    if (!relation) return { taskId: current, redirects };
    redirects.push({
      fromTaskId: current,
      toTaskId: relation.targetTaskId,
      type: relation.type,
      ...relation.reason ? { reason: relation.reason } : {}
    });
    current = relation.targetTaskId;
  }
  throw new Error(`Task relation chain is too deep starting at ${taskId}`);
}
function isTaskRelation(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value;
  return typeof record.type === "string" && typeof record.targetTaskId === "string" && typeof record.createdAt === "string";
}
function isKataRelation(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value;
  return typeof record.kind === "string" && typeof record.type === "string" && isEndpoint(record.from) && isEndpoint(record.to) && typeof record.createdAt === "string";
}
function isEndpoint(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value;
  return (record.type === "task" || record.type === "change") && typeof record.id === "string";
}
function validateEndpoint(endpoint) {
  if (endpoint.type !== "task" && endpoint.type !== "change") throw new Error(`Invalid relation endpoint type: ${endpoint.type}`);
  assertValidTaskId(endpoint.id);
}
function sameEndpoint(left, right) {
  return left.type === right.type && left.id === right.id;
}
function inferRelationKind(type) {
  if (type === "contains" || type === "implements") return "ownership";
  if (type === "parent_of" || type === "spawned_from" || type === "repairs") return "lineage";
  if (isTerminalRelation(type) || type === "depends_on" || type === "blocked_by") return "control";
  return "context";
}
async function assertTaskExists(root, taskId) {
  await readTask(root, taskId);
}
async function readTask(root, taskId) {
  return JSON.parse(await readFile3(join4(root, ".kata/tasks", taskId, "task.json"), "utf8"));
}
async function writeTaskRelations(root, taskId, record) {
  const path = relationPath(root, taskId);
  await mkdir(dirname3(path), { recursive: true });
  await writeFile2(path, `${JSON.stringify(record, null, 2)}
`, "utf8");
}
async function mirrorRelationIntoTask(root, taskId, record) {
  const path = join4(root, ".kata/tasks", taskId, "task.json");
  const task = await readTask(root, taskId);
  task.relations = record.relations;
  task.updatedAt = record.updatedAt;
  await writeFile2(path, `${JSON.stringify(task, null, 2)}
`, "utf8");
}
function relationPath(root, taskId) {
  return join4(root, ".kata/tasks", taskId, "task-relations.json");
}
async function writeKataRelations(root, graph) {
  const path = graphPath(root);
  await mkdir(dirname3(path), { recursive: true });
  await writeFile2(path, `${JSON.stringify(graph, null, 2)}
`, "utf8");
}
function graphPath(root) {
  return join4(root, ".kata/relations.json");
}

// src/workflow/revision.ts
async function createTaskRevision(input) {
  const ownedPaths2 = normalizeOwnedPaths(input.root, input.ownedPaths);
  if (ownedPaths2.length === 0) throw new Error("A revision requires at least one declared owned path");
  const manifestHash = await computeManifestHash(input.root, ownedPaths2);
  const revision = {
    id: `revision-${randomUUID2()}`,
    taskId: input.taskId,
    ownedPaths: ownedPaths2,
    manifestHash,
    createdAt: (/* @__PURE__ */ new Date()).toISOString(),
    ...input.ownershipConflicts?.length ? { ownershipConflicts: input.ownershipConflicts } : {},
    ...input.ownershipConflictsAcknowledged ? { ownershipConflictsAcknowledged: true } : {}
  };
  const directory = join5(input.root, ".kata/tasks", input.taskId, "revisions");
  await mkdir2(directory, { recursive: true });
  await writeFile3(join5(directory, `${revision.id}.json`), `${JSON.stringify(revision, null, 2)}
`, "utf8");
  await writeFile3(join5(input.root, ".kata/tasks", input.taskId, "current-revision.json"), `${JSON.stringify(revision, null, 2)}
`, "utf8");
  return revision;
}
async function readTaskRevision(root, taskId, revisionId) {
  return JSON.parse(await readFile4(join5(root, ".kata/tasks", taskId, "revisions", `${revisionId}.json`), "utf8"));
}
async function readCurrentTaskRevision(root, taskId) {
  try {
    return JSON.parse(await readFile4(join5(root, ".kata/tasks", taskId, "current-revision.json"), "utf8"));
  } catch (error) {
    if (isMissingFile(error)) return null;
    throw error;
  }
}
async function revisionStatus(root, revision) {
  const manifestHash = await computeManifestHash(root, revision.ownedPaths);
  return manifestHash === revision.manifestHash ? { status: "current" } : { status: "superseded", expectedManifestHash: manifestHash, revisionManifestHash: revision.manifestHash };
}
async function computeManifestHash(root, ownedPaths2) {
  const hash2 = createHash2("sha256");
  for (const path of normalizeOwnedPaths(root, ownedPaths2)) {
    hash2.update(path);
    hash2.update("\0");
    try {
      const fullPath = join5(root, path);
      const entry = await stat2(fullPath);
      if (entry.isDirectory()) {
        await hashDirectoryRecursive2(fullPath, root, hash2);
      } else if (entry.isFile()) {
        hash2.update(await readFile4(fullPath));
      } else {
        hash2.update("[unsupported]");
      }
    } catch {
      hash2.update("[missing]");
    }
    hash2.update("\0");
  }
  return hash2.digest("hex");
}
async function hashDirectoryRecursive2(dirPath, root, hash2) {
  let entries;
  try {
    entries = await readdir2(dirPath, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (shouldIgnore2(entry.name)) continue;
    const absolutePath = join5(dirPath, entry.name);
    const relativePath = relative2(root, absolutePath).replaceAll("\\", "/");
    if (shouldIgnorePath2(relativePath)) continue;
    if (entry.isDirectory()) {
      await hashDirectoryRecursive2(absolutePath, root, hash2);
      continue;
    }
    if (!entry.isFile()) continue;
    hash2.update(relativePath);
    hash2.update("\0");
    try {
      hash2.update(await readFile4(absolutePath));
    } catch {
      hash2.update("[missing]");
    }
    hash2.update("\0");
  }
}
function shouldIgnore2(name) {
  return name === ".git" || name === ".kata" || name === ".llmwiki" || name === ".pytest_cache" || name === ".mypy_cache" || name === ".ruff_cache" || name === ".coverage" || name === "__pycache__" || name === "node_modules" || name === "dist" || name === ".codex" || name === ".claude" || name === ".opencode";
}
function shouldIgnorePath2(path) {
  return path === ".github/hooks" || path.startsWith(".github/hooks/") || path === ".github/skills" || path.startsWith(".github/skills/") || path === ".github/instructions" || path.startsWith(".github/instructions/");
}
async function findOwnershipConflicts(root, taskId, ownedPaths2) {
  const tasksRoot = join5(root, ".kata/tasks");
  let entries = [];
  try {
    entries = await readdir2(tasksRoot);
  } catch {
    return [];
  }
  const normalized = normalizeOwnedPaths(root, ownedPaths2);
  const conflicts2 = [];
  for (const otherTaskId of entries.filter((id) => id !== taskId)) {
    try {
      const terminal = await resolveTerminalTask(root, otherTaskId);
      if (terminal.taskId === taskId) continue;
      if (terminal.redirects.length > 0) continue;
      try {
        const state = JSON.parse(await readFile4(join5(tasksRoot, terminal.taskId, "current-state.json"), "utf8"));
        if (state.phase === "archive") continue;
      } catch {
      }
      const task = JSON.parse(await readFile4(join5(tasksRoot, otherTaskId, "task.json"), "utf8"));
      for (const path of normalizeOwnedPaths(root, task.ownedPaths ?? [])) {
        if (normalized.some((owned) => pathsOverlap(owned, path))) conflicts2.push({ taskId: otherTaskId, path });
      }
    } catch {
    }
  }
  return conflicts2;
}
async function workspaceDrift(root, ownedPaths2) {
  const owned = normalizeOwnedPaths(root, ownedPaths2);
  return changedRepositoryPaths(root).filter((path) => !isIgnoredWorkspacePath(path)).filter((path) => !owned.some((ownedPath) => pathsOverlap(ownedPath, path))).sort();
}
function changedRepositoryPaths(root) {
  let output;
  try {
    output = execFileSync("git", ["status", "--porcelain=v1", "-z"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    });
  } catch {
    return [];
  }
  const tokens = output.split("\0").filter(Boolean);
  const paths = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] ?? "";
    const status = token.slice(0, 2);
    const path = token.slice(3);
    if (path) paths.push(path.replaceAll("\\", "/"));
    if (status.includes("R") || status.includes("C")) {
      index += 1;
      const originalPath = tokens[index];
      if (originalPath) paths.push(originalPath.replaceAll("\\", "/"));
    }
  }
  return [...new Set(paths)];
}
function isIgnoredWorkspacePath(path) {
  return path === ".kata" || path.startsWith(".kata/") || path === ".llmwiki" || path.startsWith(".llmwiki/") || path === ".codex" || path.startsWith(".codex/") || path === ".claude" || path.startsWith(".claude/") || path === ".opencode" || path.startsWith(".opencode/") || path === ".github/hooks" || path.startsWith(".github/hooks/") || path === ".github/skills" || path.startsWith(".github/skills/") || path === ".github/instructions" || path.startsWith(".github/instructions/") || path === "node_modules" || path.startsWith("node_modules/") || path === "dist" || path.startsWith("dist/");
}
function pathsOverlap(left, right) {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}
function normalizeOwnedPaths(root, paths) {
  return [...new Set(paths.map((path) => {
    const normalized = relative2(root, resolve3(root, path)).replaceAll("\\", "/");
    if (!normalized || normalized === ".." || normalized.startsWith("../")) {
      throw new Error(`Task-owned path must be inside the repository: ${path}`);
    }
    return normalized;
  }))].sort();
}
function isMissingFile(error) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

// src/core/state.ts
var orderedPhases = [
  "intake",
  "plan",
  "implement",
  "hardVerify",
  "review",
  "judge",
  "distill",
  "archive"
];
function isLegalPhaseTransition(from, to) {
  return orderedPhases.indexOf(to) === orderedPhases.indexOf(from) + 1;
}
async function transition(taskId, to, actor, options = {}) {
  const root = options.root ?? process.cwd();
  assertValidTaskId(taskId);
  return withTaskLock(root, taskId, async () => {
    const current = await readCurrentState(root, taskId);
    if (!isLegalPhaseTransition(current.phase, to)) {
      throw new Error(`Illegal transition from ${current.phase} to ${to}`);
    }
    if (to === "implement") await assertAcceptanceIds(root, taskId);
    if (to === "distill") await assertDistillGates(root, taskId);
    const now = (/* @__PURE__ */ new Date()).toISOString();
    const next = {
      taskId,
      phase: to,
      actor,
      updatedAt: now,
      ...options.activeSession ? { activeSession: options.activeSession } : {}
    };
    await appendStateEvent(root, {
      taskId,
      from: current.phase,
      to,
      actor,
      at: now,
      ...options.activeSession ? { activeSession: options.activeSession } : {}
    });
    await writeCurrentState(root, next);
    return next;
  });
}
async function withTaskLock(root, taskId, action) {
  assertValidTaskId(taskId);
  const lockPath = join6(root, ".kata/tasks", taskId, ".transition.lock");
  try {
    await mkdir3(lockPath);
  } catch (error) {
    if (isNodeError2(error) && error.code === "EEXIST") {
      throw new Error(`Task ${taskId} already has a state transition in progress`);
    }
    throw error;
  }
  try {
    return await action();
  } finally {
    await rm(lockPath, { recursive: true, force: true });
  }
}
async function appendStateEvent(root, event) {
  await appendFile(stateEventsPath(root, event.taskId), `${JSON.stringify(event)}
`, "utf8");
}
async function writeCurrentState(root, state) {
  await writeFileAtomic(currentStatePath(root, state.taskId), `${JSON.stringify(state, null, 2)}
`);
}
async function readStateEvents(root, taskId) {
  const raw = await readFile5(stateEventsPath(root, taskId), "utf8");
  return raw.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}
async function readCurrentState(root, taskId) {
  return JSON.parse(await readFile5(currentStatePath(root, taskId), "utf8"));
}
async function assertAcceptanceIds(root, taskId) {
  const task = JSON.parse(await readFile5(join6(root, ".kata/tasks", taskId, "task.json"), "utf8"));
  if (!task.acceptance?.length || task.acceptance.some((criterion) => !/^AC-[0-9]+$/.test(criterion.id ?? ""))) {
    throw new Error("Cannot enter implement until every acceptance criterion has a stable acceptance id");
  }
}
async function assertDistillGates(root, taskId) {
  const currentDiffHash = await computeDiffHash(root);
  const freshEvidence = await getFreshPassingEvidence(root, taskId, currentDiffHash);
  const gates = await Promise.all([
    Promise.resolve(freshEvidence !== null),
    hasReviewerClearance(root, taskId, freshEvidence?.revisionId),
    hasJudgePass(root, taskId, currentDiffHash, freshEvidence)
  ]);
  if (!gates.every(Boolean)) {
    throw new Error("Cannot enter distill until fresh evidence, reviewer clearance, and judge PASS are present");
  }
}
async function getFreshPassingEvidence(root, taskId, currentDiffHash) {
  try {
    const evidence = JSON.parse(await readFile5(join6(root, `.kata/evidence/${taskId}-hard.json`), "utf8"));
    if (evidence.taskId !== taskId || evidence.exitCode !== 0 || !evidence.diffHash) return null;
    if (evidence.revisionId) {
      const revision = await readTaskRevision(root, taskId, evidence.revisionId);
      if ((await revisionStatus(root, revision)).status !== "current") return null;
      return evidence;
    }
    const freshness = checkFreshness(
      {
        id: evidence.id ?? `${taskId}-hard`,
        taskId,
        kind: "test",
        command: evidence.command ?? "hard verification",
        exitCode: evidence.exitCode,
        startedAt: evidence.startedAt ?? "",
        finishedAt: evidence.finishedAt ?? "",
        diffHash: evidence.diffHash
      },
      currentDiffHash
    );
    return freshness.fresh ? evidence : null;
  } catch (error) {
    if (isNodeError2(error) && error.code === "ENOENT") return null;
    throw error;
  }
}
async function hasReviewerClearance(root, taskId, revisionId) {
  try {
    const review = JSON.parse(await readFile5(join6(root, ".kata/tasks", taskId, "review.json"), "utf8"));
    return Array.isArray(review.findings) && review.findings.every((finding) => finding.severity !== "blocking") && (!revisionId || review.revisionId === revisionId);
  } catch (error) {
    if (isNodeError2(error) && error.code === "ENOENT") return false;
    throw error;
  }
}
async function hasJudgePass(root, taskId, currentDiffHash, freshEvidence) {
  try {
    const judge2 = JSON.parse(await readFile5(join6(root, ".kata/tasks", taskId, "judge.json"), "utf8"));
    if (judge2.taskId !== taskId || judge2.result !== "PASS") return false;
    if (freshEvidence?.revisionId) {
      if (judge2.revisionId !== freshEvidence.revisionId) return false;
    } else if (judge2.diffHash !== currentDiffHash) return false;
    if (!freshEvidence?.id) return false;
    if (!Array.isArray(judge2.acceptance) || judge2.acceptance.length === 0) return false;
    if (judge2.acceptance.some((criterion) => criterion.result !== "PASS")) return false;
    const acceptedEvidenceIds = /* @__PURE__ */ new Set([...judge2.evidenceIds ?? [], ...judge2.acceptance.flatMap((criterion) => criterion.evidenceIds ?? [])]);
    return acceptedEvidenceIds.has(freshEvidence.id);
  } catch (error) {
    if (isNodeError2(error) && error.code === "ENOENT") return false;
    throw error;
  }
}
function currentStatePath(root, taskId) {
  assertValidTaskId(taskId);
  return join6(root, ".kata/tasks", taskId, "current-state.json");
}
function stateEventsPath(root, taskId) {
  assertValidTaskId(taskId);
  return join6(root, ".kata/tasks", taskId, "state-events.jsonl");
}
async function writeFileAtomic(path, content) {
  const temporaryPath = join6(dirname4(path), `.${basename2(path)}.${process.pid}.${randomUUID3()}.tmp`);
  await writeFile4(temporaryPath, content, "utf8");
  await rename(temporaryPath, path);
}
function isNodeError2(error) {
  return error instanceof Error && "code" in error;
}

// src/core/recovery.ts
async function recover(taskId, options = {}) {
  const root = options.root ?? process.cwd();
  const events = await readStateEvents(root, taskId);
  if (events.length === 0) throw new Error(`No state events found for task ${taskId}`);
  const validEvents = replayValidEvents(events);
  if (validEvents.length === 0) throw new Error(`No legal state events found for task ${taskId}`);
  const latest = validEvents[validEvents.length - 1];
  const latestSession = [...validEvents].reverse().find((event) => event.activeSession)?.activeSession;
  const current = {
    taskId,
    phase: latest.to,
    actor: latest.actor,
    updatedAt: latest.at,
    ...latestSession ? { activeSession: latestSession } : {}
  };
  const actions = [];
  if (validEvents.length !== events.length) actions.push(`ignored-${events.length - validEvents.length}-invalid-state-events`);
  let pointerMatches = false;
  if (latestSession) {
    try {
      const pointer = JSON.parse(await readFile6(activeSessionPath(root), "utf8"));
      pointerMatches = pointer.taskId === taskId && pointer.activeSession === latestSession;
    } catch (error) {
      if (!isNodeError3(error) || error.code !== "ENOENT") throw error;
    }
  }
  await writeCurrentState(root, current);
  actions.push("rewrote-current-state");
  if (latestSession && !pointerMatches) {
    await mkdir4(join7(root, ".kata/runtime"), { recursive: true });
    await writeCurrentStatePointer(root, taskId, latestSession);
    actions.push("rewrote-active-session-pointer");
  }
  return {
    taskId,
    phase: latest.to,
    ...latestSession ? { recoveredActiveSession: latestSession } : {},
    actions
  };
}
async function requiresRecovery(taskId, options = {}) {
  const root = options.root ?? process.cwd();
  const events = await readStateEvents(root, taskId);
  return replayValidEvents(events).length !== events.length;
}
function replayValidEvents(events) {
  const valid = [];
  for (const event of events) {
    const previous = valid.at(-1);
    if (!previous) {
      if (event.from === null && event.to === "intake") valid.push(event);
      continue;
    }
    if (event.from === previous.to && isLegalPhaseTransition(previous.to, event.to)) valid.push(event);
  }
  return valid;
}
async function writeCurrentStatePointer(root, taskId, activeSession) {
  const { writeFile: writeFile19 } = await import("node:fs/promises");
  await writeFile19(activeSessionPath(root), `${JSON.stringify({ taskId, activeSession }, null, 2)}
`, "utf8");
}
function activeSessionPath(root) {
  return join7(root, ".kata/runtime/active-session.json");
}
function isNodeError3(error) {
  return error instanceof Error && "code" in error;
}

// src/comet/client.ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";

// src/comet/compat.ts
import { readFileSync } from "node:fs";

// kata-asset:/app/kata/comet-compat.yaml
var comet_compat_default = "version: 1\ncomet:\n  minVersion: 1.2.0\n  maxVersion: 2.0.0\n  capabilities:\n    init: true\n    status: true\n    next: true\nboundary:\n  invocation: public-cli\n  jsonOutput: true\n";

// src/comet/compat.ts
function loadCometCompatibility(manifestPath2) {
  const manifest = manifestPath2 ? readFileSync(manifestPath2, "utf8") : comet_compat_default;
  const cometBlock = readIndentedBlock(manifest, "comet");
  const capabilitiesBlock = readIndentedBlock(manifest, "capabilities");
  const minVersion = readScalar(cometBlock, "minVersion");
  const maxVersion = readOptionalScalar(cometBlock, "maxVersion");
  const capabilities = {};
  for (const line of capabilitiesBlock.split("\n")) {
    const match = /^\s{4}([A-Za-z0-9_-]+):\s*(true|false)\s*$/.exec(line);
    if (match) capabilities[match[1]] = match[2] === "true";
  }
  if (!minVersion) throw new Error("comet-compat.yaml must declare comet.minVersion");
  if (Object.keys(capabilities).length === 0) {
    throw new Error("comet-compat.yaml must declare at least one comet capability");
  }
  return {
    minVersion,
    ...maxVersion ? { maxVersion } : {},
    capabilities
  };
}
function parseVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version.trim());
  if (!match) throw new Error(`Invalid Comet version: ${version}`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}
function compare(a, b) {
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}
function assertCometVersion(version, compatibility) {
  const actual = parseVersion(version);
  const min = parseVersion(compatibility.minVersion);
  const max = compatibility.maxVersion ? parseVersion(compatibility.maxVersion) : void 0;
  if (compare(actual, min) < 0 || max && compare(actual, max) > 0) {
    const range = max ? `${compatibility.minVersion}\u2013${compatibility.maxVersion}` : `>=${compatibility.minVersion}`;
    throw new Error(`Comet version ${version} is outside compatibility range ${range}`);
  }
}
function assertCapability(compatibility, capability) {
  if (!compatibility.capabilities[capability]) {
    throw new Error(`Comet capability is not available: ${capability}`);
  }
}
function readIndentedBlock(manifest, key) {
  const lines = manifest.split("\n");
  const start = lines.findIndex((line) => line === `${key}:` || line.trim() === `${key}:`);
  if (start === -1) throw new Error(`comet-compat.yaml is missing ${key} block`);
  const parentIndent = lines[start].match(/^ */)?.[0].length ?? 0;
  const block = [];
  for (const line of lines.slice(start + 1)) {
    if (!line.trim()) {
      block.push(line);
      continue;
    }
    const indent = line.match(/^ */)?.[0].length ?? 0;
    if (indent <= parentIndent) break;
    block.push(line);
  }
  return block.join("\n");
}
function readScalar(block, key) {
  const value = readOptionalScalar(block, key);
  if (!value) throw new Error(`comet-compat.yaml is missing ${key}`);
  return value;
}
function readOptionalScalar(block, key) {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`^\\s+${escapedKey}:\\s*([^#\\n]+?)\\s*$`, "m").exec(block);
  return match?.[1]?.replace(/^['"]|['"]$/g, "");
}

// src/comet/client.ts
var execFileAsync = promisify(execFile);
async function runPublicCommand(command, args) {
  const result = await execFileAsync(command, [...args], { encoding: "utf8" });
  return result.stdout;
}
var CometClient = class {
  command;
  compatibility;
  run;
  constructor(options) {
    this.command = options.command ?? "comet";
    this.compatibility = options.compatibility ?? loadCometCompatibility();
    this.run = options.run ?? runPublicCommand;
  }
  async assertInstalledVersion(version) {
    assertCometVersion(version, this.compatibility);
  }
  async init(change, options) {
    assertCapability(this.compatibility, "init");
    const args = ["init", change, "--json"];
    if (options?.language) args.push("--language", options.language);
    args.push("--yes");
    await this.run(this.command, args);
  }
  async status(change) {
    assertCapability(this.compatibility, "status");
    return this.parseJson(await this.run(this.command, ["status", change, "--json"]), "status");
  }
  async next(change) {
    assertCapability(this.compatibility, "next");
    return this.parseJson(await this.run(this.command, ["next", change, "--json"]), "next");
  }
  parseJson(output, operation) {
    try {
      return JSON.parse(output);
    } catch {
      throw new Error(`Comet ${operation} returned invalid JSON`);
    }
  }
};

// src/comet/install.ts
import { execFile as execFile2, spawn as spawn2 } from "node:child_process";
import { existsSync, readFileSync as readFileSync2, writeFileSync } from "node:fs";
import { promisify as promisify2 } from "node:util";
var execFileAsync2 = promisify2(execFile2);
function npmPackageName() {
  return "@rpamis/comet";
}
async function resolveCommandPath(command) {
  try {
    const { stdout } = await execFileAsync2("which", [command], { encoding: "utf8" });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}
async function resolveCometPath() {
  return resolveCommandPath("comet");
}
async function runNpm(args) {
  const { stdout } = await execFileAsync2("npm", args, { encoding: "utf8" });
  return stdout.trim();
}
function buildCometInstallInvocation(version) {
  const targetVersion = version ?? "latest";
  const spec = targetVersion === "latest" ? npmPackageName() : `${npmPackageName()}@${targetVersion}`;
  return { command: "npm", args: ["install", "-g", spec] };
}
function buildCometProjectInitInvocation(input) {
  return {
    command: "comet",
    args: [
      "init",
      input.root,
      "--scope",
      input.scope,
      ...input.language ? ["--language", input.language] : [],
      ...input.yes ? ["--yes", "--json"] : []
    ]
  };
}
async function initCometProject(input) {
  let binaryPath = await resolveCometPath();
  if (!binaryPath) {
    try {
      await installComet();
      binaryPath = await resolveCometPath();
    } catch {
      return {
        command: "comet init",
        status: "skipped",
        path: null,
        root: input.root,
        scope: input.scope,
        ...input.language ? { language: input.language } : {},
        reason: "comet_binary_install_failed"
      };
    }
  }
  if (!binaryPath) {
    return {
      command: "comet init",
      status: "skipped",
      path: null,
      root: input.root,
      scope: input.scope,
      ...input.language ? { language: input.language } : {},
      reason: "comet_binary_not_found"
    };
  }
  const invocation = buildCometProjectInitInvocation(input);
  if (input.yes) {
    try {
      const { stdout } = await execFileAsync2(binaryPath, invocation.args, { encoding: "utf8" });
      return {
        command: "comet init",
        status: "initialized",
        path: binaryPath,
        root: input.root,
        scope: input.scope,
        ...input.language ? { language: input.language } : {},
        stdout: stdout.trim()
      };
    } catch (error) {
      return {
        command: "comet init",
        status: "failed",
        path: binaryPath,
        root: input.root,
        scope: input.scope,
        ...input.language ? { language: input.language } : {},
        reason: error instanceof Error ? error.message : String(error)
      };
    }
  }
  try {
    await new Promise((resolvePromise, reject) => {
      const child = spawn2(binaryPath, invocation.args, {
        stdio: "inherit",
        env: { ...process.env }
      });
      child.on("exit", (code) => {
        if (code === 0) resolvePromise();
        else reject(new Error(`comet init exited with code ${code}`));
      });
      child.on("error", reject);
    });
    return {
      command: "comet init",
      status: "initialized",
      path: binaryPath,
      root: input.root,
      scope: input.scope,
      ...input.language ? { language: input.language } : {}
    };
  } catch (error) {
    return {
      command: "comet init",
      status: "failed",
      path: binaryPath,
      root: input.root,
      scope: input.scope,
      ...input.language ? { language: input.language } : {},
      reason: error instanceof Error ? error.message : String(error)
    };
  }
}
async function getCometVersion(binaryPath) {
  try {
    const cmd = binaryPath ?? "comet";
    const { stdout } = await execFileAsync2(cmd, ["--version"], { encoding: "utf8" });
    const match = stdout.trim().match(/(\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.]+)?)/);
    return (match?.[1] ?? stdout.trim()) || null;
  } catch {
    return null;
  }
}
async function fetchLatestNpmVersion() {
  try {
    const output = await runNpm(["view", npmPackageName(), "version"]);
    return output || null;
  } catch {
    return null;
  }
}
async function installComet(version) {
  const previousVersion = await getCometVersion();
  const invocation = buildCometInstallInvocation(version);
  await runNpm(invocation.args);
  const installedVersion = await getCometVersion();
  if (!installedVersion) {
    throw new Error("Comet installation failed: binary not found after npm install");
  }
  const binaryPath = await resolveCometPath();
  const compatibility = loadCometCompatibility();
  let compatUpdated = false;
  try {
    assertCometVersion(installedVersion, compatibility);
  } catch {
    updateCometCompatibility(installedVersion);
    compatUpdated = true;
  }
  return {
    command: "install",
    previousVersion,
    installedVersion,
    method: "npm",
    path: binaryPath ?? "comet",
    compatUpdated
  };
}
async function updateComet() {
  const latest = await fetchLatestNpmVersion();
  if (!latest) {
    throw new Error("Could not fetch latest Comet version from npm");
  }
  const current = await getCometVersion();
  if (current === latest) {
    return {
      command: "update",
      previousVersion: current,
      installedVersion: current,
      method: "detected",
      path: await resolveCometPath() ?? "comet",
      compatUpdated: false
    };
  }
  return installComet(latest);
}
async function verifyComet() {
  const binaryPath = await resolveCometPath();
  const exists2 = binaryPath !== null;
  const executable = exists2 ? (() => {
    try {
      const stats = existsSync(binaryPath);
      return stats;
    } catch {
      return false;
    }
  })() : false;
  const version = exists2 ? await getCometVersion(binaryPath) : null;
  let compatible = false;
  if (version) {
    try {
      const compatibility = loadCometCompatibility();
      assertCometVersion(version, compatibility);
      compatible = true;
    } catch {
      compatible = false;
    }
  }
  return {
    exists: exists2,
    executable,
    version,
    compatible,
    path: binaryPath
  };
}
function readCometCompatibility() {
  const compat = loadCometCompatibility();
  return {
    minVersion: compat.minVersion,
    ...compat.maxVersion ? { maxVersion: compat.maxVersion } : {}
  };
}
function updateCometCompatibility(version) {
  const manifestPath2 = new URL("../../comet-compat.yaml", import.meta.url);
  const content = readFileSync2(manifestPath2, "utf8");
  const lines = content.split("\n");
  let minUpdated = false;
  let maxUpdated = false;
  const updated = lines.map((line) => {
    const minMatch = /^(\s*minVersion:\s*).+/.exec(line);
    if (minMatch) {
      minUpdated = true;
      return `${minMatch[1]}${version}`;
    }
    const maxMatch = /^(\s*maxVersion:\s*).+/.exec(line);
    if (maxMatch) {
      maxUpdated = true;
      return `${maxMatch[1]}${version}`;
    }
    return line;
  });
  if (!minUpdated) {
    throw new Error("Could not find minVersion in comet-compat.yaml");
  }
  const newContent = updated.join("\n");
  writeFileSync(manifestPath2, newContent, "utf8");
}

// src/adapters/discovery.ts
import { join as join11 } from "node:path";

// src/adapters/manifest.ts
var skillCommands = [
  {
    id: "kata",
    slashCommand: "/kata",
    cli: "kata status",
    phase: "dispatch",
    summary: "Shows Kata task status and available next actions. Use when the user asks what to do next, wants Kata status, or needs workflow dispatch.",
    triggerScenarios: [
      "User asks what Kata phase or next action applies.",
      "Agent needs to resume an existing Kata task.",
      "Agent needs a safe entrypoint before choosing a phase skill."
    ],
    inputSignals: ["status", "next", "resume", "continue", "dispatch", "what now", "\u5F53\u524D\u9636\u6BB5", "\u4E0B\u4E00\u6B65"],
    outputGoals: ["Report current phase.", "Return the next /kata-* skill or CLI command.", "Surface wiki/model/gate orientation requirements."]
  },
  {
    id: "kata-open",
    slashCommand: "/kata-open",
    cli: "kata open --change <change-id> --isolation <mode> --development <mode> --review <mode>",
    phase: "open",
    summary: "Opens a governed Kata task/change using the Comet-compatible lifecycle. Use when starting a new change, feature, fix, or governed task.",
    triggerScenarios: [
      "User wants to start a new governed coding change.",
      "A task needs acceptance criteria and lifecycle state before design/build.",
      "Agent needs to convert an idea into a Kata/Comet-compatible change."
    ],
    inputSignals: ["start", "open", "new change", "feature", "fix", "hotfix", "tweak", "\u521B\u5EFA change", "\u5F00\u59CB\u4EFB\u52A1"],
    outputGoals: ["Create or inspect task state.", "Decide isolation, development, and review workflow choices in the skill conversation before invoking CLI.", "Keep /kata-design as the user-facing next step while Kata acknowledges Comet open internally."]
  },
  {
    id: "kata-design",
    slashCommand: "/kata-design",
    cli: "kata design --change <change-id>",
    phase: "design",
    summary: "Creates or refines the technical design and acceptance contract. Use when requirements, architecture, acceptance criteria, or project constraints need clarification before implementation.",
    triggerScenarios: [
      "User asks for technical design or implementation plan.",
      "Acceptance criteria or constraints are not yet concrete enough to build.",
      "Agent must align design with AGENTS.md and .llmwiki before editing code."
    ],
    inputSignals: ["design", "plan", "proposal", "architecture", "acceptance", "requirements", "\u65B9\u6848", "\u6280\u672F\u8BBE\u8BA1"],
    outputGoals: ["Produce a bounded design.", "Clarify acceptance criteria.", "Capture durable decisions into wiki candidates where useful."]
  },
  {
    id: "kata-build",
    slashCommand: "/kata-build",
    cli: "kata build --change <change-id>",
    phase: "implement",
    summary: "Implements the accepted task slice with hard verification evidence. Use when the design and acceptance contract are ready for code or documentation changes.",
    triggerScenarios: [
      "User asks to implement an approved Kata task.",
      "The current phase is plan/implement and acceptance criteria are available.",
      "Agent needs to make code/docs changes while collecting evidence."
    ],
    inputSignals: ["build", "implement", "code", "\u843D\u5730", "\u5B9E\u73B0", "\u4FEE\u6539\u4EE3\u7801", "\u6267\u884C\u8BA1\u5212"],
    outputGoals: ["Apply the smallest coherent change.", "Collect fresh test/build evidence.", "Capture implementation discoveries into .llmwiki when relevant."]
  },
  {
    id: "kata-review",
    slashCommand: "/kata-review",
    cli: "kata review --change <change-id>",
    phase: "review",
    summary: "Use when an independent Reviewer must record review findings without running Judge.",
    triggerScenarios: ["User asks for an independent code review before judgment.", "A completed implementation has fresh evidence."],
    inputSignals: ["review", "\u5BA1\u67E5", "code review"],
    outputGoals: ["Enter reviewer phase.", "Record review findings only.", "Prepare the task for an independent Judge."]
  },
  {
    id: "kata-judge",
    slashCommand: "/kata-judge",
    cli: "kata judge --change <change-id>",
    phase: "judge",
    summary: "Use when an independent Judge must evaluate a task after Reviewer has completed.",
    triggerScenarios: ["User asks for a final judgment after review.", "A task is already in reviewer phase."],
    inputSignals: ["judge", "\u88C1\u51B3", "final gate"],
    outputGoals: ["Evaluate acceptance against evidence and findings.", "Record a structured Judge result."]
  },
  {
    id: "kata-verify",
    slashCommand: "/kata-verify",
    cli: "kata verify --change <change-id>",
    phase: "verify",
    summary: "Runs reviewer/judge-oriented verification against task acceptance. Use when implementation needs review, CI/test evidence, judge gating, or repair scoping.",
    triggerScenarios: [
      "User asks to verify, review, audit, or judge a completed implementation.",
      "The current phase is hardVerify/review/judge.",
      "A previous judge/reviewer result requires scoped repair."
    ],
    inputSignals: ["verify", "review", "judge", "audit", "test", "CI", "\u68C0\u67E5", "\u5BA1\u67E5", "\u9A8C\u8BC1"],
    outputGoals: ["Evaluate acceptance criteria against evidence.", "Record reviewer/judge results.", "Return scoped repair instructions on failure."]
  },
  {
    id: "kata-archive",
    slashCommand: "/kata-archive",
    cli: "kata archive --change <change-id>",
    phase: "archive",
    summary: "Archives a completed task after evidence, review, and judge gates pass. Use when a Kata change is ready for final distillation, wiki capture, and archival.",
    triggerScenarios: [
      "User wants to close or archive a completed Kata task.",
      "Evidence, reviewer, and judge gates have passed.",
      "Agent needs to distill durable decisions into governed wiki records."
    ],
    inputSignals: ["archive", "finish", "complete", "distill", "close", "\u5F52\u6863", "\u6536\u5C3E", "\u6C89\u6DC0"],
    outputGoals: ["Move task to archive phase.", "Distill durable knowledge into .llmwiki/.kata wiki flow.", "Preserve evidence trail for future agents."]
  },
  {
    id: "kata-hotfix",
    slashCommand: "/kata-hotfix",
    cli: "kata hotfix --change <change-id> --isolation <mode> --development <mode> --review <mode>",
    phase: "hotfix",
    summary: "Runs the constrained hotfix path for behavior fixes without new capability design. Use when the user asks for a focused bug fix or urgent repair.",
    triggerScenarios: [
      "User reports a bug requiring a narrow behavior fix.",
      "No new capability or broad design is needed.",
      "Agent should skip expansive brainstorming and preserve repair scope."
    ],
    inputSignals: ["hotfix", "bug", "regression", "broken", "fix", "\u4FEE\u590D", "\u7D27\u6025", "\u95EE\u9898"],
    outputGoals: ["Decide isolation, development, and review workflow choices before starting the repair.", "Reproduce or identify the failure.", "Apply a minimal fix.", "Verify with regression evidence and archive when gates pass."]
  },
  {
    id: "kata-tweak",
    slashCommand: "/kata-tweak",
    cli: "kata tweak --change <change-id> --isolation <mode> --development <mode> --review <mode>",
    phase: "tweak",
    summary: "Runs the lightweight tweak path for local docs, prompt, copy, or configuration changes. Use when the user asks for a small non-bug adjustment.",
    triggerScenarios: [
      "User requests a small local improvement.",
      "Change is limited to docs, prompt text, copy, config, or minor workflow wording.",
      "Full feature design would be disproportionate."
    ],
    inputSignals: ["tweak", "small change", "docs", "prompt", "copy", "config", "\u5FAE\u8C03", "\u6587\u6863", "\u914D\u7F6E"],
    outputGoals: ["Decide isolation, development, and review workflow choices before starting the change.", "Apply a bounded lightweight change.", "Run proportional verification.", "Avoid expanding into unrelated implementation work."]
  },
  {
    id: "kata-wiki-enrich",
    slashCommand: "/kata-wiki-enrich",
    cli: "kata wiki task --kind enrich",
    phase: "wiki-enrich",
    summary: "Uses the coding agent LLM capability to enrich .llmwiki from deterministic Kata task packets. Use when initializing, enriching, linting, or distilling project wiki knowledge.",
    triggerScenarios: [
      "User asks to initialize or enrich .llmwiki from project docs.",
      "Agent needs to turn raw docs into durable concepts/entities/comparisons.",
      "Project knowledge should be captured without Kata binary calling model APIs."
    ],
    inputSignals: ["llmwiki", "wiki", "knowledge", "enrich", "distill", "\u521D\u59CB\u5316 wiki", "\u77E5\u8BC6\u6C89\u6DC0", "\u9879\u76EE\u4E0A\u4E0B\u6587"],
    outputGoals: ["Read deterministic wiki task packets.", "Synthesize project knowledge into governed wiki pages.", "Run lint/verify and keep code correctness responsibility with CI/tests/reviewer/judge."]
  },
  {
    id: "kata-collect",
    slashCommand: "/kata-collect",
    cli: "kata collect",
    phase: "collect",
    summary: "Use when collecting work back from another coding platform after delegated Kata implementation or repair.",
    triggerScenarios: [
      "User says another platform has finished implementation or repair.",
      "Agent needs to inspect returned evidence before review, judge, archive, or repair.",
      "Delegated work must be reconciled into the current branch and Kata lifecycle."
    ],
    inputSignals: ["collect", "return", "done in opencode", "\u56DE\u6536", "\u505A\u5B8C\u4E86", "\u4EA4\u56DE", "\u5BA1\u8BA1\u53E6\u4E00\u4E2A\u5E73\u53F0", "OpenCode \u5B8C\u6210"],
    outputGoals: ["Discover the returned task and evidence state.", "Ask the user to confirm the task/platform when ambiguous.", "Run reviewer/judge/archive or produce scoped repair instructions."]
  }
];
var commandManifest = skillCommands.map((command) => ({
  id: command.id,
  slashCommand: command.slashCommand,
  cli: command.cli,
  phase: command.phase,
  summary: command.summary
}));
var platformCapabilities = {
  codex: { skills: true, hooks: false, subAgents: true, modelSelection: true },
  "claude-code": { skills: true, hooks: true, subAgents: true, modelSelection: true },
  opencode: { skills: true, hooks: false, subAgents: true, modelSelection: true },
  cursor: { skills: true, hooks: false, subAgents: false, modelSelection: true },
  windsurf: { skills: true, hooks: true, subAgents: true, modelSelection: true },
  cline: { skills: true, hooks: false, subAgents: false, modelSelection: true },
  roocode: { skills: true, hooks: false, subAgents: false, modelSelection: true },
  gemini: { skills: true, hooks: true, subAgents: true, modelSelection: true },
  "github-copilot": { skills: true, hooks: true, subAgents: true, modelSelection: true },
  generic: { skills: true, hooks: false, subAgents: false, modelSelection: false }
};
function renderSkill(command, platform, options = {}) {
  const capabilities = platformCapabilities[platform];
  const guardMode = capabilities.hooks ? "skills plus platform hooks" : "CLI/CI-only";
  const responseLanguageContent = renderResponseLanguageContract(options.language);
  const phaseContent = command.id === "kata" ? `## Smart dispatch

Read the current task state and upstream artifacts to determine the next action:

\`\`\`bash
kata status  # show current phase and next skill
\`\`\`

For a specific change:

\`\`\`bash
kata status --change <change-id>
\`\`\`

With one active or same-branch task, the output includes a \`nextSkill\` field that tells you which /kata-* command can happen next. With multiple same-branch tasks, \`kata status\` returns \`candidates\` and a \`recommended\` action. Prefer the recommendation and ask the user for a short confirmation instead of asking them to remember command-line flags or change ids.

When \`phase === "dispatch" && candidates.length === 0 && recommended === null\`, do not display raw CLI diagnostics and do not ask for a task id, change id, or CLI flags. Tell the user: \u201C\u5F53\u524D\u5206\u652F\u6CA1\u6709\u6D3B\u8DC3\u7684 Kata \u4EFB\u52A1\u3002\u4F60\u60F3\u5F00\u542F\u4EC0\u4E48\u5DE5\u4F5C\uFF1F\u8BF7\u7528\u4E00\u53E5\u8BDD\u63CF\u8FF0\u76EE\u6807\uFF0C\u4F8B\u5982\u2018\u4FEE\u590D\u767B\u5F55\u8D85\u65F6\u2019\u6216\u2018\u65B0\u589E\u5BFC\u51FA\u529F\u80FD\u2019\u3002\u201D Wait for their answer. \u6536\u5230\u81EA\u7136\u8BED\u8A00\u76EE\u6807\u540E\uFF0C\u8FDB\u5165 /kata-open\uFF1B\u7531\u8BE5 Skill \u89E3\u91CA\u5E76\u786E\u8BA4\u9694\u79BB\u3001\u5F00\u53D1\u548C\u5BA1\u67E5\u65B9\u5F0F\uFF0C\u7136\u540E\u4F7F\u7528\u663E\u5F0F\u53C2\u6570\u8C03\u7528 \`kata open\`\u3002

Skill-first rule: treat slash-command Skills as the user interface and CLI commands as the deterministic execution layer inside the Skill. A user should be able to say \`/kata-build \u4FEE\u590D\u4EE3\u7801\u89C4\u8303\` or \`\u7EE7\u7EED\`; the Skill must discover the task, relation redirects, current phase, and next action before asking for missing choices. Do not ask the user to run \`kata build --change ...\` unless the host platform cannot execute shell commands.

Workflow control is task-scoped: Change is the target/scope container, Task is the smallest governed control unit, Artifact is evidence, and Step is agent-local execution detail. Do not drive build/review/judge from a Change directly; resolve the canonical Task first.

If a placeholder task or earlier change is covered by a more specific governed task, do not ask future agents to guess. Record the relation:

\`\`\`bash
kata tasks relate --from <source-task> --to <target-task> --type <covered_by|superseded_by|duplicate_of|merged_into> --reason "<why>"
\`\`\`

\`kata status --change <source-task>\` and \`kata orient --change <source-task>\` follow terminal relations and return \`relationRedirects\`.

For change-to-task, task-to-change, and change-to-change context, use the generic graph:

\`\`\`bash
kata relations add --from change:<change-id> --to task:<task-id> --type contains --reason "<why>"
kata relations add --from task:<task-id> --to change:<change-id> --type implements --reason "<why>"
kata relations show --id change:<change-id>
\`\`\`

Ownership and lineage edges enrich context. Only task-to-task terminal control edges should redirect \`status\`/\`orient\`.

Recommendations are derived from upstream platform outputs in this order: blocking \`review.json\` findings, failed \`judge.json\` repair scopes, failing evidence, failed \`verify.json\` repair scopes, \`hardVerify\` awaiting verify, \`review\` awaiting Judge, then ordinary build/design work.

If \`nextAction.requiresUserConfirmation=true\`, stop at that boundary. Do not invoke the next skill automatically. At \`implementation_gate\`, let the user choose current-platform execution, a low-tier delegated slice, or another platform. At \`review_gate\` and \`judge_gate\`, let the user use the host platform's own model selector before continuing. Kata does not configure, route, or verify host-platform models. \`archive_gate\` remains an explicit user archive decision.

The phase dispatch mapping is:

| Phase | Next Skill |
|-------|-----------|
| \`intake\` | \`/kata-design\` |
| \`plan\` | \`/kata-build\` |
| \`implement\` | \`/kata-build\` |
| \`hardVerify\` | \`/kata-verify\` |
| \`review\` | \`/kata-judge\` |
| \`judge\` / \`distill\` | \`/kata-archive\` |
| \`archive\` | \`/kata\` (dispatch) |

If running inside a platform that supports slash commands and \`nextAction.requiresUserConfirmation\` is not true, invoke the suggested /kata-* skill directly. Otherwise use:

\`\`\`bash
kata <design|build|review|judge|verify|archive|hotfix|tweak> --change <change-id>
\`\`\`

You can also check Comet directly:

\`\`\`bash
kata comet verify  # check if Comet is installed and compatible
kata comet version # show compatibility and installed versions
\`\`\`

## Wiki maintenance

The project wiki (\`.llmwiki/\` + \`.kata/wiki/\`) accumulates knowledge across tasks. Over time, sources drift, links break, and candidates pile up.

Periodically run:

\`\`\`bash
kata wiki lint
\`\`\`

Fix reported issues: broken wikilinks, orphaned pages, missing frontmatter. Re-run until clean.

## Ongoing discipline

- If you discover a decision, constraint, or norm **during** task work, capture it immediately via \`kata wiki ingest --from <source-path>\`. Don't wait for archive.
- If the user says \u201C\u8BB0\u4F4F\u8FD9\u4E2A\u201D, \u201C\u6C89\u6DC0\u5230 wiki\u201D, \u201C\u4EE5\u540E\u90FD\u6309\u8FD9\u4E2A\u201D, \u201Crecord this rule\u201D, \u201Cadd to wiki\u201D, or gives an equivalent durable-knowledge instruction, do **not** treat the chat transcript itself as authoritative. Create a concise source note under the task-owned path or docs/conventions, then ingest/register it as a governed Wiki candidate. Ask a short confirmation only when the instruction is ambiguous.
- Do not promote conversation-derived knowledge directly. It must remain a candidate until reviewed/promoted; stale ideas and temporary discussion should not pollute authoritative Wiki.
- Before starting a new task, run \`kata wiki orient\` to refresh context.` : command.id === "kata-open" || command.id === "kata-hotfix" || command.id === "kata-tweak" ? `## Skill-level workflow profile decision

\`${command.slashCommand}\` owns the user-facing decision flow. Do **not** rely on CLI TTY prompts for isolation, development, or review mode; many host platforms invoke the CLI non-interactively.

Before running \`kata ${command.phase}\`, resolve these three choices in the agent conversation:

1. Isolation mode:
   - \`current_worktree\` \u2014 use the current checkout; fastest, least isolated.
   - \`isolated_worktree\` \u2014 use/create an isolated worktree; preferred for larger implementation work.
   - \`git_flow\` \u2014 use a Git Flow branch: ordinary tasks use a feature branch; hotfix tasks use a hotfix branch.
   - \`user_decides\` \u2014 defer the isolation decision until implementation.
2. Development mode:
   - \`tdd\` \u2014 write focused failing tests first, then implement.
   - \`standard\` \u2014 implement directly with proportional tests.
3. Review mode:
   - \`std\` \u2014 standard independent review.
   - \`strict\` \u2014 stricter architecture/regression review.
   - \`security\` \u2014 security-focused review.

If the user explicitly provided these choices, use them. If not, present a concise recommendation and wait for confirmation before starting the task. A terse user confirmation such as \u201C\u786E\u8BA4\u201D may accept the recommended triple.

Then invoke the deterministic layer with explicit flags:

\`\`\`bash
${command.cli}
\`\`\`

Never let non-interactive CLI defaults silently choose the workflow profile.

## After profile confirmation

Do not ask the user to run \`/comet-open\` manually after \`/kata-open\`. When \`workflowProfile.comet.openStatus\` is \`required\`, \`/kata-design <task>\` performs the required acknowledgement before entering \`plan\`. Follow the returned next action after \`${command.slashCommand}\` completes.` : command.id === "kata-design" ? `## Knowledge capture during design

Design decisions often establish lasting constraints and norms. Capture them as you go:

1. After accepting or rejecting an approach, run:
   \`\`\`bash
   kata wiki ingest --from docs/decisions/<decision-log>.md
   \`\`\`
   This creates a \`candidate\` wiki record linking the decision to source evidence.

2. If you identify new rules, conventions, or architectural constraints, write a brief summary page and ingest it:
   \`\`\`bash
   kata wiki ingest --from .llmwiki/concepts/<topic>.md
   \`\`\`

3. These candidates are available to future tasks once promoted. The earlier you capture, the less context later agents will miss.` : command.id === "kata-build" ? `## Knowledge capture during implementation

Implementation reveals concrete constraints that design alone cannot foresee:

1. If you discover an unexpected limitation, workaround, or invariant, document it:
   \`\`\`bash
   kata wiki ingest --from src/<relevant-file>.ts
   \`\`\`

2. If you establish new conventions (naming, structure, error handling), write a short convention note and ingest it:
   \`\`\`bash
   kata wiki ingest --from docs/conventions/<topic>.md
   \`\`\`

3. Don't wait for archive. Mid-task capture means the knowledge is available for the verification phase and for future tasks.` : command.id === "kata-verify" ? `## Repair loop

If Judge returns FAIL for any acceptance criterion:

1. **Read** the \`repairScope\` in the judge result \u2014 it tells you which evidence categories failed and what to fix:
   - \`missing_test_evidence\` \u2014 write a test for the acceptance criterion
   - \`revision_superseded\` \u2014 a declared task-owned path changed after sealing; rebuild to create the next revision
   - \`stale_evidence\` \u2014 legacy repository-scoped evidence changed after collection; rebuild
   - \`failing_evidence\` \u2014 tests or checks failed
   - \`blocking_review_finding\` \u2014 a reviewer blocked this acceptance

2. **Fix only the scoped files** \u2014 Judge reports which acceptance criteria failed. Don't touch unrelated code. Unrelated changes will be rejected by \`enforceRepairScope\`.

3. **Rebuild** \u2014 first repair and test the scoped implementation, then collect fresh evidence:
   \`\`\`bash
   kata build --change <taskId> --seal
   \`\`\`

4. **Re-verify**:
   \`\`\`bash
   kata verify --change <taskId>
   \`\`\`

## Wiki closure is a governance action, not an implementation repair

When Verify reports implementationReady: true, governanceReady: false, and reason: resolve_wiki_closure, do **not** run build or modify implementation. Read the task acceptance, design artifacts, changed source, and existing Wiki candidates, then decide the closure yourself.

- Choose \`captured\` when the task establishes a reusable capability, architecture rule, workflow constraint, or domain convention. Create and register the grounded candidate first, then reference its id.
- Choose \`not_applicable\` when the task is a local mechanical change and establishes no reusable project knowledge.
- Only ask the user when the task artifacts are genuinely ambiguous or contradictory. Do not invoke bare \`kata wiki closure\` and make the user classify an otherwise clear task.

After making the decision, record it non-interactively and re-verify:

\`\`\`bash
kata wiki closure --task <taskId> --decision captured --reason "<durable rule>" --candidate <wiki-id>
kata wiki closure --task <taskId> --decision not_applicable --reason "<why no reusable knowledge changed>"
kata verify --change <taskId>
\`\`\`

The deferred decision intentionally blocks review and archive, but it does not mean acceptance criteria, tests, or evidence failed.

## Escalation

If repair fails repeatedly, use the host platform's own selector to choose a more capable model before continuing. Kata does not prescribe or record that choice.` : command.id === "kata-archive" ? `## Knowledge distillation

The \`kata archive\` command transitions the task from \`distill\` to \`archive\` phase \u2014 a **deterministic** CLI operation. It does NOT generate wiki content. That is your job as the agent.

After archive completes, read the returned diagnostics, then:

1. **Read** the task artifacts:
   - \`.kata/tasks/<taskId>/task.json\` \u2014 acceptance criteria and title
   - \`.kata/tasks/<taskId>/judge.json\` \u2014 judge PASS/FAIL per acceptance
   - \`.kata/tasks/<taskId>/review.json\` \u2014 review findings
   - \`.kata/evidence/<taskId>-*.json\` \u2014 evidence envelopes
   - Project diff or implementation files

2. **Synthesize** a wiki entry capturing:
   - What decisions were made
   - What constraints or norms were established
   - Why certain approaches were chosen over alternatives
   - Any new rules, conventions, or patterns the project should adopt

3. **Write** the wiki record via CLI:
   \`\`\`bash
   kata wiki ingest --from .kata/tasks/<taskId>/task.json
   \`\`\`

4. **Promote** (optional):
   \`\`\`bash
   kata wiki promote wiki-<taskId> --by <your-id> --role distiller
   \`\`\`

5. **Deactivate active hook task**:
   \`\`\`bash
   kata hooks deactivate
   \`\`\`
   This prevents the archived task from continuing to scope future writes.` : command.id === "kata-wiki-enrich" ? `## Coding-agent Wiki enrichment

This skill is where LLM work happens. Kata binary does **not** call model provider APIs for Wiki enrichment; it emits a deterministic task packet and the current coding agent performs reading, synthesis, and file edits.

1. Get the task packet:
   \`\`\`bash
   kata wiki task --kind enrich --from docs
   \`\`\`

   Do not guess Wiki CLI subcommands. Run \`kata wiki --help\` when discovery is needed. \`kata wiki propose\` is only a compatibility alias for the enrich task packet; it neither creates a governed record nor promotes knowledge. Use \`kata wiki candidate\` to inspect pending records.

2. Read every path in \`requiredReads\`, especially:
   - \`.llmwiki/SCHEMA.md\`
   - \`.llmwiki/index.md\`
   - \`.llmwiki/log.md\`
   - \`.llmwiki/raw/docs/**\`

3. **Ground every claim in source code.** \`raw/docs/\` are historical design docs \u2014 they may be outdated or differ from what was built. Before writing a page, read the actual source under \`packages/\` (\`ports/\`, \`domains/\`, \`infrastructure/\`, \`adapters/\`) to verify each architecture claim, method signature, file path, and table name. If source and design doc disagree, source wins.

4. As the coding agent, synthesize durable project knowledge:
   - concepts: architecture, workflow, invariants, conventions
   - entities: modules, services, commands, schemas
   - comparisons: alternatives and tradeoffs
   - queries: reusable answers worth filing
   - conversation-derived decisions only when the user explicitly asked to remember/capture them, or when they are stable task outcomes backed by files/evidence

5. Conversation capture covenant:
   - Trigger on clear user intents such as \u201C\u8BB0\u4F4F\u8FD9\u4E2A\u201D, \u201C\u6C89\u6DC0\u5230 wiki\u201D, \u201C\u4EE5\u540E\u90FD\u6309\u8FD9\u4E2A\u201D, \u201Crecord this rule\u201D, \u201Cadd to wiki\u201D.
   - Convert the conversation point into a short source note with date, task id, source context, rule/decision, rationale, and scope.
   - Prefer task-owned notes under \`.kata/tasks/<task-id>/wiki-notes/\` or durable notes under \`docs/conventions/\`; then ingest/register them as candidates.
   - If the point is ambiguous, ask one short confirmation question before writing.
   - Never promote directly from chat; candidates need normal review/promotion.

6. Write only to task packet \`writeTargets\` such as \`.llmwiki/concepts/\`, \`.llmwiki/entities/\`, and \`.llmwiki/comparisons/\`. Do not edit \`.llmwiki/raw/\` manually.

7. Run deterministic checks:
   \`\`\`bash
   kata wiki lint
   kata wiki verify
   \`\`\`

8. Register synthesized pages as governed candidate records:
   \`\`\`bash
   kata wiki register
   \`\`\`

9. Complete the mandatory knowledge-closure decision before \`/kata-verify\` and \`/kata-archive\`. Decide it yourself from the task design, acceptance, source changes, and candidate records: reusable capability/rule/convention means \`captured\`; a local mechanical change with no durable knowledge means \`not_applicable\`. Create and register a grounded candidate before choosing \`captured\`. Only ask the user when those artifacts are genuinely ambiguous or contradictory. Never invoke bare \`kata wiki closure\` merely to make the user classify the task; always pass the selected decision and concrete reason:
   \`\`\`bash
   kata wiki closure --task <task-id> --decision captured --reason "<durable rule>" --candidate <wiki-id>
   kata wiki closure --task <task-id> --decision not_applicable --reason "<why no reusable knowledge changed>"
   \`\`\`

The Wiki helps future agents understand the project. It does not prove code correctness; CI, tests, Reviewer, and Judge own correctness.` : command.id === "kata-delegate" ? `## Interactive delegation

Do not require the user to pass command-line parameters. Treat natural language as the primary interface.

1. Discover candidate tasks:
   - Run \`kata status\`.
   - If the user mentioned a change by name or number, inspect that candidate.
   - If multiple same-branch tasks are plausible, present 2\u20135 options and ask the user to confirm or type a task id.

2. Infer the target role from phase:
   - \`plan\` or \`implement\` \u2192 \`implementer\`
   - \`hardVerify\` \u2192 \`reviewer\`
   - \`review\` \u2192 \`judge\`
   - \`judge\` or \`distill\` \u2192 \`distiller\`
   Ask for confirmation if the user intent conflicts with the phase.

3. Discover platforms with \`kata discover\`. Recommend one platform based on role and model policy, but ask the user to confirm when more than one suitable platform is available. Let the user type a custom platform name if needed.

4. Ensure the task is ready for delegation:
   - If missing, open it.
   - If in \`intake\`, design it.
   - Stop and ask before creating broad acceptance criteria that materially change scope.

5. Create and verify the packet:
   \`\`\`bash
   kata handoff create --task <task-id> --from <current-role> --to <target-role>
   kata handoff verify --task <task-id> --id <handoff-id>
   \`\`\`

6. Generate a target-agent prompt that says:
   - verify/show/acknowledge the handoff
   - read every \`requiredReads\` path
   - obey \`allowedWrites\` and guard instructions
   - run the matching \`/kata-*\` skill or CLI phase
   - stop before phases outside the delegated role

7. Return the prompt and next action to the user.` : command.id === "kata-collect" ? `## Interactive collection

Do not ask the user for CLI parameters first. Discover the likely returned task, inspect upstream outputs, then ask for confirmation.

1. Run \`kata collect\` first. It returns same-branch candidates, upstream summaries, and a \`recommended\` task/action.
2. If the recommendation says \`repair_blocking_review_findings\`, \`repair_failed_judge\`, or \`repair_failing_evidence\`, ask the user to confirm repair and then act as implementer.
3. If the recommendation says \`review_fresh_implementation\`, ask the user to confirm review and then run reviewer flow.
4. If the recommendation says \`judge_reviewed_change\`, ask the user to confirm Judge and then run judge flow.
5. Read task state, review/judge/evidence files, and relevant handoff receipts before editing or judging.
6. Return only the recommended next slash command or handoff prompt. Never run review, judge, archive, or any other next phase from collection.
7. If Judge fails, return the repair scope and a ready-to-send prompt for the delegated platform.` : "";
  const automationContent = ["kata-build", "kata-review", "kata-judge", "kata-verify", "kata-archive"].includes(command.id) ? `## Skill automation contract

The Skill MUST run these commands itself. Do not ask the user to copy or type them unless the platform cannot execute shell commands.

Skill-first means the slash command is the agent interface and the CLI is the internal execution layer. The user may provide no task id, a natural-language task hint, or only "continue"; the Skill must discover candidates and ask for a short confirmation only when needed.

1. Run \`kata status\` to read the active or current-branch discovered task, relation redirects, phase, next skill, task title, acceptance criteria, and context summary.
2. Do not require the user to pass parameters. Resolve the task id from active task, same-branch task, relation redirects, or the \`recommended\` task/action from \`kata status\` or \`kata collect\`. If multiple plausible tasks remain, show concise options and ask the user to choose or type a value.
3. Resolve role and task-kind from phase and user intent; if ambiguous, present recommended options and ask for confirmation. Do not default across trust boundaries without confirmation.
4. Run \`kata orient\` without \`--change\` when using the active/single discovered task, or with \`--change <id>\` after the user confirms a task id. Parse its relation redirects, handoff id, state, task, requiredReads, nextAction, and context fields.
5. Run kata handoff verify for that id; stop on an invalid result.
6. Read every requiredReads path from the packet.
7. Run kata handoff acknowledge with platform ${platform} and the current role.
8. ${command.id === "kata-build" ? "For build, first complete TDD and focused tests (\u5148\u5B8C\u6210 TDD \u4E0E\u805A\u7126\u6D4B\u8BD5). Do not seal evidence before coding (\u4E0D\u8981\u5728\u7F16\u7801\u524D\u5C01\u5B58\u8BC1\u636E). For current_worktree tasks, declare task-owned files with `--owned-path <path>` before sealing. `--seal` creates one immutable revision; `revision_superseded` means an owned file changed and requires Build for a new revision, while workspace drift outside ownership does not invalidate the sealed revision." : "Run this Skill's phase command and collect normal evidence. The next phase creates a fresh packet."}
9. After the phase command returns, read \`completion.userMessage\` first, then \`nextAction.slashCommand\`, \`nextAction.cliCommand\`, \`recommended.reason\`, and \`askUser\` from the command result. Always tell the user the current phase and the next recommended operation. For every successful phase command\u2014especially \`/kata-build <task> --seal\`\u2014the final user-facing response MUST end with \`completion.userMessage\` verbatim. This is not optional: never finish with only a test summary, and never wait for the user to ask \u201Cwhat next\u201D. If \`completion\` is absent, explicitly render the current phase and \`nextAction.slashCommand\`. Prefer the slash command, for example \`/kata-verify <change-id>\`; show the CLI command only as fallback.
10. Stop after this Skill's own phase command. A Skill invocation has exactly one phase-command authority: Build may invoke only \`kata build\`; it MUST NOT invoke verify, review, judge, archive, or any other \`/kata-*\` command after Build returns. The same rule applies to every phase Skill: render its next action for the user, then end the invocation. If the returned \`nextAction.requiresUserConfirmation=true\`, do not invoke the next /kata-* skill. At model trust boundaries, wait for the user to use the host platform's own selector before continuing.

Do not create a receipt for read-only search, explanation, or orientation-only work.` : "";
  return `---
name: ${command.id}
description: ${command.summary}
---

# ${command.slashCommand}

platform: ${platform}

${responseLanguageContent ? `${responseLanguageContent}

` : ""}
Use this skill to inspect the Kata ${command.phase} workflow entrypoint.

## Skill-first operating rule

Prefer the \`${command.slashCommand}\` Skill as the human-facing interface. Use \`${command.cli}\` as the deterministic fallback inside the Skill or in non-interactive scripts. If the user passes an explicit task id (e.g. "/kata-build my-task"), use it as the immutable anchor for all subsequent operations; do not re-discover via \`kata status\` or same-branch resolution. If the user gives a short instruction, natural-language hint, or no parameters, discover the active/same-branch task with \`kata status\`, follow relation redirects, and ask for a concise confirmation only when multiple choices remain.

## Startup checklist

Before doing task work, run the project orientation command:

\`\`\`bash
kata status
kata orient --role <designer|implementer|reviewer|judge|distiller> --platform ${platform} --task-kind <read|implementation|security>
kata hooks activate --change <change-id> --role <designer|implementer|reviewer|judge|distiller> --platform ${platform}
\`\`\`

Treat skill use as an interactive agent workflow, not a parameter-only command. First discover the active or same-branch task and any relation redirects; if the task, role, task kind, or target platform is ambiguous, present concise options and ask the user to confirm or type a value. Do not make the user remember command-line flags. After confirmation, run \`kata orient\` with the resolved values, then read the returned task, state, context, required files, guard instructions, relation redirects, and next skill before editing. The hook activation links platform write hooks to the active Kata task so phase/role scope is enforced while you work.

## Phase-boundary pause

Treat \`nextAction.requiresUserConfirmation=true\` as a hard stop. Do not invoke the next /kata-* skill automatically. At model trust boundaries, stop so the user can use the host platform's own model selector before continuing. Kata has no model routing configuration or route artifact.

This is mandatory at trust boundaries:

- \`implementation_gate\`: stop after design and before the first build; a platform-neutral handoff packet is already available for any receiving platform.
- \`review_gate\`: stop after /kata-verify passes before /kata-review.
- \`judge_gate\`: stop after review before /kata-judge.
- \`archive_gate\`: stop after judge before /kata-archive.

## CodeGraph-assisted code search

After reading required context and before broad file scans, use CodeGraph when code understanding, impact analysis, or test targeting is needed:

\`\`\`bash
kata codegraph status
kata codegraph explore "<feature, symbol, module, or error>"
kata codegraph impact "<symbol-or-file>"
kata codegraph affected <changed-file>...
\`\`\`

Use CodeGraph to find likely source files, call paths, dependents, and affected tests. Then verify with direct file reads and focused \`rg\` searches before editing or reviewing. If CodeGraph is unavailable or stale, note the fallback and use \`rg\` plus requiredReads; do not block the workflow solely on CodeGraph.

## Portable context handoff

Before accepting work from another agent or platform, create or verify the canonical repository packet, read every path in its requiredReads field, then acknowledge the packet with the actual platform and role.

Run kata handoff verify --task <change-id> --id <handoff-id>, kata handoff show --task <change-id> --id <handoff-id>, then kata handoff acknowledge --task <change-id> --id <handoff-id> --platform ${platform} --role <role>.

The packet's allowed writes and guard instructions are authoritative. Model selection belongs to the host platform and never bypasses CI, tests, Reviewer, or Judge.

${automationContent}

\`\`\`json kata-command-manifest
${JSON.stringify(commandManifest.find((entry) => entry.id === command.id), null, 2)}
\`\`\`

## Trigger scenarios

${formatBullets(command.triggerScenarios)}

## Input signals

Keywords and intents that should trigger this skill:

${formatBullets(command.inputSignals.map((signal) => `\`${signal}\``))}

## Output goals

${formatBullets(command.outputGoals)}

## Invocation

\`\`\`bash
${command.cli}
\`\`\`

The invocation is the deterministic CLI fallback for scripts and CI. In normal agent use, prefer conversation: discover candidates, recommend defaults, ask for confirmation, then run the resolved command.

## Guard enforcement

guard enforcement: ${guardMode}

## Host model selection

Kata does not configure or route host-platform models. If this phase needs a different model, use the host platform's own selector before continuing; model choice is outside Kata state and does not create a route artifact.

${platform === "opencode" ? "OpenCode\uFF1A\u5982\u9700\u5207\u6362\u6A21\u578B\uFF0C\u5148\u6267\u884C `/models` \u5E76\u5728\u5176\u4EA4\u4E92\u754C\u9762\u5B8C\u6210\u9009\u62E9\uFF0C\u518D\u8FD0\u884C\u672C\u6B21\u59D4\u6258\u7684 Kata \u547D\u4EE4\u3002" : "\u8BF7\u5728\u5F53\u524D\u5E73\u53F0\u7684\u6A21\u578B\u9009\u62E9\u5668\u6216\u5E73\u53F0\u914D\u7F6E\u4E2D\u5B8C\u6210\u5207\u6362\uFF0C\u7136\u540E\u7EE7\u7EED\u672C\u6B21 Kata \u547D\u4EE4\u3002"}

${phaseContent}`;
}
function formatBullets(items) {
  return items.map((item) => `- ${item}`).join("\n");
}
function renderResponseLanguageContract(language) {
  if (language === "zh") {
    return `## Response language

\u6240\u6709\u9762\u5411\u7528\u6237\u7684\u81EA\u7136\u8BED\u8A00\u54CD\u5E94\u5FC5\u987B\u4F7F\u7528\u4E2D\u6587\u3002\u4EE3\u7801\u3001\u547D\u4EE4\u3001\u6587\u4EF6\u8DEF\u5F84\u3001API \u540D\u79F0\u3001\u65E5\u5FD7\u548C\u534F\u8BAE\u5B57\u6BB5\u53EF\u4EE5\u4FDD\u7559\u539F\u6587\u3002`;
  }
  if (language === "en") {
    return `## Response language

All user-facing natural-language responses must be written in English. Code, commands, file paths, API names, logs, and protocol fields may remain in their original form.`;
  }
  return "";
}

// src/adapters/ownership.ts
import { createHash as createHash5, randomUUID as randomUUID4 } from "node:crypto";
import { mkdir as mkdir7, readFile as readFile9, rename as rename2, rm as rm3, stat as stat4, writeFile as writeFile7 } from "node:fs/promises";
import { basename as basename3, dirname as dirname6, join as join10 } from "node:path";

// src/wiki/llmwiki.ts
init_store();
init_record();
import { createHash as createHash4 } from "node:crypto";
import { mkdir as mkdir6, readFile as readFile8, readdir as readdir4, rm as rm2, stat as stat3, writeFile as writeFile6 } from "node:fs/promises";
import { dirname as dirname5, extname, isAbsolute, join as join9, relative as relative3, resolve as resolve4 } from "node:path";
var defaultWikiPath = ".llmwiki";
var sourceExtensions = /* @__PURE__ */ new Set([".md", ".mdx", ".txt"]);
var requiredDirectories = [
  "raw/docs",
  "raw/articles",
  "raw/papers",
  "raw/assets",
  "entities",
  "concepts",
  "comparisons",
  "queries"
];
async function initLlmWiki(input) {
  const root = resolve4(input.root ?? process.cwd());
  const wikiPath = normalizeWikiPath(input.wikiPath);
  const wikiRoot = resolveWikiRoot(root, wikiPath);
  const fromRoot = resolve4(root, input.from);
  const sourceFiles = await collectSourceFiles(fromRoot);
  const importedSources = [];
  for (const name of ["AGENTS.md"]) {
    const rootPath = join9(root, name);
    try {
      await stat3(rootPath);
      if (!sourceFiles.includes(rootPath)) sourceFiles.push(rootPath);
    } catch {
    }
  }
  await mkdir6(wikiRoot, { recursive: true });
  for (const directory of requiredDirectories) {
    await mkdir6(join9(wikiRoot, directory), { recursive: true });
  }
  for (const sourceFile of sourceFiles) {
    const relativeToSourceRoot = sourceFile.startsWith(fromRoot) ? relative3(fromRoot, sourceFile).replaceAll("\\", "/") : relative3(root, sourceFile).replaceAll("\\", "/");
    const destination = `raw/docs/${relativeToSourceRoot}`;
    const body = await readFile8(sourceFile, "utf8");
    const sourcePath = normalizeSourcePath(root, sourceFile);
    const rawContent = renderRawSource(sourcePath, body);
    await mkdir6(dirname5(join9(wikiRoot, destination)), { recursive: true });
    await writeFile6(join9(wikiRoot, destination), rawContent, "utf8");
    importedSources.push(destination);
  }
  const now = (/* @__PURE__ */ new Date()).toISOString();
  await writeFile6(join9(wikiRoot, "SCHEMA.md"), renderSchema(now), "utf8");
  await writeFile6(join9(wikiRoot, "index.md"), renderIndex(importedSources, now), "utf8");
  await writeFile6(join9(wikiRoot, "log.md"), renderLog(importedSources, now), "utf8");
  return {
    wikiPath,
    importedSources,
    schemaPath: "SCHEMA.md",
    indexPath: "index.md",
    logPath: "log.md"
  };
}
async function orientLlmWiki(input = {}) {
  const root = resolve4(input.root ?? process.cwd());
  const wikiPath = normalizeWikiPath(input.wikiPath);
  const wikiRoot = resolveWikiRoot(root, wikiPath);
  const schema = await readFile8(join9(wikiRoot, "SCHEMA.md"), "utf8");
  const index = await readFile8(join9(wikiRoot, "index.md"), "utf8");
  const log = await readFile8(join9(wikiRoot, "log.md"), "utf8");
  const recentLog = log.trim().split("\n").slice(-30).join("\n");
  return { wikiPath, schema, index, recentLog };
}
async function ingestLlmWiki(input) {
  const root = resolve4(input.root ?? process.cwd());
  const wikiPath = normalizeWikiPath(input.wikiPath);
  const wikiRoot = resolveWikiRoot(root, wikiPath);
  const fromPath = resolve4(root, input.from);
  const sourceFiles = await collectSourceFiles(fromPath);
  const importedSources = [];
  const pagesWritten = [];
  const governedRecords = [];
  for (const sourceFile of sourceFiles) {
    const slug = slugify(sourceFile.replace(/\.[^.]+$/, "").split(/[\\/]/).pop() ?? "source");
    const destination = `raw/docs/${slug}${extname(sourceFile).toLowerCase() || ".md"}`;
    const body = await readFile8(sourceFile, "utf8");
    await mkdir6(dirname5(join9(wikiRoot, destination)), { recursive: true });
    await writeFile6(join9(wikiRoot, destination), renderRawSource(normalizeSourcePath(root, sourceFile), body), "utf8");
    importedSources.push(destination);
    const pagePath = `concepts/${slug}.md`;
    const recordId = `llmwiki-${slug}`;
    const page = renderSummaryPage({
      title: titleFromMarkdown(body) ?? titleFromSlug(slug),
      slug,
      recordId,
      rawSource: destination,
      body
    });
    await mkdir6(dirname5(join9(wikiRoot, pagePath)), { recursive: true });
    await writeFile6(join9(wikiRoot, pagePath), page, "utf8");
    pagesWritten.push(pagePath);
    await upsertIndexEntry(wikiRoot, "Concepts", pagePath, oneLineSummary(body));
    await appendLog(wikiRoot, `ingest | ${slug}${extname(sourceFile).toLowerCase() || ".md"}`, [
      `- Imported: ${destination}`,
      `- Updated: ${pagePath}`,
      `- Governed record: ${recordId}`
    ]);
    const rawContent = await readFile8(join9(wikiRoot, destination), "utf8");
    const pageContent = await readFile8(join9(wikiRoot, pagePath), "utf8");
    await writeWikiRecord(root, {
      id: recordId,
      statement: oneLineSummary(body),
      scope: [pagePath],
      kind: "llmwiki-summary",
      sourceRefs: [`.llmwiki/${destination}`, `.llmwiki/${pagePath}`],
      sourceHashes: {
        [`.llmwiki/${destination}`]: computeFileHash(rawContent),
        [`.llmwiki/${pagePath}`]: computeFileHash(pageContent)
      },
      validationTaskId: "llmwiki-ingest",
      evidenceIds: [`llmwiki-${sha256(rawContent).slice(0, 12)}`],
      status: "candidate",
      lastVerifiedAt: (/* @__PURE__ */ new Date()).toISOString(),
      createdAt: (/* @__PURE__ */ new Date()).toISOString(),
      updatedAt: (/* @__PURE__ */ new Date()).toISOString()
    });
    governedRecords.push(recordId);
  }
  return { wikiPath, importedSources, pagesWritten, governedRecords };
}
async function queryLlmWiki(input) {
  const root = resolve4(input.root ?? process.cwd());
  const wikiPath = normalizeWikiPath(input.wikiPath);
  const wikiRoot = resolveWikiRoot(root, wikiPath);
  await orientLlmWiki({ root, wikiPath });
  const pages = await collectWikiPages(wikiRoot);
  const scored = await Promise.all(
    pages.map(async (page) => {
      const content = await readFile8(join9(wikiRoot, page), "utf8");
      return { page, content, score: scoreContent(input.query, content, page) };
    })
  );
  const matches = scored.filter((item) => item.score > 0).sort((a, b) => b.score - a.score).slice(0, 5);
  const citations = matches.map((item) => item.page);
  const answer = renderQueryAnswer(input.query, matches);
  let filedPath;
  if (input.file) {
    filedPath = `queries/${slugify(input.query)}.md`;
    await mkdir6(dirname5(join9(wikiRoot, filedPath)), { recursive: true });
    await writeFile6(join9(wikiRoot, filedPath), renderQueryPage(input.query, answer, citations), "utf8");
    await upsertIndexEntry(wikiRoot, "Queries", filedPath, `Filed answer for: ${input.query}`);
  }
  await appendLog(wikiRoot, `query | ${input.query}`, [
    `- Citations: ${citations.join(", ") || "none"}`,
    ...filedPath ? [`- Filed: ${filedPath}`] : []
  ]);
  return { wikiPath, query: input.query, answer, citations, ...filedPath ? { filedPath } : {} };
}
async function buildLlmWikiTask(input) {
  const root = resolve4(input.root ?? process.cwd());
  const wikiPath = normalizeWikiPath(input.wikiPath);
  const wikiRoot = resolveWikiRoot(root, wikiPath);
  const wikiRawDocsRoot = join9(wikiRoot, "raw/docs");
  const wikiSourceFiles = await collectSourceFiles(wikiRawDocsRoot);
  const sourceFiles = wikiSourceFiles.length > 0 ? wikiSourceFiles : input.from ? await collectSourceFiles(resolve4(root, input.from)) : [];
  const rawReads = sourceFiles.map((sourceFile) => normalizeTaskRead(root, wikiRoot, wikiPath, sourceFile)).filter((path) => path.startsWith(`${wikiPath}/`) || path.startsWith(".llmwiki/")).sort((left, right) => left.localeCompare(right));
  return {
    command: "wiki task",
    kind: input.kind,
    wikiPath,
    requiredReads: [
      `${wikiPath}/SCHEMA.md`,
      `${wikiPath}/index.md`,
      `${wikiPath}/log.md`,
      ...rawReads
    ],
    writeTargets: [
      `${wikiPath}/concepts/`,
      `${wikiPath}/entities/`,
      `${wikiPath}/comparisons/`,
      `${wikiPath}/queries/`
    ],
    instructions: instructionsForWikiTask(input.kind),
    followupCommands: [
      "kata wiki lint --root <root>",
      "kata wiki verify --root <root>",
      "kata wiki register --root <root>",
      "kata orient --change <change-id> --role distiller --task-kind read"
    ]
  };
}
var wikiPageDirectories = ["concepts", "entities", "comparisons", "queries"];
async function registerWikiPages(input = {}) {
  const root = resolve4(input.root ?? process.cwd());
  const wikiPath = normalizeWikiPath(input.wikiPath);
  const wikiRoot = resolveWikiRoot(root, wikiPath);
  const existing = new Set(await collectExistingRecordIds(root));
  const registered = [];
  let skipped = 0;
  for (const dir of wikiPageDirectories) {
    const dirPath = join9(wikiRoot, dir);
    const files = await collectSourceFiles(dirPath);
    for (const file of files) {
      const relativePath = relative3(wikiRoot, file).replaceAll("\\", "/");
      const recordId = `llmwiki-${relativePath.replace(/[/\\]/g, "-").replace(/\.[^.]+$/, "")}`;
      if (existing.has(recordId)) {
        skipped += 1;
        continue;
      }
      const content = await readFile8(file, "utf8");
      const frontmatter = parsePageFrontmatter(content);
      const statement = frontmatter ? Object.values(frontmatter).join("; ") : oneLineSummary(content);
      await writeWikiRecord(root, {
        id: recordId,
        statement,
        scope: [`.llmwiki/${relativePath}`],
        kind: "llmwiki-summary",
        sourceRefs: [`.llmwiki/${relativePath}`],
        sourceHashes: { [`.llmwiki/${relativePath}`]: computeFileHash(content) },
        validationTaskId: "llmwiki-register",
        evidenceIds: [`llmwiki-${sha256(content).slice(0, 12)}`],
        status: "candidate",
        lastVerifiedAt: (/* @__PURE__ */ new Date()).toISOString(),
        createdAt: (/* @__PURE__ */ new Date()).toISOString(),
        updatedAt: (/* @__PURE__ */ new Date()).toISOString()
      });
      registered.push(relativePath);
    }
  }
  await appendLog(wikiRoot, `register | ${registered.length} pages`, registered.map((p) => `- ${p}`));
  return { command: "wiki register", wikiPath, registered: registered.length, skipped, pages: registered };
}
async function collectExistingRecordIds(root) {
  const wikiDir = join9(root, ".kata/wiki");
  try {
    const entries = await readdir4(wikiDir);
    return entries.filter((e) => e.endsWith(".json")).map((e) => e.replace(/\.json$/, ""));
  } catch {
    return [];
  }
}
async function rebuildLlmWiki(input = {}) {
  const root = resolve4(input.root ?? process.cwd());
  const wikiPath = normalizeWikiPath(input.wikiPath);
  const wikiRoot = resolveWikiRoot(root, wikiPath);
  let cleanedPages = 0;
  let cleanedRecords = 0;
  for (const dir of wikiPageDirectories) {
    const dirPath = join9(wikiRoot, dir);
    try {
      const files = await readdir4(dirPath);
      for (const file of files) {
        await rm2(join9(dirPath, file), { force: true });
        cleanedPages += 1;
      }
    } catch {
    }
  }
  const wikiDir = join9(root, ".kata/wiki");
  try {
    const files = await readdir4(wikiDir);
    for (const file of files) {
      if (file.endsWith(".json")) {
        await rm2(join9(wikiDir, file), { force: true });
        cleanedRecords += 1;
      }
    }
  } catch {
  }
  const taskPacketPath = join9(root, ".kata/tasks/wiki-enrich/task-packet.json");
  const wrapDir = join9(root, ".kata/tasks/wiki-enrich");
  await mkdir6(wrapDir, { recursive: true });
  const enrichTask = await buildLlmWikiTask({ root, kind: "enrich" });
  await writeFile6(taskPacketPath, `${JSON.stringify(enrichTask, null, 2)}
`);
  await appendLog(wikiRoot, "rebuild | wiki cleaned and task-packet regenerated", [
    `- Pages removed: ${cleanedPages}`,
    `- Records removed: ${cleanedRecords}`,
    `- Task packet: ${taskPacketPath}`
  ]);
  return { command: "wiki rebuild", wikiPath, cleaned: { pages: cleanedPages, records: cleanedRecords }, taskPacketPath };
}
async function lintLlmWiki(input = {}) {
  const root = resolve4(input.root ?? process.cwd());
  const wikiPath = normalizeWikiPath(input.wikiPath);
  const wikiRoot = resolveWikiRoot(root, wikiPath);
  const issues = [];
  for (const path of ["SCHEMA.md", "index.md", "log.md", ...requiredDirectories]) {
    try {
      await stat3(join9(wikiRoot, path));
    } catch {
      issues.push({
        severity: path.includes(".") ? "critical" : "high",
        code: "missing_required_path",
        path,
        message: `Required LLM Wiki path is missing: ${path}`
      });
    }
  }
  const rawSources = await collectSourceFiles(join9(wikiRoot, "raw"));
  for (const rawSource of rawSources) {
    const rawRelative = relative3(wikiRoot, rawSource).replaceAll("\\", "/");
    const content = await readFile8(rawSource, "utf8");
    const frontmatter = parseFrontmatter(content);
    if (!frontmatter) {
      issues.push({
        severity: "high",
        code: "raw_source_hash_mismatch",
        path: rawRelative,
        message: `Raw source is missing immutable source frontmatter: ${rawRelative}`
      });
      continue;
    }
    const expectedHash = frontmatter.sha256;
    const currentHash = sha256(frontmatter.body);
    if (!expectedHash || expectedHash !== currentHash) {
      issues.push({
        severity: "high",
        code: "raw_source_hash_mismatch",
        path: rawRelative,
        message: `Raw source hash changed: ${rawRelative}`
      });
    }
  }
  const index = await safeRead(join9(wikiRoot, "index.md"));
  const wikiPages = await collectWikiPages(wikiRoot);
  const existingPageSet = /* @__PURE__ */ new Set([...wikiPages, ...rawSources.map((source) => relative3(wikiRoot, source).replaceAll("\\", "/"))]);
  const inbound = /* @__PURE__ */ new Map();
  for (const page of wikiPages) inbound.set(page, index.includes(`[[${page}]]`) ? 1 : 0);
  for (const page of wikiPages) {
    const fullPath = join9(wikiRoot, page);
    const content = await readFile8(fullPath, "utf8");
    const metadata = parsePageFrontmatter(content);
    if (!metadata) {
      issues.push({
        severity: "high",
        code: "missing_frontmatter",
        path: page,
        message: `Wiki page is missing required YAML frontmatter: ${page}`
      });
    }
    if (!index.includes(`[[${page}]]`)) {
      issues.push({
        severity: "medium",
        code: "missing_index_entry",
        path: page,
        message: `Wiki page is missing from index.md: ${page}`
      });
    }
    for (const link of extractWikiLinks(content)) {
      const target = resolveWikiLink(link, existingPageSet);
      if (!target) {
        issues.push({
          severity: "high",
          code: "broken_wikilink",
          path: page,
          message: `Broken wikilink [[${link}]] in ${page}`
        });
      } else if (inbound.has(target)) {
        inbound.set(target, (inbound.get(target) ?? 0) + 1);
      }
    }
  }
  for (const [page, count] of inbound.entries()) {
    if (count === 0) {
      issues.push({
        severity: "low",
        code: "orphan_page",
        path: page,
        message: `Wiki page has no inbound links: ${page}`
      });
    }
  }
  return { wikiPath, ok: issues.length === 0, issues };
}
async function collectSourceFiles(root) {
  const files = [];
  try {
    const rootStat = await stat3(root);
    if (rootStat.isFile()) return sourceExtensions.has(extname(root).toLowerCase()) ? [root] : [];
  } catch {
    return [];
  }
  async function visit(directory) {
    let entries;
    try {
      entries = await readdir4(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join9(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
        continue;
      }
      if (entry.isFile() && sourceExtensions.has(extname(entry.name).toLowerCase())) {
        files.push(path);
      }
    }
  }
  await visit(root);
  return files.sort((left, right) => left.localeCompare(right));
}
function normalizeWikiPath(path) {
  const wikiPath = (path ?? defaultWikiPath).replaceAll("\\", "/").replace(/^\.\/+/, "");
  if (!wikiPath || wikiPath.includes("..") || isAbsolute(wikiPath)) {
    throw new Error(`Invalid LLM Wiki path: ${path ?? ""}`);
  }
  return wikiPath;
}
function resolveWikiRoot(root, wikiPath) {
  return resolve4(root, wikiPath);
}
function normalizeSourcePath(root, sourceFile) {
  const sourcePath = relative3(root, sourceFile).replaceAll("\\", "/");
  return sourcePath.startsWith("..") ? sourceFile : sourcePath;
}
function normalizeTaskRead(root, wikiRoot, wikiPath, sourceFile) {
  const sourcePath = normalizeSourcePath(root, sourceFile);
  if (!sourcePath.startsWith("..") && !isAbsolute(sourcePath)) {
    if (sourcePath.startsWith(`${wikiPath}/`)) return sourcePath;
    const wikiRelative2 = relative3(wikiRoot, sourceFile).replaceAll("\\", "/");
    if (!wikiRelative2.startsWith("..")) return `${wikiPath}/${wikiRelative2}`;
    return sourcePath;
  }
  const wikiRelative = relative3(wikiRoot, sourceFile).replaceAll("\\", "/");
  return wikiRelative.startsWith("..") ? sourcePath : `${wikiPath}/${wikiRelative}`;
}
function instructionsForWikiTask(kind) {
  const common = [
    "Use the current coding agent LLM capability to read, compare, and synthesize project knowledge; Kata binary does not call an LLM here.",
    "Treat generated pages as project-understanding candidates, not proof of code correctness.",
    "Preserve provenance with wikilinks to raw sources and concise frontmatter.",
    "Do not edit raw/ files manually; write synthesized pages under concepts/, entities/, comparisons/, or queries/."
  ];
  if (kind === "bootstrap") {
    return [
      ...common,
      "Bootstrap the first durable concepts and entities from the raw documentation set.",
      "Prefer stable architecture, workflow, naming, and constraint pages over broad summaries."
    ];
  }
  if (kind === "distill") {
    return [
      ...common,
      "Distill only knowledge supported by passed task artifacts, review findings, judge result, and evidence envelopes.",
      "Write concise knowledge candidates that future agents can reuse without re-reading the entire task history."
    ];
  }
  return [
    ...common,
    "Enrich the Wiki by extracting stable concepts, entities, comparisons, project constraints, and recurring workflows from required reads.",
    "IMPORTANT: Design docs (raw/) are historical context \u2014 source code under packages/ is ground truth. Before writing a page, read actual source files (ports, domains, infrastructure, adapters) to verify each claim. If source and design doc disagree, source wins.",
    "Use CodeGraph (available via the codegraph_explore MCP tool or `kata codegraph explore/query/impact`) to navigate the codebase efficiently: find relevant source files, explore call paths, and verify claims against actual implementations.",
    "After writing pages, run the follow-up deterministic CLI commands and fix lint issues before handing off."
  ];
}
function renderRawSource(sourcePath, body) {
  return `---
source_path: ${sourcePath}
ingested: ${(/* @__PURE__ */ new Date()).toISOString()}
sha256: ${sha256(body)}
---
${body}`;
}
function renderSchema(now) {
  return `# Project LLM Wiki Schema

Created: ${now}

## Domain

Project implementation knowledge for agentic coding workflows.

## Layers

- \`raw/\`: immutable source material copied from project documentation or curated external sources.
- \`entities/\`, \`concepts/\`, \`comparisons/\`, \`queries/\`: agent-maintained markdown synthesis.
- \`SCHEMA.md\`, \`index.md\`, and \`log.md\`: orientation files. Every agent must read them before wiki work.

## Rules

- Read \`SCHEMA.md\`, \`index.md\`, and recent \`log.md\` before ingesting, querying, or linting.
- Do not modify \`raw/\` files manually; re-ingest sources and preserve provenance.
- Use wikilinks for durable references.
- Update \`index.md\` and append \`log.md\` for every meaningful wiki action.
- Treat wiki content as project-understanding aid, not code-correctness proof.
`;
}
function renderIndex(importedSources, now) {
  const sourceLines = importedSources.map((source) => `- [[${source}]] \u2014 imported raw project documentation source.`).join("\n");
  return `# Wiki Index

> Content catalog for the project LLM Wiki.
> Last updated: ${now} | Total pages: 0 | Raw sources: ${importedSources.length}

## Entities

## Concepts

## Comparisons

## Queries

## Raw Sources

${sourceLines}
`;
}
function renderLog(importedSources, now) {
  const date = now.slice(0, 10);
  const sourceLines = importedSources.map((source) => `- ${source}`).join("\n");
  return `# Wiki Log

> Chronological record of all wiki actions. Append-only.
> Format: \`## [YYYY-MM-DD] action | subject\`

## [${date}] init | Project LLM Wiki initialized

- Imported sources: ${importedSources.length}
${sourceLines}
`;
}
function renderSummaryPage(input) {
  const summary = oneLineSummary(input.body);
  return `---
title: ${input.title}
created: ${(/* @__PURE__ */ new Date()).toISOString().slice(0, 10)}
updated: ${(/* @__PURE__ */ new Date()).toISOString().slice(0, 10)}
type: concept
tags: [project, source]
sources: [${input.rawSource}]
confidence: medium
kata_record_id: ${input.recordId}
---

# ${input.title}

${summary}

## Source

- [[${input.rawSource}]]
`;
}
function renderQueryAnswer(query, matches) {
  if (matches.length === 0) return `No compiled LLM Wiki pages matched "${query}".`;
  const citations = matches.map((match) => `[[${match.page}]]`).join(" and ");
  const excerpts = matches.map((match) => firstMeaningfulLine(match.content)).filter(Boolean).join("\n\n");
  return `Based on ${citations}:

${excerpts}`;
}
function renderQueryPage(query, answer, citations) {
  const now = (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
  return `---
title: ${query}
created: ${now}
updated: ${now}
type: query
tags: [query]
sources: [${citations.join(", ")}]
confidence: medium
---

# ${query}

${answer}
`;
}
function parseFrontmatter(content) {
  if (!content.startsWith("---\n")) return null;
  const end = content.indexOf("\n---\n", 4);
  if (end === -1) return null;
  const header = content.slice(4, end);
  const body = content.slice(end + "\n---\n".length);
  const shaMatch = /^sha256:\s*([a-f0-9]{64})\s*$/m.exec(header);
  return { sha256: shaMatch?.[1], body };
}
function parsePageFrontmatter(content) {
  if (!content.startsWith("---\n")) return null;
  const end = content.indexOf("\n---\n", 4);
  if (end === -1) return null;
  const header = content.slice(4, end);
  const required = ["title:", "created:", "updated:", "type:", "tags:", "sources:"];
  return required.every((field) => header.includes(field)) ? { header } : null;
}
async function collectWikiPages(wikiRoot) {
  const pages = [];
  for (const directory of ["entities", "concepts", "comparisons", "queries"]) {
    const files = await collectSourceFiles(join9(wikiRoot, directory));
    pages.push(...files.map((file) => relative3(wikiRoot, file).replaceAll("\\", "/")));
  }
  return pages.sort();
}
async function upsertIndexEntry(wikiRoot, section, pagePath, summary) {
  const indexPath = join9(wikiRoot, "index.md");
  let index = await readFile8(indexPath, "utf8");
  const entry = `- [[${pagePath}]] \u2014 ${summary}`;
  if (index.includes(`[[${pagePath}]]`)) return;
  const heading = `## ${section}`;
  const headingIndex = index.indexOf(heading);
  if (headingIndex === -1) {
    index += `
${heading}

${entry}
`;
  } else {
    const insertAt = index.indexOf("\n## ", headingIndex + heading.length);
    const prefix = insertAt === -1 ? index.trimEnd() : index.slice(0, insertAt).trimEnd();
    const suffix = insertAt === -1 ? "" : index.slice(insertAt);
    index = `${prefix}

${entry}
${suffix}`;
  }
  await writeFile6(indexPath, index, "utf8");
}
async function appendLog(wikiRoot, subject, lines) {
  const logPath = join9(wikiRoot, "log.md");
  const existing = await readFile8(logPath, "utf8");
  const date = (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
  await writeFile6(logPath, `${existing.trimEnd()}

## [${date}] ${subject}

${lines.join("\n")}
`, "utf8");
}
async function safeRead(path) {
  try {
    return await readFile8(path, "utf8");
  } catch {
    return "";
  }
}
function extractWikiLinks(content) {
  return [...content.matchAll(/\[\[([^\]]+)\]\]/g)].map((match) => match[1].split("|")[0].trim());
}
function resolveWikiLink(link, existingPages) {
  const normalized = link.replaceAll("\\", "/").replace(/^\.\/+/, "");
  const candidates = [normalized, `${normalized}.md`];
  for (const candidate of candidates) {
    if (existingPages.has(candidate)) return candidate;
  }
  const basename4 = normalized.split("/").pop();
  if (!basename4) return null;
  for (const page of existingPages) {
    if (page === basename4 || page.endsWith(`/${basename4}`) || page.endsWith(`/${basename4}.md`)) return page;
  }
  return null;
}
function slugify(value) {
  const slug = value.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
  return slug || "untitled";
}
function titleFromMarkdown(body) {
  const heading = /^#\s+(.+)$/m.exec(body);
  return heading?.[1].trim() ?? null;
}
function titleFromSlug(slug) {
  return slug.split("-").filter(Boolean).map((part) => part[0]?.toUpperCase() + part.slice(1)).join(" ") || "Untitled";
}
function oneLineSummary(body) {
  return firstMeaningfulLine(body).replace(/^#+\s*/, "").slice(0, 160) || "Imported project knowledge source.";
}
function firstMeaningfulLine(body) {
  return body.split("\n").map((line) => line.trim()).find((line) => line.length > 0 && !line.startsWith("---")) ?? "";
}
function scoreContent(query, content, path) {
  const haystack = `${path}
${content}`.toLowerCase();
  const terms = query.toLowerCase().split(/[^a-z0-9\u4e00-\u9fa5]+/).filter((term) => term.length >= 2);
  return terms.reduce((score2, term) => score2 + (haystack.includes(term) ? 1 : 0), 0);
}
function sha256(content) {
  return createHash4("sha256").update(content).digest("hex");
}

// src/adapters/platforms.ts
var defaultSkillsCapabilities = {
  skills: true,
  hooks: false,
  subAgents: false,
  modelSelection: true
};
var hookCapabilities = {
  skills: true,
  hooks: true,
  subAgents: true,
  modelSelection: true
};
var platformDefinitions = [
  {
    id: "codex",
    name: "Codex",
    skillsDir: ".codex",
    globalSkillsDir: ".codex",
    rulesDir: "rules",
    rulesFormat: "md",
    hookFormat: "claude-code",
    capabilities: { skills: true, hooks: true, subAgents: true, modelSelection: true }
  },
  {
    id: "claude-code",
    name: "Claude Code",
    skillsDir: ".claude",
    globalSkillsDir: ".claude",
    rulesDir: "rules",
    rulesFormat: "md",
    hookFormat: "claude-code",
    capabilities: hookCapabilities
  },
  {
    id: "opencode",
    name: "OpenCode",
    skillsDir: ".opencode",
    globalSkillsDir: ".config/opencode",
    detectionPaths: ["opencode.json", ".opencode"],
    rulesDir: "rules",
    rulesFormat: "md",
    supportsOpenCodeCommands: true,
    modelSelectionInstruction: "OpenCode\uFF1A\u5982\u9700\u5207\u6362\u6A21\u578B\uFF0C\u5148\u6267\u884C `/models` \u5E76\u5728\u5176\u4EA4\u4E92\u754C\u9762\u5B8C\u6210\u9009\u62E9\uFF0C\u518D\u8FD0\u884C\u672C\u6B21\u59D4\u6258\u7684 Kata \u547D\u4EE4\u3002",
    capabilities: { skills: true, hooks: false, subAgents: true, modelSelection: true }
  },
  {
    id: "cursor",
    name: "Cursor",
    skillsDir: ".cursor",
    globalSkillsDir: ".cursor",
    rulesDir: "rules",
    rulesFormat: "mdc",
    capabilities: defaultSkillsCapabilities
  },
  {
    id: "windsurf",
    name: "Windsurf",
    skillsDir: ".windsurf",
    globalSkillsDir: ".windsurf",
    rulesDir: "rules",
    rulesFormat: "md",
    hookFormat: "windsurf",
    capabilities: hookCapabilities
  },
  {
    id: "cline",
    name: "Cline",
    skillsDir: ".cline",
    globalSkillsDir: ".cline",
    detectionPaths: [".cline", ".clinerules"],
    rulesBaseDir: "",
    rulesDir: ".clinerules",
    rulesFormat: "md",
    capabilities: defaultSkillsCapabilities
  },
  {
    id: "roocode",
    name: "RooCode",
    skillsDir: ".roo",
    globalSkillsDir: ".roo",
    rulesDir: "rules",
    rulesFormat: "md",
    capabilities: defaultSkillsCapabilities
  },
  {
    id: "gemini",
    name: "Gemini CLI",
    skillsDir: ".gemini",
    globalSkillsDir: ".gemini",
    hookFormat: "gemini",
    capabilities: hookCapabilities
  },
  {
    id: "github-copilot",
    name: "GitHub Copilot",
    skillsDir: ".github",
    globalSkillsDir: ".github",
    detectionPaths: [".github/copilot-instructions.md", ".github/instructions", ".github/prompts", ".github/skills"],
    rulesDir: "instructions",
    rulesFormat: "copilot",
    hookFormat: "copilot",
    capabilities: hookCapabilities
  },
  {
    id: "generic",
    name: "Generic",
    skillsDir: ".kata",
    rulesDir: "rules",
    rulesFormat: "md",
    capabilities: { skills: true, hooks: false, subAgents: false, modelSelection: false }
  }
];
var platformDefinitionById = Object.fromEntries(
  platformDefinitions.map((platform) => [platform.id, platform])
);
function platformSkillsDir(platform, scope) {
  const definition = platformDefinitionById[platform];
  return scope === "global" && definition.globalSkillsDir ? definition.globalSkillsDir : definition.skillsDir;
}
function platformSkillPath(platform, scope, commandId) {
  if (platform === "generic") return `.kata/skills/${commandId}.md`;
  return `${platformSkillsDir(platform, scope)}/skills/${commandId}/SKILL.md`;
}
function platformCommandPath(platform, scope, commandId) {
  const definition = platformDefinitionById[platform];
  if (!definition.supportsOpenCodeCommands) return null;
  return `${platformSkillsDir(platform, scope)}/commands/${commandId}.md`;
}
function platformRulePath(platform, scope, ruleName) {
  const definition = platformDefinitionById[platform];
  if (!definition.rulesDir || !definition.rulesFormat) return null;
  const base = definition.rulesBaseDir !== void 0 ? definition.rulesBaseDir === "" ? "" : definition.rulesBaseDir : platformSkillsDir(platform, scope);
  const fileName = definition.rulesFormat === "mdc" ? `${ruleName}.mdc` : definition.rulesFormat === "copilot" ? `${ruleName}.instructions.md` : `${ruleName}.md`;
  return [base, definition.rulesDir, fileName].filter(Boolean).join("/");
}

// src/adapters/ownership.ts
async function install(platform, scope, options = {}) {
  return writeSkills(platform, scope, options);
}
async function update(platform, scope, options = {}) {
  return writeSkills(platform, scope, options);
}
async function listManagedPlatforms(scope, options = {}) {
  const manifest = await readManifest(manifestBaseRoot(scope, options));
  return [...new Set(
    Object.values(manifest.files).filter((file) => file.scope === scope).map((file) => file.platform)
  )].sort();
}
async function uninstall(platform, scope, options = {}) {
  const baseRoot = installationRoot(scope, options);
  const manifestRoot = manifestBaseRoot(scope, options);
  const manifest = await readManifest(manifestRoot);
  const report = createReport(platform, scope, options.dryRun === true);
  const entries = Object.values(manifest.files).filter((file) => file.platform === platform && file.scope === scope);
  for (const entry of entries) {
    report.planned.push(entry.path);
    const absolutePath = join10(baseRoot, entry.path);
    const current = await readOptional(absolutePath);
    if (current === void 0) {
      delete manifest.files[entry.path];
      continue;
    }
    const currentHash = sha2562(current);
    if (!options.force && currentHash !== entry.sha256) {
      report.conflicts.push(entry.path);
      continue;
    }
    if (!options.dryRun) {
      if (entry.commandId === "project-contract" && entry.path === "AGENTS.md") {
        const nextContent = removeAgentsContract(current);
        if (nextContent.trim().length > 0) {
          await writeFileAtomic2(absolutePath, nextContent);
        } else {
          await rm3(absolutePath);
        }
      } else if (entry.commandId.startsWith("hook-config:")) {
        const nextContent = removeManagedHookConfig(current, entry.commandId);
        if (nextContent.trim().length > 0) {
          await writeFileAtomic2(absolutePath, nextContent);
        } else {
          await rm3(absolutePath);
        }
      } else {
        await rm3(absolutePath);
      }
      delete manifest.files[entry.path];
    }
    report.removed.push(entry.path);
  }
  if (!options.dryRun) await writeManifest(manifestRoot, manifest);
  return report;
}
async function writeSkills(platform, scope, options) {
  const effectiveOptions = await resolveEffectiveInstallOptions(scope, options);
  const baseRoot = installationRoot(scope, effectiveOptions);
  const manifestRoot = manifestBaseRoot(scope, effectiveOptions);
  const manifest = await readManifest(manifestRoot);
  const report = createReport(platform, scope, effectiveOptions.dryRun === true);
  for (const command of skillCommands) {
    const relativePath = platformSkillPath(platform, scope, command.id);
    const absolutePath = join10(baseRoot, relativePath);
    const content = renderSkill(command, platform, { language: effectiveOptions.language });
    const nextHash = sha2562(content);
    const previous = manifest.files[relativePath];
    report.planned.push(relativePath);
    const existing = await readOptional(absolutePath);
    if (existing !== void 0) {
      const existingHash = sha2562(existing);
      if (previous === void 0 && !effectiveOptions.force) {
        report.conflicts.push(relativePath);
        continue;
      }
      if (previous !== void 0 && existingHash !== previous.sha256 && existingHash !== nextHash && !effectiveOptions.force) {
        report.conflicts.push(relativePath);
        continue;
      }
      if (existingHash === nextHash) {
        report.unchanged.push(relativePath);
        manifest.files[relativePath] = ownedFile(platform, scope, command.id, relativePath, nextHash);
        continue;
      }
    }
    if (!effectiveOptions.dryRun) {
      await mkdir7(dirname6(absolutePath), { recursive: true });
      await writeFileAtomic2(absolutePath, content);
      manifest.files[relativePath] = ownedFile(platform, scope, command.id, relativePath, nextHash);
      report.written.push(relativePath);
    }
  }
  await writePlatformAdapterFiles(platform, scope, effectiveOptions, baseRoot, manifest, report);
  await writePlatformHookFiles(platform, scope, effectiveOptions, baseRoot, manifest, report);
  await removeObsoleteCommandFiles(platform, scope, effectiveOptions, baseRoot, manifest, report);
  if (scope === "project") {
    await writeProjectContractFiles(platform, scope, effectiveOptions, baseRoot, manifest, report);
    await manageProjectWiki(effectiveOptions, baseRoot, report);
  }
  if (!effectiveOptions.dryRun) await writeManifest(manifestRoot, manifest);
  return report;
}
async function removeObsoleteCommandFiles(platform, scope, options, baseRoot, manifest, report) {
  const activeCommands = new Set(skillCommands.map((command) => command.id));
  const obsolete = Object.values(manifest.files).filter((file) => {
    if (file.platform !== platform || file.scope !== scope) return false;
    const commandId = file.commandId.startsWith("command:") ? file.commandId.slice("command:".length) : file.commandId;
    const isCommandArtifact = commandId.startsWith("kata-");
    return isCommandArtifact && !activeCommands.has(commandId);
  });
  for (const file of obsolete) {
    const path = join10(baseRoot, file.path);
    const current = await readOptional(path);
    if (current !== void 0 && sha2562(current) !== file.sha256 && !options.force) {
      report.conflicts.push(file.path);
      continue;
    }
    report.planned.push(file.path);
    if (!options.dryRun && current !== void 0) await rm3(path);
    if (!options.dryRun) delete manifest.files[file.path];
    report.removed.push(file.path);
  }
}
async function resolveEffectiveInstallOptions(scope, options) {
  if (scope !== "project") return options;
  const root = installationRoot(scope, options);
  const config = await loadConfig(root);
  const language = options.language ?? config.language;
  if (options.language && !options.dryRun) {
    await writeConfigPatch(root, { language: options.language });
  }
  return language === options.language ? options : { ...options, ...language ? { language } : {} };
}
async function writePlatformHookFiles(platform, scope, options, baseRoot, manifest, report) {
  const definition = platformDefinitionById[platform];
  if (!definition.hookFormat) return;
  const hookScriptPath = `${platformSkillsDir(platform, scope)}/hooks/kata-hook-guard.mjs`;
  await writeSupportFile({
    platform,
    scope,
    options,
    baseRoot,
    manifest,
    report,
    commandId: "hook-script:kata-hook-guard",
    relativePath: hookScriptPath,
    content: renderHookGuardScript()
  });
  const command = `node "${hookScriptPath}" --project-root "${baseRoot.replaceAll('"', '\\"')}"`;
  const config = hookConfigForPlatform(platform, scope);
  if (!config) return;
  await writeSupportFile({
    platform,
    scope,
    options,
    baseRoot,
    manifest,
    report,
    commandId: `hook-config:${definition.hookFormat}`,
    relativePath: config.relativePath,
    content: config.render(command),
    mergeExisting: (existing, block) => mergeHookConfig(existing, block, definition.hookFormat)
  });
}
async function writePlatformAdapterFiles(platform, scope, options, baseRoot, manifest, report) {
  for (const command of skillCommands) {
    const relativePath = platformCommandPath(platform, scope, command.id);
    if (!relativePath) continue;
    await writeSupportFile({
      platform,
      scope,
      options,
      baseRoot,
      manifest,
      report,
      commandId: `command:${command.id}`,
      relativePath,
      content: renderOpenCodeCommand(command, options.language)
    });
  }
  const rulePath = platformRulePath(platform, scope, "kata-agent-contract");
  if (!rulePath) return;
  await writeSupportFile({
    platform,
    scope,
    options,
    baseRoot,
    manifest,
    report,
    commandId: "rule:kata-agent-contract",
    relativePath: rulePath,
    content: renderPlatformRule(platform, options.language)
  });
}
function hookConfigForPlatform(platform, scope) {
  const definition = platformDefinitionById[platform];
  const base = platformSkillsDir(platform, scope);
  switch (definition.hookFormat) {
    case "claude-code":
      return {
        relativePath: `${base}/settings.local.json`,
        render: (command) => JSON.stringify(claudeCodeHookConfig(command), null, 2) + "\n"
      };
    case "gemini":
      return {
        relativePath: `${base}/settings.json`,
        render: (command) => JSON.stringify(geminiHookConfig(command), null, 2) + "\n"
      };
    case "windsurf":
      return {
        relativePath: `${base}/hooks.json`,
        render: (command) => JSON.stringify(windsurfHookConfig(command), null, 2) + "\n"
      };
    case "copilot":
      return {
        relativePath: `${base}/hooks/kata-guard.json`,
        render: (command) => JSON.stringify(copilotHookConfig(command), null, 2) + "\n"
      };
    default:
      return null;
  }
}
async function manageProjectWiki(options, root, report) {
  if (options.noWiki) {
    report.wiki = { status: "skipped", reason: "disabled" };
    return;
  }
  const wikiExists = await pathExists(join10(root, ".llmwiki"));
  if (wikiExists) {
    report.wiki = { status: "existing", path: ".llmwiki" };
  } else {
    const from = options.wikiFrom ?? "docs";
    const fromPath = join10(root, from);
    if (!await pathExists(fromPath)) {
      report.wiki = { status: "skipped", reason: "source_not_found", from };
      return;
    }
    if (options.dryRun) {
      report.wiki = { status: "planned", path: ".llmwiki", from };
      return;
    }
    const result = await initLlmWiki({ root, from });
    report.wiki = {
      status: "initialized",
      path: result.wikiPath,
      from,
      importedCount: result.importedSources.length
    };
  }
  const enrichTask = await buildLlmWikiTask({ root, kind: "enrich" });
  const taskDir = join10(root, ".kata/tasks/wiki-enrich");
  await mkdir7(taskDir, { recursive: true });
  await writeFile7(join10(taskDir, "task-packet.json"), `${JSON.stringify(enrichTask, null, 2)}
`);
}
async function writeProjectContractFiles(platform, scope, options, baseRoot, manifest, report) {
  await writeSupportFile({
    platform,
    scope,
    options,
    baseRoot,
    manifest,
    report,
    commandId: "project-contract",
    relativePath: "AGENTS.md",
    content: renderAgentsContract(options.language),
    mergeExisting: mergeAgentsContract
  });
  await writeSupportFile({
    platform,
    scope,
    options,
    baseRoot,
    manifest,
    report,
    commandId: "skills-index",
    relativePath: ".kata/skills-index.md",
    content: renderSkillsIndex(options.language)
  });
}
async function writeSupportFile(input) {
  const absolutePath = join10(input.baseRoot, input.relativePath);
  const existing = await readOptional(absolutePath);
  const content = existing !== void 0 && input.mergeExisting ? input.mergeExisting(existing, input.content) : input.content;
  const nextHash = sha2562(content);
  const previous = input.manifest.files[input.relativePath];
  input.report.planned.push(input.relativePath);
  if (existing !== void 0) {
    const existingHash = sha2562(existing);
    if (existingHash === nextHash) {
      input.report.unchanged.push(input.relativePath);
      input.manifest.files[input.relativePath] = ownedFile(input.platform, input.scope, input.commandId, input.relativePath, nextHash);
      return;
    }
    if (previous !== void 0 && existingHash !== previous.sha256 && !input.options.force) {
      input.report.conflicts.push(input.relativePath);
      return;
    }
  }
  if (!input.options.dryRun) {
    await mkdir7(dirname6(absolutePath), { recursive: true });
    await writeFileAtomic2(absolutePath, content);
    input.manifest.files[input.relativePath] = ownedFile(input.platform, input.scope, input.commandId, input.relativePath, nextHash);
    input.report.written.push(input.relativePath);
  }
}
function renderAgentsContract(language) {
  const responseLanguage = renderResponseLanguageContract2(language);
  return `<!-- STRATA:BEGIN -->
# Kata Agent Contract

Before non-trivial work in this project:

1. Run \`kata orient --change <id> --role <role> --task-kind <kind>\`.
2. Read AGENTS.md plus the returned \`.llmwiki/SCHEMA.md\`, \`.llmwiki/index.md\`, and \`.llmwiki/log.md\` entries when present.
3. Use the matching \`/kata-*\` skill and follow its startup checklist.
4. Kata \u4E0D\u914D\u7F6E\u3001\u4E0D\u8DEF\u7531\u4E5F\u4E0D\u8BB0\u5F55\u5BBF\u4E3B\u5E73\u53F0\u6A21\u578B\u3002\u82E5\u9700\u5207\u6362\uFF0C\u8BF7\u76F4\u63A5\u4F7F\u7528\u5BBF\u4E3B\u5E73\u53F0\u81EA\u5DF1\u7684\u6A21\u578B\u9009\u62E9\u5668\u6216\u914D\u7F6E\u540E\u7EE7\u7EED\u3002
5. Do not treat Wiki as proof of code correctness: CI, tests, Reviewer, and Judge own correctness.

## Development constraint: skill-first

For Kata development and dogfooding, the \`/kata-*\` skill is the human-facing workflow entrypoint. The \`kata ...\` CLI is the deterministic execution layer used inside skills and scripts.

- Prefer short skill invocations such as \`/kata-build <intent>\`, \`/kata-review\`, \`/kata-collect\`, or \`\u7EE7\u7EED\`.
- A skill must first discover the active/same-branch task with \`kata status\`, follow relation redirects, and read \`nextAction\`.
- Do not ask the user to provide CLI flags such as \`--change\`, \`--role\`, or \`--task-kind\` unless discovery leaves multiple plausible choices.
- At \`review_gate\` and \`judge_gate\`, stop so the user can use the host platform's own model selector before continuing. At \`archive_gate\`, stop for the user's archive decision.
- Use CLI commands directly only for non-interactive automation, tests, CI, or when the host platform cannot execute slash-command skills.

Protected Kata paths and phase gates are enforced by the CLI.
${responseLanguage ? `
${responseLanguage}` : ""}
<!-- STRATA:END -->
`;
}
function renderOpenCodeCommand(command, language) {
  const body = stripSkillFrontmatter(renderSkill(command, "opencode", { language }));
  return `---
description: Run the ${command.id} Kata workflow
---

Equivalent Kata skill: \`${command.id}\`
Command name: \`${command.slashCommand}\`

Use the invocation arguments below as the user input for this workflow:

\`\`\`text
$ARGUMENTS
\`\`\`

${body}
`;
}
function stripSkillFrontmatter(content) {
  const normalized = content.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) return content.trimStart();
  const end = normalized.indexOf("\n---\n", 4);
  if (end === -1) return content.trimStart();
  return normalized.slice(end + "\n---\n".length).trimStart();
}
function renderPlatformRule(platform, language) {
  const responseLanguage = renderResponseLanguageContract2(language);
  const body = `# Kata Agent Contract

Wiki helps agents avoid project-context mistakes; CI, tests, Reviewer, and Judge prevent code-correctness mistakes.

Before non-trivial work:

1. Run \`kata orient --change <id> --role <role> --task-kind <kind>\`.
2. Read returned AGENTS, .llmwiki, model-route, and guard instructions before editing.
3. Use the matching /kata-* skill or its platform command bridge.
4. Capture durable project knowledge into .llmwiki, but never treat Wiki as proof that code is correct.
5. Let tests, CI, reviewer findings, judge results, and phase gates decide correctness.

## Development constraint: skill-first

The /kata-* skill or platform command bridge is the human-facing workflow entrypoint. The kata CLI is the deterministic execution layer used inside skills and scripts.

- Prefer short skill invocations such as /kata-build <intent>, /kata-review, /kata-collect, or \u7EE7\u7EED.
- A skill must first discover the active/same-branch task with kata status, follow relation redirects, and read nextAction.
- Do not ask the user to provide CLI flags such as --change, --role, or --task-kind unless discovery leaves multiple plausible choices.
- At review_gate and judge_gate, stop, show the recommendation, and wait for the user to switch the host-platform model and resume. Do not claim a switch or write a route before confirmation. At archive_gate, stop for the user's archive decision.
- Use CLI commands directly only for non-interactive automation, tests, CI, or when the host platform cannot execute slash-command skills.
${responseLanguage ? `
${responseLanguage}` : ""}
`;
  const format = platformDefinitionById[platform].rulesFormat;
  if (format === "mdc") {
    return `---
description: kata agent contract
globs:
alwaysApply: true
---

${body}`;
  }
  if (format === "copilot") {
    return `---
applyTo: "**"
---

${body}`;
  }
  return body;
}
function renderHookGuardScript() {
  return `#!/usr/bin/env node
// Managed by Kata. Active-task hook guard.
import { readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const root = resolveArg('--project-root') ?? process.cwd();
const input = await readStdin();
const payload = parseJson(input) ?? {};
const targetPath = extractTargetPath(payload);
const active = readJson(join(root, '.kata/runtime/active-task.json'));

if (!active || !targetPath) process.exit(0);

const taskId = typeof active.taskId === 'string' ? active.taskId : null;
const role = typeof active.role === 'string' ? active.role : 'implementer';
if (!taskId || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(taskId)) process.exit(0);

const state = readJson(join(root, '.kata/tasks', taskId, 'current-state.json'));
const task = readJson(join(root, '.kata/tasks', taskId, 'task.json'));
if (!state || !task) process.exit(0);

const phase = typeof state.phase === 'string' ? state.phase : task.phase;
const normalizedPath = normalizeTargetPath(root, targetPath);
const denial = evaluateWrite({ role }, normalizedPath, { ...task, id: taskId, phase });

if (denial) {
  console.error(\`Kata hook blocked write to \${targetPath}: \${denial}\`);
  console.error('Run: kata orient --change ' + taskId + ' --role ' + role);
  process.exit(2);
}

process.exit(0);

function resolveArg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) {
      resolve('');
      return;
    }
    process.stdin.setEncoding('utf8');
    let data = '';
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
  });
}

function parseJson(value) {
  try {
    return value.trim() ? JSON.parse(value) : null;
  } catch {
    return null;
  }
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function extractTargetPath(value) {
  const candidates = [
    value?.tool_input?.file_path,
    value?.tool_input?.path,
    value?.file_path,
    value?.path,
    value?.params?.file_path,
    value?.params?.path,
    value?.arguments?.file_path,
    value?.arguments?.path,
  ];
  return candidates.find((candidate) => typeof candidate === 'string') ?? null;
}

function normalizeTargetPath(projectRoot, targetPath) {
  const raw = String(targetPath).replaceAll('\\\\', '/');
  if (!raw || raw.includes('\\u0000')) return null;
  if (/^[A-Za-z]:\\//.test(raw)) return null;
  const absolute = raw.startsWith('/') ? resolve(raw) : resolve(projectRoot, raw);
  const rel = relative(projectRoot, absolute).replaceAll('\\\\', '/');
  if (!rel || rel.startsWith('..') || rel.startsWith('/')) return null;
  if (rel.split('/').includes('..')) return null;
  return rel;
}

function evaluateWrite(actor, normalizedPath, task) {
  if (!normalizedPath) return 'invalid_path';
  if (task.phase === 'intake' || task.phase === 'plan' || task.phase === 'archive') {
    if (normalizedPath.startsWith('src/') || normalizedPath.startsWith('tests/')) return 'phase_scope_violation';
  }
  if (normalizedPath.startsWith('docs/superpowers/rules/') || normalizedPath.startsWith('.kata/wiki/verified/')) {
    return actor.role === 'approver' ? null : 'protected_rules_or_verified_wiki';
  }
  if (actor.role === 'implementer') {
    if (normalizedPath.startsWith('src/') || normalizedPath.startsWith('packages/') || normalizedPath.startsWith('tests/') || normalizedPath.startsWith('docs/')) return null;
    return 'role_scope_violation';
  }
  if (actor.role === 'reviewer') {
    return normalizedPath === '.kata/tasks/' + task.id + '/review.json' ? null : 'role_scope_violation';
  }
  if (actor.role === 'judge') {
    return normalizedPath === '.kata/tasks/' + task.id + '/judge.json' ? null : 'role_scope_violation';
  }
  if (actor.role === 'distiller') {
    return normalizedPath.startsWith('.kata/wiki/candidates/') || normalizedPath === '.kata/tasks/' + task.id + '/wiki-candidate.json'
      ? null
      : 'role_scope_violation';
  }
  if (actor.role === 'approver') return null;
  return 'unknown_role';
}
`;
}
function claudeCodeHookConfig(command) {
  return {
    hooks: {
      PreToolUse: [
        {
          matcher: "Write|Edit",
          hooks: [{ type: "command", command }]
        }
      ]
    }
  };
}
function geminiHookConfig(command) {
  return {
    hooks: {
      BeforeTool: [
        {
          matcher: "write_file|edit_file",
          hooks: [{ type: "command", command, name: "Kata phase guard" }]
        }
      ]
    }
  };
}
function windsurfHookConfig(command) {
  return {
    hooks: {
      pre_write_code: [{ command, show_output: true }]
    }
  };
}
function copilotHookConfig(command) {
  return {
    version: 1,
    hooks: {
      preToolUse: [{ bash: command, powershell: command }]
    }
  };
}
function mergeHookConfig(existing, block, format) {
  const existingObject = parseJsonObject(existing);
  const blockObject = parseJsonObject(block);
  if (!existingObject) return block;
  if (!blockObject) return existing;
  if (format === "claude-code") {
    return stringifyJson(mergeGroupedHookConfig(existingObject, blockObject, "PreToolUse"));
  }
  if (format === "gemini") {
    return stringifyJson(mergeGroupedHookConfig(existingObject, blockObject, "BeforeTool"));
  }
  if (format === "windsurf") {
    return stringifyJson(mergeArrayHookConfig(existingObject, blockObject, "pre_write_code"));
  }
  if (format === "copilot") {
    return block;
  }
  return block;
}
function removeManagedHookConfig(content, commandId) {
  const format = commandId.replace(/^hook-config:/, "");
  const parsed = parseJsonObject(content);
  if (!parsed) return content;
  if (format === "claude-code") return stringifyJson(removeGroupedHookConfig(parsed, "PreToolUse"));
  if (format === "gemini") return stringifyJson(removeGroupedHookConfig(parsed, "BeforeTool"));
  if (format === "windsurf") return stringifyJson(removeArrayHookConfig(parsed, "pre_write_code"));
  if (format === "copilot") return "";
  return content;
}
function parseJsonObject(content) {
  try {
    const parsed = JSON.parse(content);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) return parsed;
  } catch {
    return null;
  }
  return null;
}
function stringifyJson(value) {
  return `${JSON.stringify(value, null, 2)}
`;
}
function mergeGroupedHookConfig(existing, incoming, groupName) {
  const existingHooks = objectRecord(existing.hooks);
  const incomingHooks = objectRecord(incoming.hooks);
  const existingGroups = arrayRecords(existingHooks[groupName]);
  const incomingGroups = arrayRecords(incomingHooks[groupName]);
  const nextGroups = removeManagedGroups(existingGroups);
  for (const incomingGroup of incomingGroups) {
    const matcher = incomingGroup.matcher;
    const existingGroup = nextGroups.find((group) => group.matcher === matcher && Array.isArray(group.hooks));
    if (existingGroup) {
      existingGroup.hooks = [...arrayRecords(existingGroup.hooks), ...arrayRecords(incomingGroup.hooks)];
    } else {
      nextGroups.push(incomingGroup);
    }
  }
  existing.hooks = { ...existingHooks, [groupName]: nextGroups };
  return existing;
}
function removeGroupedHookConfig(existing, groupName) {
  const hooks = objectRecord(existing.hooks);
  const groups = arrayRecords(hooks[groupName]);
  const filtered = removeManagedGroups(groups);
  if (filtered.length > 0) hooks[groupName] = filtered;
  else delete hooks[groupName];
  if (Object.keys(hooks).length > 0) existing.hooks = hooks;
  else delete existing.hooks;
  return existing;
}
function mergeArrayHookConfig(existing, incoming, arrayName) {
  const existingHooks = objectRecord(existing.hooks);
  const incomingHooks = objectRecord(incoming.hooks);
  existingHooks[arrayName] = [
    ...arrayRecords(existingHooks[arrayName]).filter((entry) => !isManagedHookEntry(entry)),
    ...arrayRecords(incomingHooks[arrayName])
  ];
  existing.hooks = existingHooks;
  return existing;
}
function removeArrayHookConfig(existing, arrayName) {
  const hooks = objectRecord(existing.hooks);
  const filtered = arrayRecords(hooks[arrayName]).filter((entry) => !isManagedHookEntry(entry));
  if (filtered.length > 0) hooks[arrayName] = filtered;
  else delete hooks[arrayName];
  if (Object.keys(hooks).length > 0) existing.hooks = hooks;
  else delete existing.hooks;
  return existing;
}
function removeManagedGroups(groups) {
  return groups.flatMap((group) => {
    const hooks = arrayRecords(group.hooks);
    if (hooks.length === 0) return [group];
    const filteredHooks = hooks.filter((hook) => !isManagedHookEntry(hook));
    if (filteredHooks.length === 0) return [];
    return [{ ...group, hooks: filteredHooks }];
  });
}
function isManagedHookEntry(entry) {
  return [entry.command, entry.bash, entry.powershell].some(
    (value) => typeof value === "string" && value.includes("kata-hook-guard.mjs")
  );
}
function objectRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : {};
}
function arrayRecords(value) {
  return Array.isArray(value) ? value.filter((entry) => objectRecord(entry) === entry) : [];
}
function mergeAgentsContract(existing, block) {
  if (existing.includes("<!-- STRATA:BEGIN -->") && existing.includes("<!-- STRATA:END -->")) {
    return existing.replace(/<!-- STRATA:BEGIN -->[\s\S]*?<!-- STRATA:END -->\n?/m, block);
  }
  return `${existing.trimEnd()}

${block}`;
}
function removeAgentsContract(content) {
  const begin = "<!-- STRATA:BEGIN -->";
  const end = "<!-- STRATA:END -->";
  const start = content.indexOf(begin);
  const stop = content.indexOf(end);
  if (start === -1 || stop === -1 || stop < start) return content;
  const before = content.slice(0, start).trimEnd();
  const after = content.slice(stop + end.length).trimStart();
  if (before && after) return `${before}

${after}`;
  if (before) return `${before}
`;
  return after;
}
function renderSkillsIndex(language) {
  const lines = skillCommands.map((command) => `- \`${command.slashCommand}\` \u2014 ${command.summary}`);
  const responseLanguage = renderResponseLanguageContract2(language);
  return `# Kata Skills Index

Use these skills for governed project work:

${lines.join("\n")}

${responseLanguage ? `${responseLanguage}

` : ""}Always start with:

\`\`\`bash
kata orient --change <id> --role <role> --task-kind <kind>
\`\`\`

The orientation output links project constraints, LLM Wiki context, allowed writes, phase gates, and the next suggested skill.
`;
}
function renderResponseLanguageContract2(language) {
  if (language === "zh") {
    return `## Response language

\u6240\u6709\u9762\u5411\u7528\u6237\u7684\u81EA\u7136\u8BED\u8A00\u54CD\u5E94\u5FC5\u987B\u4F7F\u7528\u4E2D\u6587\u3002\u4EE3\u7801\u3001\u547D\u4EE4\u3001\u6587\u4EF6\u8DEF\u5F84\u3001API \u540D\u79F0\u3001\u65E5\u5FD7\u548C\u534F\u8BAE\u5B57\u6BB5\u53EF\u4EE5\u4FDD\u7559\u539F\u6587\u3002`;
  }
  if (language === "en") {
    return `## Response language

All user-facing natural-language responses must be written in English. Code, commands, file paths, API names, logs, and protocol fields may remain in their original form.`;
  }
  return "";
}
function installationRoot(scope, options) {
  if (scope === "project") return options.root ?? process.cwd();
  return options.home ?? process.env.HOME ?? process.cwd();
}
function manifestBaseRoot(scope, options) {
  return scope === "project" ? options.root ?? process.cwd() : options.home ?? process.env.HOME ?? process.cwd();
}
function createReport(platform, scope, dryRun) {
  return { platform, scope, planned: [], written: [], removed: [], conflicts: [], unchanged: [], dryRun };
}
function ownedFile(platform, scope, commandId, path, fileHash) {
  return { platform, scope, commandId, path, sha256: fileHash };
}
async function readManifest(root) {
  const path = manifestPath(root);
  const content = await readOptional(path);
  if (content === void 0) return { version: 1, commandManifest, files: {} };
  const parsed = JSON.parse(content);
  if (!isOwnershipManifest(parsed)) throw new Error(`Invalid Kata adapter ownership manifest: ${path}`);
  return parsed;
}
async function writeManifest(root, manifest) {
  const path = manifestPath(root);
  await mkdir7(dirname6(path), { recursive: true });
  await writeFileAtomic2(path, `${JSON.stringify(manifest, null, 2)}
`);
}
function manifestPath(root) {
  return join10(root, ".kata/adapters/manifest.json");
}
function isOwnershipManifest(value) {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value;
  return candidate.version === 1 && typeof candidate.files === "object" && candidate.files !== null;
}
async function readOptional(path) {
  try {
    return await readFile9(path, "utf8");
  } catch (error) {
    if (isNodeError4(error) && error.code === "ENOENT") return void 0;
    throw error;
  }
}
async function pathExists(path) {
  try {
    await stat4(path);
    return true;
  } catch (error) {
    if (isNodeError4(error) && error.code === "ENOENT") return false;
    throw error;
  }
}
async function writeFileAtomic2(path, content) {
  const temporaryPath = join10(dirname6(path), `.${basename3(path)}.${process.pid}.${randomUUID4()}.tmp`);
  await writeFile7(temporaryPath, content, "utf8");
  await rename2(temporaryPath, path);
}
function sha2562(content) {
  return createHash5("sha256").update(content).digest("hex");
}
async function exists(path) {
  try {
    await stat4(path);
    return true;
  } catch (error) {
    if (isNodeError4(error) && error.code === "ENOENT") return false;
    throw error;
  }
}
function isNodeError4(error) {
  return error instanceof Error && "code" in error;
}

// src/adapters/discovery.ts
async function discoverPlatforms(options = {}) {
  const root = options.root ?? resolveWorkspaceRoot();
  const home = options.home ?? process.env.HOME ?? resolveWorkspaceRoot();
  const detected = [];
  for (const platform of platformDefinitions) {
    if (platform.id === "generic") continue;
    if (await isDetected(platform.id, "project", root)) detected.push(platformInfo(platform.id, "project", true, root));
    if (await isDetected(platform.id, "global", home)) detected.push(platformInfo(platform.id, "global", true, home));
  }
  detected.push(platformInfo("generic", "project", true, root));
  return dedupe(detected);
}
async function isDetected(platform, scope, root) {
  const definition = platformDefinitionById[platform];
  const paths = definition.detectionPaths ?? [platformSkillsDir(platform, scope)];
  if (platform === "codex" && scope === "project") paths.push("AGENTS.md");
  if (platform === "claude-code" && scope === "global") paths.push(".claude.json");
  for (const relativePath of paths) {
    if (await exists(join11(root, relativePath))) return true;
  }
  return false;
}
function platformInfo(platform, scope, detected, root) {
  const capabilities = platformDefinitionById[platform].capabilities;
  return { platform, scope, detected, root, capabilities, unavailable: unavailable(capabilities) };
}
function unavailable(capabilities) {
  return Object.entries(capabilities).filter(([, supported]) => !supported).map(([capability]) => capability);
}
function dedupe(platforms) {
  const seen = /* @__PURE__ */ new Set();
  return platforms.filter((platform) => {
    const key = `${platform.platform}:${platform.scope}:${platform.root}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
async function identifyPlatformInstallState(platform, options = {}) {
  const root = options.root ?? platform.root;
  const definition = platformDefinitionById[platform.platform];
  const skillPath = platformSkillPath(platform.platform, platform.scope, skillCommands[0]?.id ?? "");
  const skillExists = skillPath ? await exists(join11(root, skillPath)) : false;
  const rulesDir = definition.rulesDir ?? "";
  const rulesExist = rulesDir ? await exists(join11(root, platformSkillsDir(platform.platform, platform.scope), rulesDir)) : false;
  const hooksConfigPath = hookConfigPathFor(platform.platform, platform.scope);
  const hooksExist = hooksConfigPath ? await exists(join11(root, hooksConfigPath)) : false;
  const contractExists = await exists(join11(root, "AGENTS.md"));
  return {
    platform,
    components: {
      skills: skillExists ? "current" : "absent",
      rules: rulesExist ? "current" : "absent",
      hooks: hooksExist ? "current" : "absent",
      contract: contractExists ? "current" : "absent"
    }
  };
}
function hookConfigPathFor(platform, scope) {
  const hooks = {
    "claude-code": `${platformSkillsDir("claude-code", scope)}/settings.local.json`,
    gemini: `${platformSkillsDir("gemini", scope)}/settings.json`,
    windsurf: `${platformSkillsDir("windsurf", scope)}/hooks.json`,
    copilot: `${platformSkillsDir("github-copilot", scope)}/hooks/kata-guard.json`
  };
  const definition = platformDefinitionById[platform];
  return definition.hookFormat ? hooks[definition.hookFormat] ?? null : null;
}

// src/init-wizard.ts
import { stdin as defaultInput2, stdout as defaultOutput2 } from "node:process";
init_prompt();
var supportedPlatforms = platformDefinitions.map((platform) => platform.id).filter((platform) => platform !== "generic");
function renderInitBanner() {
  return [
    "\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2557\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2557\u2588\u2588\u2588\u2588\u2588\u2588\u2557  \u2588\u2588\u2588\u2588\u2588\u2557 \u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2557 \u2588\u2588\u2588\u2588\u2588\u2557",
    "\u2588\u2588\u2554\u2550\u2550\u2550\u2550\u255D\u255A\u2550\u2550\u2588\u2588\u2554\u2550\u2550\u255D\u2588\u2588\u2554\u2550\u2550\u2588\u2588\u2557\u2588\u2588\u2554\u2550\u2550\u2588\u2588\u2557\u255A\u2550\u2550\u2588\u2588\u2554\u2550\u2550\u255D\u2588\u2588\u2554\u2550\u2550\u2588\u2588\u2557",
    "\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2557   \u2588\u2588\u2551   \u2588\u2588\u2588\u2588\u2588\u2588\u2554\u255D\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2551   \u2588\u2588\u2551   \u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2551",
    "\u255A\u2550\u2550\u2550\u2550\u2588\u2588\u2551   \u2588\u2588\u2551   \u2588\u2588\u2554\u2550\u2550\u2588\u2588\u2557\u2588\u2588\u2554\u2550\u2550\u2588\u2588\u2551   \u2588\u2588\u2551   \u2588\u2588\u2554\u2550\u2550\u2588\u2588\u2551",
    "\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2551   \u2588\u2588\u2551   \u2588\u2588\u2551  \u2588\u2588\u2551\u2588\u2588\u2551  \u2588\u2588\u2551   \u2588\u2588\u2551   \u2588\u2588\u2551  \u2588\u2588\u2551",
    "\u255A\u2550\u2550\u2550\u2550\u2550\u2550\u255D   \u255A\u2550\u255D   \u255A\u2550\u255D  \u255A\u2550\u255D\u255A\u2550\u255D  \u255A\u2550\u255D   \u255A\u2550\u255D   \u255A\u2550\u255D  \u255A\u2550\u255D",
    "",
    "STRATA",
    "Knowledge and Rule Sedimentation for Agentic Coding"
  ].join("\n");
}
function planDetectedInit(platforms, settings = {}) {
  const scope = settings.scope ?? "project";
  const detected = platforms.filter((platform) => platform.scope === scope);
  const selected = detected.filter((platform) => supportedPlatforms.includes(platform.platform));
  return {
    scope,
    language: settings.language ?? "zh",
    detected,
    selected: selected.length > 0 ? selected : detected.filter((platform) => platform.platform === "generic")
  };
}
function mergeInstallReports(input) {
  return {
    command: input.command,
    mode: input.mode,
    scope: input.scope,
    selectedPlatforms: input.reports.map((report) => report.platform),
    reports: input.reports.map((report) => ({
      platform: report.platform,
      scope: report.scope,
      summary: {
        written: report.written.length,
        unchanged: report.unchanged.length,
        conflicts: report.conflicts.length,
        removed: report.removed.length,
        dryRun: report.dryRun
      },
      wiki: report.wiki
    }))
  };
}
async function promptInitPlan(platforms, io = {}) {
  const input = io.input ?? defaultInput2;
  const output = io.output ?? defaultOutput2;
  output.write(`${renderInitBanner()}

`);
  const language = await select("Language for skills", [
    { value: "en", label: "English" },
    { value: "zh", label: "\u4E2D\u6587" }
  ], { input, output });
  const scope = await select("Install scope", [
    { value: "project", label: "Project" },
    { value: "global", label: "Global" }
  ], { input, output });
  const candidates = platforms.filter((platform) => platform.scope === scope);
  const supported = candidates.filter((platform) => supportedPlatforms.includes(platform.platform));
  const fallback = candidates.filter((platform) => platform.platform === "generic");
  const defaults = supported.length > 0 ? supported : fallback;
  const selected = await checkbox("Platforms to install", candidates.map((p) => ({
    value: p,
    label: `${p.platform} (${p.root})`,
    checked: defaults.includes(p)
  })), { input, output });
  return { scope, language, detected: candidates, selected };
}
function optionsForWizardInstall(base, scope, platformRoot, language) {
  return {
    ...base,
    ...language ? { language } : {},
    ...scope === "project" ? { root: platformRoot } : { home: platformRoot }
  };
}

// src/cli.ts
init_prompt();

// src/workflow/orchestrator.ts
import { appendFile as appendFile2, mkdir as mkdir13, readFile as readFile17, writeFile as writeFile13 } from "node:fs/promises";
import { join as join21 } from "node:path";

// src/core/task.ts
import { mkdir as mkdir8, writeFile as writeFile8 } from "node:fs/promises";
import { join as join12 } from "node:path";
import { randomUUID as randomUUID5 } from "node:crypto";

// src/core/git.ts
import { execFileSync as execFileSync2 } from "node:child_process";
function currentGitBranch(root) {
  try {
    const branch = execFileSync2("git", ["-C", root, "branch", "--show-current"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
    return branch || null;
  } catch {
    return null;
  }
}

// src/core/task.ts
async function createTask(input) {
  const root = input.root ?? process.cwd();
  const now = (/* @__PURE__ */ new Date()).toISOString();
  const id = input.id ?? `task-${randomUUID5()}`;
  assertValidTaskId(id);
  const branch = currentGitBranch(root);
  const task = {
    id,
    title: input.title,
    phase: "intake",
    acceptance: input.acceptance.map((criterion) => ({ ...criterion })),
    ...branch ? { branch } : {},
    createdAt: now,
    updatedAt: now,
    ...input.workflowProfile ? { workflowProfile: input.workflowProfile } : {},
    ...input.ownedPaths?.length ? { ownedPaths: [...new Set(input.ownedPaths)].sort() } : {},
    ...input.acceptanceMatrix ? { acceptanceMatrix: input.acceptanceMatrix } : {}
  };
  const taskDirectory = join12(root, ".kata/tasks", task.id);
  await mkdir8(join12(root, ".kata/tasks"), { recursive: true });
  try {
    await mkdir8(taskDirectory);
  } catch (error) {
    if (isNodeError5(error) && error.code === "EEXIST") {
      throw new Error(`Task ${task.id} already exists; use kata status --change ${task.id} to resume it instead of kata open.`);
    }
    throw error;
  }
  await writeFile8(join12(taskDirectory, "task.json"), `${JSON.stringify(task, null, 2)}
`, "utf8");
  const state = {
    taskId: task.id,
    phase: "intake",
    actor: { id: "system", role: "system" },
    updatedAt: now
  };
  await appendStateEvent(root, {
    taskId: task.id,
    from: null,
    to: "intake",
    actor: state.actor,
    at: now
  });
  await writeCurrentState(root, state);
  return task;
}
function isNodeError5(error) {
  return typeof error === "object" && error !== null && "code" in error;
}

// src/core/context.ts
import { readdir as readdir5, readFile as readFile10 } from "node:fs/promises";
import { join as join13 } from "node:path";
async function buildContextManifest(input) {
  const root = input.root ?? process.cwd();
  const records = await readWikiRecords2(root);
  const requestedSourceRefs = new Set(input.sourceRefs);
  const authoritativeWiki = records.filter((record) => record.status === "verified" && isRelevantWikiRecord(record, requestedSourceRefs)).sort((left, right) => left.id.localeCompare(right.id));
  const excludedWiki = records.filter((record) => record.status !== "verified").sort((left, right) => left.id.localeCompare(right.id)).map((record) => ({
    id: record.id,
    status: record.status,
    reason: record.status === "stale" ? "stale" : "not-authoritative"
  }));
  const warnings = records.filter((record) => record.status === "stale").flatMap(
    (record) => record.sourceRefs.filter((sourceRef) => input.sourceRefs.includes(sourceRef)).map((sourceRef) => `Source ${sourceRef} has stale Wiki record ${record.id}; read source before relying on Wiki.`)
  ).sort();
  return {
    taskId: input.taskId,
    sourceRefs: [...input.sourceRefs],
    authoritativeWiki,
    excludedWiki,
    warnings
  };
}
function isRelevantWikiRecord(record, requestedSourceRefs) {
  return record.sourceRefs.some((sourceRef) => requestedSourceRefs.has(sourceRef)) || record.scope.some((scopeRef) => requestedSourceRefs.has(scopeRef));
}
async function readWikiRecords2(root) {
  const wikiDirectory = join13(root, ".kata/wiki");
  let files;
  try {
    files = await readdir5(wikiDirectory);
  } catch (error) {
    if (isNodeError6(error) && error.code === "ENOENT") return [];
    throw error;
  }
  const records = await Promise.all(
    files.filter((file) => file.endsWith(".json")).sort().map(async (file) => JSON.parse(await readFile10(join13(wikiDirectory, file), "utf8")))
  );
  return records;
}
function isNodeError6(error) {
  return error instanceof Error && "code" in error;
}

// src/workflow/orchestrator.ts
init_evidence();

// src/quality/judge.ts
init_evidence();
import { mkdir as mkdir9, writeFile as writeFile9 } from "node:fs/promises";
import { join as join14 } from "node:path";

// src/quality/acceptance-matrix.ts
import { execFile as execFile3 } from "node:child_process";
import { promisify as promisify3 } from "node:util";
var execFileAsync3 = promisify3(execFile3);
function requiresMatrix(workflowProfile) {
  return workflowProfile?.strictClosure === true || workflowProfile?.reviewMode === "strict";
}
function validateMatrix(acceptance, matrix) {
  if (!matrix) return [];
  const errors = [];
  const acIds = new Set(acceptance.map((ac) => ac.id).filter((id) => Boolean(id)));
  const matrixAcIds = /* @__PURE__ */ new Set();
  if (matrix.version !== 1) {
    errors.push({ message: "Unsupported acceptance matrix version" });
    return errors;
  }
  for (const row of matrix.rows) {
    if (!acIds.has(row.acceptanceId)) {
      errors.push({
        acceptanceId: row.acceptanceId,
        message: `Matrix row references unknown acceptance criterion: ${row.acceptanceId}`
      });
    }
    matrixAcIds.add(row.acceptanceId);
    if (!row.implementationPaths || row.implementationPaths.length === 0) {
      errors.push({
        acceptanceId: row.acceptanceId,
        message: `Matrix row for ${row.acceptanceId} must declare at least one implementation path`
      });
    }
    if (!row.testPaths || row.testPaths.length === 0) {
      errors.push({
        acceptanceId: row.acceptanceId,
        message: `Matrix row for ${row.acceptanceId} must declare at least one test path`
      });
    }
    if (!row.evidence || row.evidence.length === 0) {
      errors.push({
        acceptanceId: row.acceptanceId,
        message: `Matrix row for ${row.acceptanceId} must declare at least one evidence item`
      });
    }
    for (const path of [...row.implementationPaths, ...row.testPaths]) {
      if (path.includes("..") || path.startsWith("/") || path.includes(":\\")) {
        errors.push({
          acceptanceId: row.acceptanceId,
          message: `Matrix path must be repository-relative: ${path}`
        });
      }
    }
  }
  for (const acId of acIds) {
    if (!matrixAcIds.has(acId)) {
      errors.push({
        acceptanceId: acId,
        message: `Acceptance criterion ${acId} has no matrix row`
      });
    }
  }
  return errors;
}
function getMatrixRowForAc(matrix, acceptanceId) {
  return matrix?.rows.find((row) => row.acceptanceId === acceptanceId);
}
function validatePathCoverage(matrix, ownedPaths2) {
  if (!matrix) return { missingImplementationPaths: [], missingTestPaths: [] };
  const missingImplementationPaths = [];
  const missingTestPaths = [];
  for (const row of matrix.rows) {
    for (const implPath of row.implementationPaths) {
      if (!ownedPaths2.some((owned) => pathOverlaps(owned, implPath))) {
        missingImplementationPaths.push(implPath);
      }
    }
    for (const testPath of row.testPaths) {
      if (!ownedPaths2.some((owned) => pathOverlaps(owned, testPath))) {
        missingTestPaths.push(testPath);
      }
    }
  }
  return { missingImplementationPaths, missingTestPaths };
}
function pathOverlaps(owned, target) {
  const o = normalizePath(owned);
  const t = normalizePath(target);
  return o === t || t.startsWith(`${o}/`) || o.startsWith(`${t}/`);
}
function normalizePath(path) {
  return path.replaceAll("\\", "/").replace(/\/+$/, "");
}
function selectorMatches(evidenceCommand, testSelector) {
  if (evidenceCommand.includes(testSelector)) return true;
  const withoutCommonPrefix = testSelector.replace(/^(?:kata\/|packages\/[^/]+\/)?/, "");
  if (withoutCommonPrefix !== testSelector && evidenceCommand.includes(withoutCommonPrefix)) return true;
  return false;
}
function evidenceMatchesRow(row, evidenceCommand, evidenceKind) {
  for (const decl of row.evidence) {
    const kindMatch = decl.kind === evidenceKind;
    const commandMatch = evidenceCommand.includes(decl.command) || decl.command.startsWith("vitest ") && /(?:^|\/)vitest(?:\.mjs)?\s+run\b/.test(evidenceCommand) || decl.command.startsWith("tsc ") && /(?:^|\/)tsc\s+/.test(evidenceCommand);
    const selectorMatch = !decl.testSelector || selectorMatches(evidenceCommand, decl.testSelector);
    if (kindMatch && commandMatch && selectorMatch) return true;
  }
  return false;
}
async function discoverCodeGraphCandidates(root, matrix, ownedPaths2, runAffected = runCodeGraphAffected) {
  const sourcePaths = [...new Set(matrix.rows.flatMap((row) => row.implementationPaths).filter((path) => ownedPaths2.some((owned) => pathOverlaps(owned, path))))];
  if (sourcePaths.length === 0) return [];
  const sourcesByCandidate = /* @__PURE__ */ new Map();
  for (const sourcePath of sourcePaths) {
    const affectedTests = await runAffected(root, [sourcePath]);
    for (const affectedTest of affectedTests) {
      const path = normalizePath(affectedTest);
      const sources = sourcesByCandidate.get(path) ?? [];
      if (!sources.includes(sourcePath)) sources.push(sourcePath);
      sourcesByCandidate.set(path, sources);
    }
  }
  return [...sourcesByCandidate.entries()].map(([path, candidateSources]) => ({
    path,
    sourcePaths: candidateSources,
    reason: `CodeGraph reports this test is affected by sealed implementation paths: ${candidateSources.join(", ")}`
  }));
}
function classifyCodeGraphCandidates(matrix, ownedPaths2, waivers, candidates) {
  const disposition = {
    evidenceCoveredCandidates: [],
    ownedCandidates: [],
    waivedCandidates: [],
    unresolvedCandidates: []
  };
  const waivedPaths = new Set(waivers.map((waiver) => normalizePath(waiver.path)));
  for (const candidate of candidates) {
    const path = normalizePath(candidate.path);
    if (isEvidenceCoveredCandidate(matrix, path)) {
      disposition.evidenceCoveredCandidates.push(candidate);
    } else if (ownedPaths2.some((owned) => pathOverlaps(owned, path))) {
      disposition.ownedCandidates.push(candidate);
    } else if (waivedPaths.has(path)) {
      disposition.waivedCandidates.push(candidate);
    } else {
      disposition.unresolvedCandidates.push(candidate);
    }
  }
  return disposition;
}
function isEvidenceCoveredCandidate(matrix, candidatePath) {
  return matrix.rows.some((row) => row.testPaths.some((path) => normalizePath(path) === candidatePath) && row.evidence.some((evidence) => !evidence.testSelector || candidatePath.includes(evidence.testSelector)));
}
async function runCodeGraphAffected(root, sourcePaths) {
  const binary = process.env.STRATA_CODEGRAPH_BIN || "codegraph";
  let stdout;
  try {
    ({ stdout } = await execFileAsync3(binary, ["affected", ...sourcePaths], {
      cwd: root,
      maxBuffer: 1024 * 1024,
      env: codeGraphExecutionEnv()
    }));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`CodeGraph candidate discovery failed; strict sealing is refused: ${detail}`);
  }
  const output = stripAnsi(stdout);
  const reportsNoAffectedTests = /no .*test files.*affected|no .*affected.*test files/i.test(output);
  if (!output.includes("Affected test files") && !reportsNoAffectedTests) {
    throw new Error("CodeGraph candidate discovery returned an unrecognised result; strict sealing is refused.");
  }
  return output.split(/\r?\n/).map((line) => line.trim()).map((line) => line.replace(/^[•*-]\s*/, "")).filter((line) => isRepositoryRelativeTestPath(line));
}
function stripAnsi(value) {
  return value.replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "");
}
function isRepositoryRelativeTestPath(value) {
  return !value.startsWith("/") && !value.includes("..") && /(?:^|\/)(?:[^/]+\.)?(?:test|spec)\.[cm]?[jt]sx?$|(?:^|\/)test_[^/]+\.py$|(?:^|\/)[^/]+_test\.py$/.test(value);
}
async function readWaivers(root, taskId) {
  try {
    const { readFile: readFile25 } = await import("node:fs/promises");
    const { join: join29 } = await import("node:path");
    const raw = await readFile25(join29(root, ".kata/tasks", taskId, "waivers.json"), "utf8");
    return JSON.parse(raw).waivers;
  } catch {
    return [];
  }
}
async function writeWaivers(root, taskId, waivers) {
  const { mkdir: mkdir18, writeFile: writeFile19 } = await import("node:fs/promises");
  const { join: join29 } = await import("node:path");
  await mkdir18(join29(root, ".kata/tasks", taskId), { recursive: true });
  await writeFile19(
    join29(root, ".kata/tasks", taskId, "waivers.json"),
    `${JSON.stringify({ waivers, updatedAt: (/* @__PURE__ */ new Date()).toISOString() }, null, 2)}
`,
    "utf8"
  );
}
function validateWaivers(waivers) {
  return waivers.flatMap((waiver) => {
    const missing = [
      !waiver.path?.trim() ? "path" : void 0,
      !waiver.reason?.trim() ? "reason" : void 0,
      !waiver.approvedBy?.trim() ? "approvedBy" : void 0,
      !waiver.createdAt?.trim() ? "createdAt" : void 0
    ].filter((field) => Boolean(field));
    return missing.length > 0 ? [`Waiver for ${waiver.path || "<unknown>"} is missing ${missing.join(", ")}`] : [];
  });
}

// src/quality/judge.ts
async function judge(input) {
  const revisionIds = [...new Set(input.evidence.map((evidence) => evidence.revisionId).filter((id) => Boolean(id)))];
  if (revisionIds.length > 1) {
    const result2 = {
      taskId: input.taskId,
      result: "FAIL",
      diffHash: input.currentDiffHash,
      acceptance: input.acceptance.map((criterion) => ({
        id: criterion.id ?? "",
        result: "FAIL",
        repairScope: "cross_revision_evidence"
      }))
    };
    const root2 = input.root ?? process.cwd();
    await mkdir9(join14(root2, ".kata/tasks", input.taskId), { recursive: true });
    await writeFile9(join14(root2, ".kata/tasks", input.taskId, "judge.json"), `${JSON.stringify(result2, null, 2)}
`, "utf8");
    return result2;
  }
  const freshEvidence = input.evidence.filter((evidence) => checkFreshness(
    evidence,
    input.currentDiffHash,
    input.currentScopeHashes?.get(evidence.id)
  ).fresh);
  const freshPassingTestEvidence = freshEvidence.filter((evidence) => evidence.kind === "test" && evidence.exitCode === 0);
  const failingTestEvidence = freshEvidence.find((evidence) => evidence.kind === "test" && evidence.exitCode !== 0);
  const blockingFindings = input.findings.filter((finding) => finding.severity === "blocking" || input.reviewMode === "strict" && finding.severity === "major");
  const acceptance = input.acceptance.map((criterion) => {
    const acceptanceId = criterion.id ?? "";
    const blockingFinding = blockingFindings.find((finding) => !finding.acceptanceId || finding.acceptanceId === acceptanceId);
    if (failingTestEvidence) {
      return { id: acceptanceId, result: "FAIL", repairScope: "failing_evidence" };
    }
    if (freshPassingTestEvidence.length === 0 && input.evidence.some((evidence) => evidence.kind === "test")) {
      return { id: acceptanceId, result: "FAIL", repairScope: "stale_evidence" };
    }
    if (freshPassingTestEvidence.length === 0) {
      return { id: acceptanceId, result: "FAIL", repairScope: "missing_test_evidence" };
    }
    if (input.matrix) {
      const row = getMatrixRowForAc(input.matrix, acceptanceId);
      if (row && (row.verificationLevel === "integration" || row.verificationLevel === "entrypoint")) {
        const hasRowSpecificEvidence = freshEvidence.some((item) => evidenceMatchesRow(row, item.command, item.kind));
        if (!hasRowSpecificEvidence) return { id: acceptanceId, result: "FAIL", repairScope: "insufficient_evidence_level" };
      }
    }
    if (blockingFinding) {
      return { id: acceptanceId, result: "FAIL", repairScope: "blocking_review_finding" };
    }
    return { id: acceptanceId, result: "PASS", evidenceIds: freshPassingTestEvidence.map((evidence) => evidence.id) };
  });
  const result = {
    taskId: input.taskId,
    result: acceptance.every((criterion) => criterion.result === "PASS") ? "PASS" : "FAIL",
    diffHash: input.currentDiffHash,
    ...revisionIds[0] ? { revisionId: revisionIds[0] } : {},
    acceptance,
    evidenceIds: freshPassingTestEvidence.map((evidence) => evidence.id)
  };
  const root = input.root ?? process.cwd();
  await mkdir9(join14(root, ".kata/tasks", input.taskId), { recursive: true });
  await writeFile9(join14(root, ".kata/tasks", input.taskId, "judge.json"), `${JSON.stringify(result, null, 2)}
`, "utf8");
  return result;
}

// src/workflow/handoff.ts
import { readFile as readFile11 } from "node:fs/promises";
import { join as join15 } from "node:path";

// src/core/workflow-profile.ts
var isolationModes = ["current_worktree", "isolated_worktree", "git_flow", "user_decides"];
var developmentModes = ["tdd", "standard"];
var reviewModes = ["std", "strict", "security"];
var cometProjectInitStatuses = ["not_requested", "initialized", "skipped", "failed"];
var cometOpenStatuses = ["required", "acknowledged"];
function defaultWorkflowProfile() {
  return { version: 1, isolationMode: "current_worktree", developmentMode: "tdd", reviewMode: "std", comet: { projectInit: "not_requested", openStatus: "required" } };
}
function isWorkflowProfile(value) {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value;
  return candidate.version === 1 && isolationModes.includes(candidate.isolationMode) && developmentModes.includes(candidate.developmentMode) && reviewModes.includes(candidate.reviewMode) && typeof candidate.comet === "object" && candidate.comet !== null && cometProjectInitStatuses.includes(candidate.comet.projectInit) && cometOpenStatuses.includes(candidate.comet.openStatus) && (candidate.gitFlow === void 0 || isGitFlowState(candidate.gitFlow));
}
function profileGuardInstructions(profile, role) {
  if (!profile) return [];
  const instructions = [];
  if (profile.isolationMode === "isolated_worktree") instructions.push("Use the selected isolated worktree; do not silently move or recreate the current session worktree.");
  if (profile.isolationMode === "git_flow" && profile.gitFlow?.status === "active") instructions.push(`Work on ${profile.gitFlow.branch}; do not start, finish, or switch Git Flow branches outside the recorded task action.`);
  if (profile.isolationMode === "git_flow" && profile.gitFlow?.status !== "active") instructions.push("Git Flow branch creation is pending or failed; do not start, finish, or switch branches until the recorded task action succeeds.");
  if (profile.isolationMode === "user_decides") instructions.push("Ask the user to choose current versus isolated worktree before implementation changes.");
  if (role === "implementer" && profile.developmentMode === "tdd") instructions.push("Use TDD: write a focused failing test, verify RED, implement the minimum, then verify GREEN.");
  if (role === "reviewer" && profile.reviewMode === "strict") instructions.push("Strict review: inspect architecture boundaries, regression risk, and missing focused tests.");
  if (role === "reviewer" && profile.reviewMode === "security") instructions.push("Security review: inspect trust boundaries, secrets, dependency changes, input validation, and authorization effects.");
  return instructions;
}
async function acknowledgeCometOpen(root, taskId) {
  const { readFile: readFile25, writeFile: writeFile19 } = await import("node:fs/promises");
  const { join: join29 } = await import("node:path");
  const path = join29(root, ".kata/tasks", taskId, "task.json");
  const task = JSON.parse(await readFile25(path, "utf8"));
  const profile = isWorkflowProfile(task.workflowProfile) ? task.workflowProfile : defaultWorkflowProfile();
  const next = { ...profile, comet: { ...profile.comet, openStatus: "acknowledged" } };
  task.workflowProfile = next;
  await writeFile19(path, `${JSON.stringify(task, null, 2)}
`, "utf8");
  return next;
}
async function updateGitFlowProfile(root, taskId, gitFlow) {
  const { readFile: readFile25, writeFile: writeFile19 } = await import("node:fs/promises");
  const { join: join29 } = await import("node:path");
  const path = join29(root, ".kata/tasks", taskId, "task.json");
  const task = JSON.parse(await readFile25(path, "utf8"));
  const profile = isWorkflowProfile(task.workflowProfile) ? task.workflowProfile : defaultWorkflowProfile();
  const next = { ...profile, gitFlow };
  task.workflowProfile = next;
  await writeFile19(path, `${JSON.stringify(task, null, 2)}
`, "utf8");
  return next;
}
function isGitFlowState(value) {
  if (typeof value !== "object" || value === null) return false;
  const state = value;
  return (state.strategy === "git-flow" || state.strategy === "manual") && typeof state.branch === "string" && typeof state.baseBranch === "string" && (state.status === "active" || state.status === "pending_confirmation" || state.status === "failed") && (state.installation === void 0 || isGitFlowInstallation(state.installation));
}
function isGitFlowInstallation(value) {
  if (typeof value !== "object" || value === null) return false;
  const installation = value;
  return (installation.status === "installed" || installation.status === "failed" || installation.status === "unsupported") && (installation.command === void 0 || Array.isArray(installation.command) && installation.command.every((part) => typeof part === "string")) && (installation.manualCommand === void 0 || typeof installation.manualCommand === "string" && installation.manualCommand.length <= 500 && !/[\r\n]/.test(installation.manualCommand));
}

// src/workflow/handoff.ts
async function createHandoff(root, taskId, nextRole) {
  const taskRaw = await readFile11(join15(root, ".kata/tasks", taskId, "task.json"), "utf8");
  const task = JSON.parse(taskRaw);
  const stateRaw = await readFile11(join15(root, ".kata/tasks", taskId, "current-state.json"), "utf8");
  const state = JSON.parse(stateRaw);
  const evidenceDir = join15(root, ".kata/evidence");
  let evidenceIds = [];
  try {
    const { readdir: readdir11 } = await import("node:fs/promises");
    const files = await readdir11(evidenceDir);
    evidenceIds = files.filter((f) => f.startsWith(`${taskId}-`)).sort();
  } catch {
    evidenceIds = [];
  }
  const { readWikiRecords: readWikiRecords3 } = await Promise.resolve().then(() => (init_store(), store_exports));
  const wikiRecords = await readWikiRecords3(root);
  const wikiRecordIds = wikiRecords.filter((r) => r.validationTaskId === taskId).map((r) => r.id);
  const guardInstructions = [...buildGuardInstructions(state.phase, nextRole), ...profileGuardInstructions(task.workflowProfile, nextRole)];
  return {
    taskId,
    fromPhase: state.phase,
    toRole: nextRole,
    context: {
      taskTitle: task.title,
      acceptance: task.acceptance,
      evidenceIds,
      wikiRecordIds,
      sourceRefs: task.acceptance.filter((c) => c.id).map((c) => `${c.id}`)
    },
    guardInstructions,
    createdAt: (/* @__PURE__ */ new Date()).toISOString()
  };
}
function buildGuardInstructions(phase, nextRole) {
  const instructions = [];
  if (nextRole === "implementer") {
    instructions.push("Write only to src/, tests/, and task-owned .kata paths.");
    instructions.push("All acceptance criteria must have stable AC-[0-9]+ ids before implement.");
    instructions.push("Do not modify .kata/schemas/, docs/superpowers/rules/, or wiki/verified/.");
  }
  if (nextRole === "designer") {
    instructions.push("Write only to task design artifacts, docs/, and task-owned .kata paths.");
    instructions.push("Clarify acceptance criteria before implementation.");
    instructions.push("Do not modify implementation files during design.");
  }
  if (nextRole === "reviewer") {
    instructions.push("You may only write review findings to review.json.");
    instructions.push("Check that acceptance criteria are met by the implementation.");
    instructions.push("Assign severity: blocking (must fix), major, minor, note.");
  }
  if (nextRole === "judge") {
    instructions.push("You may only write the judge result to judge.json.");
    instructions.push("Evaluate each acceptance criterion independently.");
    instructions.push("Return PASS only if all criteria have fresh passing test evidence and no blocking findings.");
  }
  if (nextRole === "distiller") {
    instructions.push("You may only write Wiki candidates to .kata/wiki/.");
    instructions.push("Only promote candidates from tasks with Judge PASS.");
    instructions.push("Include source references, hashes, and evidence links.");
  }
  if (phase === "hardVerify" && nextRole !== "judge") {
    instructions.push("Fresh evidence must be collected after any repair.");
  }
  return instructions;
}

// src/quality/project-checks.ts
import { readdir as readdir6, readFile as readFile12 } from "node:fs/promises";
import { join as join16 } from "node:path";
async function resolveBuildChecks(root, config, ownedPaths2 = []) {
  const configured = config.quality?.buildChecks?.map((check) => ({
    name: check.name ?? inferCheckName(check.command, check.args ?? []),
    kind: check.kind ?? inferEvidenceKind(check.name ?? check.args?.[0] ?? check.command),
    command: check.command,
    args: check.args ?? [],
    cwd: root,
    timeoutMs: check.timeoutMs ?? defaultTimeoutMs(check.name ?? check.args?.[0] ?? check.command)
  })) ?? [];
  const kataScopedTask = ownedPaths2.length > 0 && ownedPaths2.every(isKataScopedPath);
  const discovered = kataScopedTask ? [] : await discoverProjectQualityChecks(root);
  const defaults = kataScopedTask || configured.length > 0 || discovered.length > 0 ? [] : [
    { name: "typecheck", kind: "typecheck", command: process.execPath, args: ["node_modules/typescript/lib/tsc.js", "--noEmit"], cwd: root, timeoutMs: 6e4 },
    { name: "test", kind: "test", command: process.execPath, args: ["node_modules/vitest/dist/cli.js", "run"], cwd: root, timeoutMs: 12e4 }
  ];
  const merged = [...configured, ...discovered, ...defaults];
  return dedupeChecks(merged);
}
function isKataScopedPath(path) {
  return path === "kata" || path.startsWith("kata/") || path === "docs" || path.startsWith("docs/");
}
async function discoverProjectQualityChecks(root) {
  const files = await candidateConstraintFiles(root);
  const commands = [];
  for (const file of files) {
    const content = await readFile12(file, "utf8").catch(() => "");
    commands.push(...extractAcceptanceGateCommands(content));
  }
  return dedupe2(commands).map((command) => commandLineToCheck(root, command)).filter((check) => Boolean(check));
}
async function candidateConstraintFiles(root) {
  const files = [join16(root, "AGENTS.md")];
  const skillsRoot = join16(root, ".agents/skills");
  let skillNames = [];
  try {
    skillNames = await readdir6(skillsRoot);
  } catch {
    skillNames = [];
  }
  for (const skillName of skillNames.sort()) {
    files.push(join16(skillsRoot, skillName, "SKILL.md"));
  }
  return files;
}
function extractAcceptanceGateCommands(markdown) {
  const lines = markdown.split(/\r?\n/);
  const commands = [];
  let inAcceptanceGate = false;
  let inFence = false;
  for (const line of lines) {
    if (/^#{1,3}\s+/.test(line)) {
      inAcceptanceGate = /acceptance gate|验收|完成前|before finishing/i.test(line);
      inFence = false;
      continue;
    }
    if (!inAcceptanceGate) continue;
    if (/^```/.test(line.trim())) {
      inFence = !inFence;
      continue;
    }
    if (!inFence) continue;
    const command = normalizeCommandLine(line);
    if (command) commands.push(command);
  }
  return commands;
}
function normalizeCommandLine(line) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return null;
  if (!/^make\s+[A-Za-z0-9_.-]+$/.test(trimmed)) return null;
  return trimmed;
}
function commandLineToCheck(root, commandLine) {
  const [command, target] = commandLine.split(/\s+/);
  if (!command || !target) return null;
  return {
    name: target,
    kind: inferEvidenceKind(target),
    command,
    args: [target],
    cwd: root,
    timeoutMs: defaultTimeoutMs(target)
  };
}
function inferCheckName(command, args) {
  if (command === "make" && args[0]) return args[0];
  return command.replace(/[^A-Za-z0-9_.-]+/g, "-").replace(/^-|-$/g, "") || "check";
}
function inferEvidenceKind(name) {
  const normalized = name.toLowerCase();
  if (normalized.includes("lint")) return "lint";
  if (normalized.includes("type") || normalized.includes("pyright") || normalized.includes("mypy")) return "typecheck";
  if (normalized.includes("test") || normalized.includes("cov")) return "test";
  if (normalized.includes("security") || normalized.includes("audit")) return "security";
  return "ci";
}
function defaultTimeoutMs(name) {
  const normalized = name.toLowerCase();
  if (normalized === "test" || normalized.startsWith("test-")) return 9e5;
  if (normalized.includes("test") || normalized.includes("cov")) return 6e5;
  if (normalized.includes("type") || normalized.includes("pyright") || normalized.includes("mypy")) return 18e4;
  if (normalized.includes("lint")) return 18e4;
  return 12e4;
}
function dedupe2(values) {
  return [...new Set(values)];
}
function dedupeChecks(checks) {
  const seen = /* @__PURE__ */ new Set();
  return checks.filter((check) => {
    const key = `${check.name ?? ""}:${check.command}:${(check.args ?? []).join(",")}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// src/wiki/closure.ts
init_store();
import { mkdir as mkdir11, readFile as readFile13, writeFile as writeFile11 } from "node:fs/promises";
import { join as join17 } from "node:path";
async function ensureWikiClosure(root, taskId) {
  const existing = await readWikiClosure(root, taskId);
  if (existing) return existing;
  const closure = { taskId, decision: "deferred", reason: "Awaiting a knowledge-closure decision.", candidateIds: [], updatedAt: (/* @__PURE__ */ new Date()).toISOString() };
  await persist(root, closure);
  return closure;
}
async function readWikiClosure(root, taskId) {
  try {
    const parsed = JSON.parse(await readFile13(pathFor(root, taskId), "utf8"));
    return isWikiClosure(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
async function writeWikiClosure(root, taskId, input) {
  const closure = {
    taskId,
    decision: input.decision,
    reason: input.reason.trim(),
    candidateIds: [...new Set(input.candidateIds ?? [])].sort(),
    updatedAt: (/* @__PURE__ */ new Date()).toISOString()
  };
  await persist(root, closure);
  return closure;
}
async function evaluateWikiClosure(root, taskId) {
  const closure = await readWikiClosure(root, taskId);
  if (!closure) return { valid: false, reason: "missing" };
  if (!closure.reason) return { valid: false, reason: "reason_required", closure };
  if (closure.decision === "deferred") return { valid: false, reason: "deferred", closure };
  if (closure.decision === "not_applicable") return { valid: true, decision: "not_applicable", closure };
  if (closure.candidateIds.length === 0) return { valid: false, reason: "candidate_required", closure };
  const records = await readWikiRecords(root);
  const validIds = new Set(records.filter((record) => record.status === "candidate" || record.status === "verified").map((record) => record.id));
  if (closure.candidateIds.some((id) => !validIds.has(id))) return { valid: false, reason: "candidate_missing", closure };
  return { valid: true, decision: "captured", closure };
}
function pathFor(root, taskId) {
  return join17(root, ".kata/tasks", taskId, "wiki-closure.json");
}
async function persist(root, closure) {
  await mkdir11(join17(root, ".kata/tasks", closure.taskId), { recursive: true });
  await writeFile11(pathFor(root, closure.taskId), `${JSON.stringify(closure, null, 2)}
`, "utf8");
}
function isWikiClosure(value) {
  if (typeof value !== "object" || value === null) return false;
  const closure = value;
  return typeof closure.taskId === "string" && (closure.decision === "captured" || closure.decision === "not_applicable" || closure.decision === "deferred") && typeof closure.reason === "string" && Array.isArray(closure.candidateIds) && closure.candidateIds.every((id) => typeof id === "string") && typeof closure.updatedAt === "string";
}

// src/wiki/provenance.ts
init_store();
init_record();
import { readFile as readFile14, readdir as readdir7 } from "node:fs/promises";
import { join as join18 } from "node:path";
async function proposeFromPassedTask(root, taskId, input) {
  const judgePath = join18(root, ".kata/tasks", taskId, "judge.json");
  const judgeRaw = await readFile14(judgePath, "utf8");
  const judge2 = JSON.parse(judgeRaw);
  if (judge2.taskId !== taskId || judge2.result !== "PASS") {
    throw new Error(`Cannot generate Wiki candidate: task ${taskId} has not passed Judge (result: ${judge2.result})`);
  }
  const statePath = join18(root, ".kata/tasks", taskId, "current-state.json");
  const stateRaw = await readFile14(statePath, "utf8");
  const state = JSON.parse(stateRaw);
  if (state.phase !== "distill" && state.phase !== "archive") {
    throw new Error(`Cannot generate Wiki candidate: task ${taskId} must be in distill or archive phase (current: ${state.phase})`);
  }
  const evidencePath = join18(root, `.kata/evidence/${taskId}-hard.json`);
  let evidenceIds = [];
  try {
    const evidenceRaw = await readFile14(evidencePath, "utf8");
    const parsed = JSON.parse(evidenceRaw);
    if (parsed.id) evidenceIds = [parsed.id];
  } catch {
    const { readdir: readdir11 } = await import("node:fs/promises");
    const evidenceDir = join18(root, ".kata/evidence");
    const files = await readdir11(evidenceDir);
    const taskEvidenceFiles = files.filter((f) => f.startsWith(`${taskId}-`));
    for (const file of taskEvidenceFiles) {
      const raw = await readFile14(join18(evidenceDir, file), "utf8");
      const parsed = JSON.parse(raw);
      if (parsed.id) evidenceIds.push(parsed.id);
    }
  }
  const record = {
    id: `wiki-${taskId}`,
    statement: input.statement,
    scope: [...input.scope],
    kind: input.kind,
    sourceRefs: [...input.sourceRefs],
    sourceHashes: { ...input.sourceHashes ?? {} },
    validationTaskId: taskId,
    evidenceIds,
    status: "candidate",
    lastVerifiedAt: (/* @__PURE__ */ new Date()).toISOString(),
    createdAt: (/* @__PURE__ */ new Date()).toISOString(),
    updatedAt: (/* @__PURE__ */ new Date()).toISOString()
  };
  await writeWikiRecord(root, record);
  return [record];
}
async function distillPassedTaskKnowledge(root, taskId) {
  const existing = await readWikiClosure(root, taskId);
  if (existing && existing.decision !== "deferred" && existing.reason) {
    return existing.decision === "captured" ? { decision: "captured", candidateIds: existing.candidateIds, records: [], closure: existing } : { decision: "not_applicable", candidateIds: [], records: [], closure: existing };
  }
  const task = await readTask2(root, taskId).catch((error) => ({ error }));
  if ("error" in task) return { decision: "deferred", candidateIds: [], records: [], reason: "task artifact is missing or unreadable" };
  const judge2 = await readJson(root, `.kata/tasks/${taskId}/judge.json`).catch(() => null);
  if (!judge2 || judge2.taskId !== taskId || judge2.result !== "PASS") {
    return { decision: "deferred", candidateIds: [], records: [], reason: "Judge PASS is required before Wiki distillation" };
  }
  const state = await readJson(root, `.kata/tasks/${taskId}/current-state.json`).catch(() => null);
  if (!state || state.phase !== "distill" && state.phase !== "archive") {
    return { decision: "deferred", candidateIds: [], records: [], reason: `Task must be in distill or archive phase before Wiki distillation (current: ${state?.phase ?? "unknown"})` };
  }
  const design = await readText(root, `.kata/tasks/${taskId}/design.md`);
  const sourceRefs = await sourceRefsForTask(root, taskId, task.ownedPaths ?? []);
  const sourceHashes = await hashSources(root, sourceRefs).catch(() => null);
  if (!sourceHashes) {
    return { decision: "deferred", candidateIds: [], records: [], reason: "Could not compute source hashes for Wiki candidate provenance" };
  }
  if (!hasReusableKnowledge(task, design)) {
    const closure2 = await writeWikiClosure(root, taskId, {
      decision: "not_applicable",
      reason: "No reusable project knowledge detected from task title, acceptance criteria, design, or owned paths."
    });
    return { decision: "not_applicable", candidateIds: [], records: [], closure: closure2 };
  }
  const records = await proposeFromPassedTask(root, taskId, {
    statement: statementFor(taskId, task, design),
    scope: [.../* @__PURE__ */ new Set([...task.ownedPaths ?? [], `.kata/tasks/${taskId}/task.json`, `.kata/tasks/${taskId}/design.md`])],
    kind: kindFor(task, design),
    sourceRefs,
    sourceHashes
  });
  const candidateIds = records.map((record) => record.id);
  const closure = await writeWikiClosure(root, taskId, {
    decision: "captured",
    reason: "Automatically captured reusable project knowledge from Judge-PASS task artifacts.",
    candidateIds
  });
  return { decision: "captured", candidateIds, records, closure };
}
async function readTask2(root, taskId) {
  return readJson(root, `.kata/tasks/${taskId}/task.json`);
}
async function readJson(root, path) {
  return JSON.parse(await readFile14(join18(root, path), "utf8"));
}
async function readText(root, path) {
  try {
    return await readFile14(join18(root, path), "utf8");
  } catch {
    return "";
  }
}
async function sourceRefsForTask(root, taskId, ownedPaths2) {
  const refs = [
    `.kata/tasks/${taskId}/task.json`,
    `.kata/tasks/${taskId}/design.md`,
    `.kata/tasks/${taskId}/review.json`,
    `.kata/tasks/${taskId}/judge.json`,
    ...ownedPaths2
  ];
  try {
    const evidenceFiles = await readdir7(join18(root, ".kata/evidence"));
    refs.push(...evidenceFiles.filter((file) => file.startsWith(`${taskId}-`)).map((file) => `.kata/evidence/${file}`));
  } catch {
  }
  const existing = [];
  for (const ref of refs) {
    try {
      await readFile14(join18(root, ref), "utf8");
      existing.push(ref);
    } catch {
    }
  }
  return [...new Set(existing)].sort();
}
async function hashSources(root, refs) {
  const hashes = {};
  for (const ref of refs) {
    hashes[ref] = computeFileHash(await readFile14(join18(root, ref), "utf8"));
  }
  return hashes;
}
function hasReusableKnowledge(task, design) {
  const text = `${task.title}
${task.acceptance.map((item) => item.statement).join("\n")}
${design}
${(task.ownedPaths ?? []).join("\n")}`;
  if (/(mechanical|formatting|typo|spelling|pure test|fixture only|局部|机械|拼写|格式)/i.test(text)) return false;
  return /(workflow|architecture|contract|convention|lifecycle|wiki|evidence|handoff|revision|policy|archive|distill|governance|自动|规则|流程|架构|约束)/i.test(text);
}
function kindFor(task, design) {
  const text = `${task.title}
${design}`.toLowerCase();
  if (/workflow|archive|distill|lifecycle|handoff|流程/.test(text)) return "workflow-convention";
  if (/architecture|架构/.test(text)) return "architecture-note";
  if (/policy|governance|治理/.test(text)) return "governance-rule";
  return "implementation-note";
}
function statementFor(taskId, task, design) {
  const acceptanceSummary = task.acceptance.map((item) => item.id ? `${item.id}: ${item.statement}` : item.statement).join(" ");
  const durableHint = design.match(/(?:## 目标|## 方案|## 决策)([\s\S]{0,360})/)?.[1]?.replace(/\s+/g, " ").trim();
  return [
    `Task ${taskId} established reusable ${kindFor(task, design)} knowledge: ${task.title}.`,
    `Acceptance covered ${acceptanceSummary}.`,
    durableHint ? `Durable rule: ${durableHint}` : "Durable rule applies to the task-owned implementation scope and gate artifacts."
  ].join(" ");
}

// src/workflow/navigation.ts
import { readdir as readdir8, readFile as readFile16 } from "node:fs/promises";
import { join as join20 } from "node:path";

// src/quality/repair-obligations.ts
import { mkdir as mkdir12, readFile as readFile15, writeFile as writeFile12 } from "node:fs/promises";
import { join as join19 } from "node:path";
async function readObligations(root, taskId) {
  try {
    const raw = await readFile15(obligationsPath(root, taskId), "utf8");
    return JSON.parse(raw).obligations;
  } catch {
    return [];
  }
}
async function persistBlockingJudgeResult(root, taskId, acceptanceResults) {
  const existing = await readObligations(root, taskId);
  const now = (/* @__PURE__ */ new Date()).toISOString();
  const newObligations = [];
  for (const ac of acceptanceResults) {
    if (ac.result !== "FAIL") continue;
    const existingObligation = existing.find(
      (o) => o.acceptanceId === ac.id && o.source === "judge" && !o.resolvedAt
    );
    if (existingObligation) continue;
    const obligation = {
      id: `obligation-${crypto.randomUUID()}`,
      taskId,
      source: "judge",
      acceptanceId: ac.id,
      severity: "blocking",
      message: `Judge FAIL for ${ac.id}`,
      createdAt: now
    };
    newObligations.push(obligation);
  }
  const merged = [...existing, ...newObligations];
  await writeObligations(root, taskId, merged);
  return newObligations;
}
async function resolveObligationsForRevision(root, taskId, revisionId, resolvedAcceptanceIds, evidenceIds, matrix, evidence = []) {
  const existing = await readObligations(root, taskId);
  const now = (/* @__PURE__ */ new Date()).toISOString();
  let changed = false;
  for (const obligation of existing) {
    if (obligation.resolvedAt) continue;
    const row = obligation.acceptanceId ? getMatrixRowForAc(matrix, obligation.acceptanceId) : void 0;
    const matchedEvidence = matrix && row ? evidence.filter((item) => item.exitCode === 0 && evidenceMatchesRow(row, item.command, item.kind)) : evidence.filter((item) => evidenceIds.includes(item.id) && item.exitCode === 0);
    const hasMappedEvidence = !matrix || matchedEvidence.length > 0;
    if (obligation.acceptanceId && resolvedAcceptanceIds.includes(obligation.acceptanceId) && hasMappedEvidence) {
      obligation.resolvedAt = now;
      obligation.resolvedByRevisionId = revisionId;
      obligation.resolvedEvidenceIds = matchedEvidence.map((item) => item.id);
      changed = true;
    }
  }
  if (changed) {
    await writeObligations(root, taskId, existing);
  }
  return existing;
}
function obligationsPath(root, taskId) {
  return join19(root, ".kata/tasks", taskId, "repair-obligations.json");
}
async function writeObligations(root, taskId, obligations) {
  await mkdir12(join19(root, ".kata/tasks", taskId), { recursive: true });
  const record = {
    obligations,
    updatedAt: (/* @__PURE__ */ new Date()).toISOString()
  };
  await writeFile12(obligationsPath(root, taskId), `${JSON.stringify(record, null, 2)}
`, "utf8");
}

// src/workflow/navigation.ts
async function readUpstreamSummary(root, taskId) {
  const evidenceFiles = await listEvidenceFiles(root, taskId);
  const evidence = await Promise.all(evidenceFiles.map((file) => readJsonFile(join20(root, ".kata/evidence", file))));
  const revisionIds = [...new Set(evidence.map((item) => item?.revisionId).filter((id) => Boolean(id)))];
  const mixedRevision = revisionIds.length > 1;
  const currentRevisionId = revisionIds.length === 1 ? revisionIds[0] : void 0;
  const review = currentRevisionId && !mixedRevision ? onlyCurrentRevision(await readJsonFile(join20(root, ".kata/tasks", taskId, "review.json")), currentRevisionId) : !mixedRevision ? await readJsonFile(join20(root, ".kata/tasks", taskId, "review.json")) : null;
  const findings = review?.findings ?? [];
  const invalidReviewApproval = review?.status === "approved" && !review.reviewEvidence?.trim();
  const judge2 = currentRevisionId && !mixedRevision ? onlyCurrentRevision(await readJsonFile(join20(root, ".kata/tasks", taskId, "judge.json")), currentRevisionId) : !mixedRevision ? await readJsonFile(join20(root, ".kata/tasks", taskId, "judge.json")) : null;
  const failedAcceptance = judge2?.acceptance?.filter((item) => item.result === "FAIL") ?? [];
  const verify = currentRevisionId && !mixedRevision ? onlyCurrentRevision(await readJsonFile(join20(root, ".kata/tasks", taskId, "verify.json")), currentRevisionId) : !mixedRevision ? await readJsonFile(join20(root, ".kata/tasks", taskId, "verify.json")) : null;
  const failedVerifyAcceptance = verify?.acceptance?.filter((item) => item.result === "FAIL") ?? [];
  const wikiClosure = await evaluateWikiClosure(root, taskId);
  const obligations = await readObligations(root, taskId);
  const unresolvedObligations = obligations.filter((o) => !o.resolvedAt);
  const task = await readJsonFile(join20(root, ".kata/tasks", taskId, "task.json"));
  const reviewMode = task?.workflowProfile?.reviewMode;
  return {
    ...currentRevisionId ? { currentRevisionId } : {},
    reviewFindings: findings.length,
    blockingFindings: findings.filter((finding) => finding.severity === "blocking").length,
    majorFindings: findings.filter((finding) => finding.severity === "major").length,
    ...reviewMode ? { reviewMode } : {},
    reviewReady: review?.status === "approved" && Boolean(review.reviewEvidence?.trim()),
    ...invalidReviewApproval ? { invalidReviewApproval: true } : {},
    ...judge2?.result ? { judgeResult: judge2.result } : {},
    ...verify?.result ? { verifyResult: verify.result } : {},
    failedAcceptance: failedAcceptance.length,
    failedVerifyAcceptance: failedVerifyAcceptance.length,
    repairScopes: failedAcceptance.map((item) => item.repairScope).filter((scope) => Boolean(scope)),
    verifyRepairScopes: failedVerifyAcceptance.map((item) => item.repairScope).filter((scope) => Boolean(scope)),
    wikiClosureValid: wikiClosure.valid,
    ...!wikiClosure.valid ? { wikiClosureReason: wikiClosure.reason } : {},
    evidenceFiles,
    failingEvidence: evidence.filter((item) => item && typeof item.exitCode === "number" && item.exitCode !== 0).length,
    unresolvedObligations: unresolvedObligations.length,
    unresolvedObligationAcIds: [...new Set(unresolvedObligations.map((o) => o.acceptanceId).filter((id) => Boolean(id)))],
    ...task && !task.acceptanceMatrix ? { missingAcceptanceMatrix: true } : {},
    ...mixedRevision ? { mixedRevisionEvidence: true } : {}
  };
}
function onlyCurrentRevision(artifact, currentRevisionId) {
  return artifact?.revisionId === currentRevisionId ? artifact : null;
}
function suggestCandidateAction(phase, upstream) {
  if (phase === "archive") {
    return { nextSkill: "/kata", role: "dispatcher", reason: "archived_task", priority: 0 };
  }
  if (upstream.mixedRevisionEvidence) {
    return {
      nextSkill: "/kata-build",
      role: "implementer",
      reason: "repair_mixed_revision_evidence",
      priority: 2100
    };
  }
  if (upstream.unresolvedObligations > 0) {
    if (upstream.missingAcceptanceMatrix) {
      return {
        nextSkill: "/kata-design",
        role: "designer",
        reason: "migrate_legacy_acceptance_matrix",
        priority: 2050 + upstream.unresolvedObligations,
        acceptanceIds: upstream.unresolvedObligationAcIds
      };
    }
    return {
      nextSkill: "/kata-build",
      role: "implementer",
      reason: "repair_unresolved_obligations",
      priority: 2e3 + upstream.unresolvedObligations
    };
  }
  if (phase === "review" && upstream.blockingFindings > 0) {
    return {
      nextSkill: "/kata-build",
      role: "implementer",
      reason: "repair_blocking_review_findings",
      priority: 1e3 + upstream.blockingFindings
    };
  }
  if (phase === "review" && upstream.reviewMode === "strict" && upstream.majorFindings > 0) {
    return {
      nextSkill: "/kata-build",
      role: "implementer",
      reason: "repair_strict_major_findings",
      priority: 980 + upstream.majorFindings
    };
  }
  if (phase === "review" && upstream.invalidReviewApproval) {
    return {
      nextSkill: "/kata-review",
      role: "reviewer",
      reason: "invalid_review_approval",
      priority: 975
    };
  }
  if (phase === "review" && !upstream.reviewReady) {
    return {
      nextSkill: "/kata-review",
      role: "reviewer",
      reason: "complete_review_conclusion",
      priority: 970
    };
  }
  if (phase === "judge" && upstream.judgeResult === "FAIL") {
    return {
      nextSkill: "/kata-build",
      role: "implementer",
      reason: "repair_failed_judge",
      priority: 900 + upstream.failedAcceptance
    };
  }
  if (upstream.failingEvidence > 0) {
    return {
      nextSkill: "/kata-build",
      role: "implementer",
      reason: "repair_failing_evidence",
      priority: 800 + upstream.failingEvidence
    };
  }
  if (phase === "hardVerify" && upstream.verifyResult === "FAIL" && upstream.wikiClosureValid === false && upstream.failedVerifyAcceptance === 0) {
    return {
      nextSkill: "/kata-wiki-enrich",
      role: "implementer",
      reason: "resolve_wiki_closure",
      priority: 770
    };
  }
  if (phase === "hardVerify" && upstream.verifyResult === "FAIL") {
    if (upstream.verifyRepairScopes.length > 0 && upstream.verifyRepairScopes.every((scope) => scope === "stale_evidence")) {
      return {
        nextSkill: "/kata-build",
        role: "implementer",
        reason: "rebuild_stale_evidence",
        priority: 760 + upstream.failedVerifyAcceptance
      };
    }
    return {
      nextSkill: "/kata-build",
      role: "implementer",
      reason: "repair_failed_verify",
      priority: 750 + upstream.failedVerifyAcceptance
    };
  }
  if (phase === "hardVerify" && upstream.verifyResult === "PASS") {
    return { nextSkill: "/kata-review", role: "reviewer", reason: "review_fresh_implementation", priority: 740 };
  }
  if (phase === "hardVerify") {
    return { nextSkill: "/kata-verify", role: "reviewer", reason: "verify_fresh_implementation", priority: 700 };
  }
  if (phase === "review") {
    return { nextSkill: "/kata-judge", role: "judge", reason: "judge_reviewed_change", priority: 600 };
  }
  if (phase === "judge" || phase === "distill") {
    return { nextSkill: "/kata-archive", role: "distiller", reason: "archive_judged_change", priority: 500 };
  }
  if (phase === "plan") {
    return { nextSkill: "/kata-build", role: "implementer", reason: "choose_execution_mode", priority: 400 };
  }
  if (phase === "implement") {
    return { nextSkill: "/kata-build", role: "implementer", reason: "continue_implementation", priority: 400 };
  }
  if (phase === "intake") {
    return { nextSkill: "/kata-design", role: "designer", reason: "design_intake_task", priority: 300 };
  }
  return { nextSkill: "/kata", role: "dispatcher", reason: "inspect_task", priority: 0 };
}
function nextSkillForPhase(phase) {
  switch (phase) {
    case "intake":
      return "/kata-design";
    case "plan":
    case "implement":
      return "/kata-build";
    case "hardVerify":
      return "/kata-verify";
    case "review":
      return "/kata-judge";
    case "judge":
    case "distill":
      return "/kata-archive";
    case "archive":
      return "/kata";
  }
}
function nextActionForTask(taskId, nextSkill, role, reason) {
  const cliVerb = skillToCliVerb(nextSkill);
  const gate = trustBoundaryForReason(reason);
  const seal = reason === "rebuild_stale_evidence" ? " --seal" : "";
  const wikiClosure = reason === "resolve_wiki_closure";
  return {
    taskId,
    nextSkill,
    slashCommand: `${nextSkill} ${taskId}${seal}`,
    cliCommand: wikiClosure ? `kata wiki closure --task ${taskId} --decision <captured|not_applicable> --reason <reason>` : cliVerb ? `kata ${cliVerb} --change ${taskId}${seal}` : `kata status --change ${taskId}`,
    role,
    reason,
    requiresUserConfirmation: gate !== null || wikiClosure,
    modelOrPlatformSwitchAllowed: gate !== null,
    ...gate ? { trustBoundary: gate } : {},
    ...gate ? { pauseInstruction: pauseInstructionForBoundary(gate) } : {},
    ...wikiClosure ? { pauseInstruction: "\u5B9E\u73B0\u9A8C\u8BC1\u5DF2\u901A\u8FC7\uFF1B\u8BF7\u51B3\u5B9A\u672C\u4EFB\u52A1\u7684\u77E5\u8BC6\u95ED\u73AF\u662F captured \u8FD8\u662F not_applicable\uFF0C\u518D\u91CD\u65B0\u6267\u884C /kata-verify\u3002" } : {}
  };
}
function statusActionPrompts(suggestion) {
  if (suggestion.reason === "choose_execution_mode") {
    return [
      "\u8BBE\u8BA1\u5DF2\u5B8C\u6210\uFF0C\u5B9E\u65BD\u524D\u8BF7\u786E\u8BA4\u6267\u884C\u65B9\u5F0F\uFF1A\u7559\u5728\u5F53\u524D\u5E73\u53F0\u7EE7\u7EED\uFF0C\u6216\u5728\u4EFB\u610F\u5DF2\u8BC6\u522B\u5E73\u53F0\u63A5\u624B\u81EA\u52A8\u751F\u6210\u7684\u5E73\u53F0\u65E0\u5173\u4EA4\u63A5\u5305\u3002Kata \u4E0D\u4F1A\u81EA\u52A8\u5207\u6362\u5E73\u53F0\u6216\u6A21\u578B\u3002"
    ];
  }
  if (suggestion.reason === "continue_implementation") {
    return ["\u5F53\u524D\u5904\u4E8E\u5B9E\u65BD\u9636\u6BB5\uFF1A\u5148\u5199\u805A\u7126\u7684\u5931\u8D25\u6D4B\u8BD5\uFF08RED\uFF09\uFF0C\u518D\u6700\u5C0F\u5B9E\u73B0\u5E76\u8FD0\u884C GREEN\uFF1B\u5B8C\u6210\u540E\u4F7F\u7528 /kata-build <task> --seal \u5C01\u5B58\u8BC1\u636E\u3002"];
  }
  if (suggestion.reason === "rebuild_stale_evidence") {
    return ["\u4EE3\u7801\u5728\u4E0A\u6B21\u8BC1\u636E\u5C01\u5B58\u540E\u53D1\u751F\u53D8\u5316\uFF1B\u65E0\u9700\u91CD\u505A\u5DF2\u5B8C\u6210\u5B9E\u73B0\uFF0C\u5148\u6267\u884C /kata-build <task> --seal \u91CD\u65B0\u8FD0\u884C\u68C0\u67E5\u5E76\u5C01\u5B58\u65B0\u8BC1\u636E\u3002"];
  }
  if (suggestion.reason === "resolve_wiki_closure") {
    return ["\u5B9E\u73B0\u9A8C\u6536\u548C\u8BC1\u636E\u5747\u5DF2\u901A\u8FC7\uFF1B\u5F53\u524D\u4EC5 Wiki closure \u5F85\u51B3\u3002\u8BF7\u51B3\u5B9A\u77E5\u8BC6\u662F\u5426\u5E94 captured \u6216 not_applicable\uFF0C\u8BB0\u5F55 closure \u540E\u6267\u884C /kata-verify\uFF0C\u4E0D\u8981\u56DE\u9000\u5230 /kata-build\u3002"];
  }
  if (suggestion.reason === "repair_blocking_review_findings") {
    return ["\u68C0\u6D4B\u5230 blocking review findings\uFF1B\u5EFA\u8BAE\u5148\u6267\u884C /kata-build \u4FEE\u590D\uFF0C\u800C\u4E0D\u662F\u7EE7\u7EED Judge PASS\u3002"];
  }
  if (suggestion.reason === "repair_strict_major_findings") {
    return ["\u68C0\u6D4B\u5230 strict \u6A21\u5F0F\u7684 major review finding\uFF1Bstrict \u4EFB\u52A1\u5FC5\u987B\u4FEE\u590D\u65B9\u53EF\u8FDB\u5165 Judge\uFF0C\u8BF7\u6267\u884C /kata-build\u3002"];
  }
  if (suggestion.reason === "complete_review_conclusion") {
    return ["Review \u5C1A\u672A\u5F62\u6210\u7ED1\u5B9A\u5F53\u524D revision \u7684\u663E\u5F0F\u7ED3\u8BBA\u548C\u5BA1\u67E5\u8BC1\u636E\uFF1B\u8BF7\u5B8C\u6210\u5B9E\u9645\u4EE3\u7801\u5BA1\u67E5\u540E\uFF0C\u4EE5 /kata-review --approve --review-evidence <summary> \u8BB0\u5F55\u7ED3\u8BBA\uFF0C\u6216\u5199\u5165 findings\u3002"];
  }
  if (suggestion.reason === "invalid_review_approval") {
    return ["\u68C0\u6D4B\u5230\u65E0\u6548 Review approval\uFF1A\u7F3A\u5C11\u7ED1\u5B9A\u5F53\u524D revision \u7684 reviewEvidence\u3002\u8BE5\u4EA7\u7269\u4E0D\u80FD\u8FDB\u5165 Judge\uFF1B\u8BF7\u91CD\u65B0\u6267\u884C /kata-review \u5E76\u8BB0\u5F55\u771F\u5B9E\u5BA1\u67E5\u7ED3\u8BBA\u3002"];
  }
  if (suggestion.reason === "repair_failed_judge") {
    return ["\u68C0\u6D4B\u5230 Judge FAIL\uFF1B\u5EFA\u8BAE\u5148\u6267\u884C /kata-build \u4FEE\u590D failed acceptance\u3002"];
  }
  if (suggestion.reason === "repair_failing_evidence") {
    return ["\u68C0\u6D4B\u5230\u5931\u8D25 evidence\uFF1B\u5EFA\u8BAE\u5148\u6267\u884C /kata-build \u4FEE\u590D\u5E76\u5237\u65B0\u8BC1\u636E\u3002"];
  }
  if (suggestion.reason === "repair_failed_verify") {
    return ["\u68C0\u6D4B\u5230 Verify FAIL\uFF1B\u5EFA\u8BAE\u5148\u6267\u884C /kata-build \u4FEE\u590D failed verification\u3002"];
  }
  if (suggestion.reason === "repair_unresolved_obligations") {
    return ["\u68C0\u6D4B\u5230\u672A\u89E3\u51B3\u7684\u4FEE\u590D\u4E49\u52A1\uFF08repair obligations\uFF09\uFF1B\u4EC5\u521B\u5EFA\u65B0 revision \u4E0D\u4F1A\u5173\u95ED\uFF0C\u5FC5\u987B\u7528\u77E9\u9635\u5173\u8054\u7684\u65B0\u9C9C\u901A\u8FC7\u8BC1\u636E\u89E3\u6790\u3002"];
  }
  if (suggestion.reason === "migrate_legacy_acceptance_matrix") {
    const acceptance = suggestion.acceptanceIds?.length ? `\uFF08${suggestion.acceptanceIds.join("\u3001")}\uFF09` : "";
    return [`\u68C0\u6D4B\u5230\u672A\u89E3\u51B3\u7684\u4FEE\u590D\u4E49\u52A1${acceptance}\uFF0C\u4F46\u4EFB\u52A1\u7F3A\u5C11 acceptanceMatrix\u30020 \u4E2A\u5F53\u524D findings \u4E0D\u662F\u5B8C\u6210\uFF1B\u8BF7\u5148\u901A\u8FC7 /kata-design \u8865\u9F50\u7A33\u5B9A AC\u3001\u5B9E\u73B0/\u6D4B\u8BD5\u8DEF\u5F84\u548C\u77E9\u9635\u8BC1\u636E\uFF0C\u518D\u4FEE\u590D\u4E49\u52A1\u5E76\u5C01\u5B58\u3002`];
  }
  if (suggestion.reason === "repair_mixed_revision_evidence") {
    return ["\u68C0\u6D4B\u5230\u6DF7\u5408 revision \u8BC1\u636E\uFF1B\u8BF7\u6267\u884C /kata-build <task> --seal \u91CD\u65B0\u5C01\u5B58\uFF0C\u6E05\u9664\u65E7 revision \u6B8B\u7559\u8BC1\u636E\u3002"];
  }
  if (suggestion.reason === "verify_fresh_implementation") {
    return ["\u5B9E\u73B0\u548C\u9879\u76EE\u8D28\u68C0\u5DF2\u5B8C\u6210\uFF1B\u4E0B\u4E00\u6B65\u6267\u884C /kata-verify \u6821\u9A8C\u8BC1\u636E\u65B0\u9C9C\u5EA6\u3001\u9A8C\u6536\u8986\u76D6\u548C blocking findings\u3002"];
  }
  if (suggestion.reason === "review_fresh_implementation") {
    return ["\u5B9E\u73B0\u4E0E\u786C\u9A8C\u8BC1\u5DF2\u5B8C\u6210\uFF1B\u8BF7\u6682\u505C\u5E76\u8BA9\u7528\u6237\u9009\u62E9 Reviewer \u4F7F\u7528\u5F53\u524D\u5E73\u53F0/\u6A21\u578B\u3001\u5207\u6362\u5E73\u53F0/\u6A21\u578B\uFF0C\u6216\u59D4\u6258\u7ED9\u5176\u4ED6 agent\u3002"];
  }
  if (suggestion.reason === "judge_reviewed_change") {
    return ["Review \u5DF2\u5B8C\u6210\uFF1B\u8BF7\u6682\u505C\u5E76\u8BA9\u7528\u6237\u9009\u62E9 Judge \u4F7F\u7528\u5F53\u524D\u5E73\u53F0/\u6A21\u578B\u3001\u5207\u6362\u5230\u9AD8\u9636\u6A21\u578B/\u5E73\u53F0\uFF0C\u6216\u59D4\u6258\u7ED9\u5176\u4ED6 agent\u3002"];
  }
  if (suggestion.reason === "archive_judged_change") {
    return ["Judge \u5DF2\u5B8C\u6210\uFF1B\u8BF7\u6682\u505C\u5E76\u8BA9\u7528\u6237\u786E\u8BA4\u662F\u5426\u5F52\u6863\uFF0C\u4EE5\u53CA\u662F\u5426\u5148\u8865\u5145 Wiki/\u53D1\u5E03\u8BC1\u636E\u3002"];
  }
  if (suggestion.reason === "archived_task") {
    return ["\u5F52\u6863\u5DF2\u5B8C\u6210\u3002\u5EFA\u8BAE\u4F7F\u7528 git \u63D0\u4EA4\u672C\u8F6E\u5DE5\u4F5C\u6D41\u6D89\u53CA\u7684\u6240\u6709\u66F4\u6539\uFF0C\u5E76\u63A8\u9001\u5230\u8FDC\u7AEF\u3002"];
  }
  return [`\u5EFA\u8BAE\u6267\u884C ${suggestion.nextSkill}\uFF0C\u89D2\u8272 ${suggestion.role}\u3002`];
}
function trustBoundaryForReason(reason) {
  if (reason === "choose_execution_mode") return "implementation_gate";
  if (reason === "review_fresh_implementation") return "review_gate";
  if (reason === "judge_reviewed_change") return "judge_gate";
  if (reason === "archive_judged_change") return "archive_gate";
  return null;
}
function pauseInstructionForBoundary(boundary) {
  if (boundary === "implementation_gate") {
    return "\u6682\u505C\uFF1A\u8BBE\u8BA1\u5DF2\u5B8C\u6210\u3002Kata \u5DF2\u751F\u6210\u5E73\u53F0\u65E0\u5173\u4EA4\u63A5\u5305\uFF1B\u53EF\u5728\u5F53\u524D\u6216\u4EFB\u610F\u5DF2\u8BC6\u522B\u5E73\u53F0\u63A5\u624B\u3002Kata \u4E0D\u4F1A\u81EA\u52A8\u5207\u6362\u6216\u8BB0\u5F55\u5BBF\u4E3B\u5E73\u53F0\u6A21\u578B\u3002";
  }
  if (boundary === "review_gate") {
    return "\u6682\u505C\uFF1AKata \u4E0D\u80FD\u5207\u6362\u5BBF\u4E3B\u5E73\u53F0\u6A21\u578B\uFF0C\u4E5F\u4E0D\u5F97\u5199\u5165\u5DF2\u5207\u6362\u7684\u8DEF\u7531\u8BB0\u5F55\u3002\u5C55\u793A\u63A8\u8350\u5E73\u53F0/\u6A21\u578B\uFF1B\u8BF7\u7528\u6237\u5148\u5728\u5BBF\u4E3B\u5E73\u53F0\u8BBE\u7F6E\u4E2D\u5B8C\u6210\u5207\u6362\uFF0C\u518D\u6062\u590D\u4F1A\u8BDD\u5E76\u786E\u8BA4\u5B9E\u9645\u5E73\u53F0/\u6A21\u578B\u3002\u4EC5\u6B64\u540E\u624D\u53EF\u7528 --confirm-host-model \u5199\u5165\u5BA1\u8BA1\u8BB0\u5F55\u5E76\u8FDB\u5165 Review\u3002";
  }
  if (boundary === "judge_gate") {
    return "\u6682\u505C\uFF1AKata \u4E0D\u80FD\u5207\u6362\u5BBF\u4E3B\u5E73\u53F0\u6A21\u578B\uFF0C\u4E5F\u4E0D\u5F97\u5199\u5165\u5DF2\u5207\u6362\u7684\u8DEF\u7531\u8BB0\u5F55\u3002\u5C55\u793A Judge \u63A8\u8350\u7684\u5E73\u53F0/\u6A21\u578B\uFF1B\u8BF7\u7528\u6237\u5148\u5728\u5BBF\u4E3B\u5E73\u53F0\u8BBE\u7F6E\u4E2D\u5B8C\u6210\u5207\u6362\uFF0C\u518D\u6062\u590D\u4F1A\u8BDD\u5E76\u786E\u8BA4\u5B9E\u9645\u5E73\u53F0/\u6A21\u578B\u3002\u4EC5\u6B64\u540E\u624D\u53EF\u7528 --confirm-host-model \u5199\u5165\u5BA1\u8BA1\u8BB0\u5F55\u5E76\u8FDB\u5165 Judge\u3002";
  }
  return "Stop after Judge. Ask the user whether to archive now, enrich Wiki first, or collect more release evidence.";
}
function skillToCliVerb(nextSkill) {
  const normalized = nextSkill.startsWith("/kata-") ? nextSkill.slice("/kata-".length) : nextSkill === "/kata" ? "status" : "";
  if (!normalized) return null;
  if (normalized === "status") return "status";
  return normalized;
}
async function readJsonFile(path) {
  try {
    return JSON.parse(await readFile16(path, "utf8"));
  } catch {
    return null;
  }
}
async function listEvidenceFiles(root, taskId) {
  try {
    const evidenceDir = join20(root, ".kata/evidence");
    const candidates = (await readdir8(evidenceDir)).filter((file) => file.startsWith(`${taskId}-`) && file.endsWith(".json"));
    const matches = await Promise.all(candidates.map(async (file) => ({
      file,
      evidence: await readJsonFile(join20(evidenceDir, file))
    })));
    return matches.filter(({ evidence }) => evidence?.taskId === taskId).map(({ file }) => file).sort();
  } catch {
    return [];
  }
}

// src/workflow/orchestrator.ts
var defaultActor = { id: "kata-agent", role: "implementer" };
var reviewerActor = { id: "kata-reviewer", role: "reviewer" };
var judgeActor = { id: "kata-judge", role: "judge" };
function actorFor(actor, platform) {
  return platform ? { ...actor, platform } : actor;
}
async function guardTransition(guard, action, taskId, phase) {
  if (!guard) return;
  const result = await guard[action](taskId, phase);
  if (action === "check" && !result.passed) {
    throw new Error(`Guard ${action} failed for ${phase}: ${result.reason ?? "guard rejected"}`);
  }
}
async function runCommand(command, taskId, root, options = {}) {
  assertValidTaskId(taskId);
  switch (command) {
    case "open":
      return cmdOpen(taskId, root, options);
    case "design":
      return cmdDesign(taskId, root, options);
    case "build":
      return cmdBuild(taskId, root, options);
    case "review":
      return cmdReview(taskId, root, options);
    case "judge":
      return cmdJudge(taskId, root, options);
    case "verify":
      return cmdVerify(taskId, root, options);
    case "archive":
      return cmdArchive(taskId, root, options);
    case "hotfix":
      return cmdHotfix(taskId, root, options);
    case "tweak":
      return cmdTweak(taskId, root, options);
    default:
      return { command, taskId, phase: "intake", success: false, error: `Unknown command: ${command}` };
  }
}
async function cmdOpen(taskId, root, options = {}) {
  const input = {
    root,
    id: taskId,
    title: options.title ?? `Change ${taskId}`,
    acceptance: options.acceptance ?? [{ statement: "Implement the change successfully." }],
    workflowProfile: options.workflowProfile ?? defaultWorkflowProfile(),
    ...options.ownedPaths?.length ? { ownedPaths: options.ownedPaths } : {}
  };
  const task = await createTask(input);
  let context;
  try {
    context = await buildContextManifest({ root, taskId, sourceRefs: [] });
  } catch {
    context = { taskId, sourceRefs: [], authoritativeWiki: [], excludedWiki: [], warnings: [] };
  }
  const ownershipConflicts = options.ownedPaths?.length ? await findOwnershipConflicts(root, taskId, options.ownedPaths) : [];
  const warnings = [
    ...context.warnings,
    ...ownershipConflicts.length > 0 ? [`Ownership conflicts detected: ${ownershipConflicts.map((c) => `${c.taskId}:${c.path}`).join(", ")}`] : []
  ];
  return {
    command: "open",
    taskId: task.id,
    phase: "intake",
    success: true,
    diagnostics: {
      acceptanceCount: task.acceptance.length,
      authoritativeWikiCount: context.authoritativeWiki.length,
      warnings,
      ...ownershipConflicts.length > 0 ? { ownershipConflicts } : {}
    }
  };
}
async function cmdDesign(taskId, root, options) {
  const actor = actorFor({ id: "kata-designer", role: "designer" }, options?.platform);
  const workflowProfile = await acknowledgeCometOpenIfRequired(root, taskId);
  const taskPath = join21(root, ".kata/tasks", taskId, "task.json");
  const task = JSON.parse(await readFile17(taskPath, "utf8"));
  const current = JSON.parse(await readFile17(join21(root, ".kata/tasks", taskId, "current-state.json"), "utf8"));
  if (!task.acceptanceMatrix && (current.phase === "implement" || current.phase === "hardVerify")) {
    const handoff2 = await createHandoff(root, taskId, "designer");
    return {
      command: "design",
      taskId,
      phase: current.phase,
      success: true,
      diagnostics: { migrationMode: "acceptance_matrix", nextRole: "designer", guardInstructions: handoff2.guardInstructions }
    };
  }
  if (requiresMatrix(task.workflowProfile) && !task.acceptanceMatrix) {
    return {
      command: "design",
      taskId,
      phase: "intake",
      success: false,
      error: "Strict closure requires an acceptanceMatrix; add it to task.json before designing.",
      diagnostics: { missingMatrix: true }
    };
  }
  const matrixErrors = validateMatrix(task.acceptance ?? [], task.acceptanceMatrix);
  if (requiresMatrix(task.workflowProfile) && matrixErrors.length > 0) {
    return {
      command: "design",
      taskId,
      phase: "intake",
      success: false,
      error: `Acceptance matrix validation failed during design: ${matrixErrors.length} error(s).`,
      diagnostics: { matrixErrors }
    };
  }
  await guardTransition(options?.guard, "check", taskId, "plan");
  const state = await transition(taskId, "plan", actor, { root });
  await guardTransition(options?.guard, "apply", taskId, "plan");
  const handoff = await createHandoff(root, taskId, "implementer");
  return {
    command: "design",
    taskId,
    phase: state.phase,
    success: true,
    diagnostics: {
      nextRole: "implementer",
      actor,
      guardInstructions: handoff.guardInstructions,
      ...workflowProfile ? { workflowProfile } : {}
    }
  };
}
async function acknowledgeCometOpenIfRequired(root, taskId) {
  const task = JSON.parse(await readFile17(join21(root, ".kata/tasks", taskId, "task.json"), "utf8"));
  if (!isWorkflowProfile(task.workflowProfile)) return void 0;
  if (task.workflowProfile.comet.openStatus !== "required") return task.workflowProfile;
  return acknowledgeCometOpen(root, taskId);
}
async function cmdBuild(taskId, root, options = {}) {
  const current = JSON.parse(
    await readFile17(join21(root, ".kata/tasks", taskId, "current-state.json"), "utf8")
  );
  let enteredReviewRepair = false;
  if (current.phase === "plan") {
    await guardTransition(options.guard, "check", taskId, "implement");
    await transition(taskId, "implement", actorFor(defaultActor, options.platform), { root });
    await guardTransition(options.guard, "apply", taskId, "implement");
  } else if (current.phase === "hardVerify") {
    await reenterImplementForVerifyRepair(taskId, root, actorFor(defaultActor, options.platform));
  } else if (current.phase === "review") {
    await reenterImplementForReviewRepair(taskId, root, actorFor(defaultActor, options.platform));
    enteredReviewRepair = true;
  } else if (current.phase === "judge") {
    await reenterImplementForRepair(taskId, root, actorFor(defaultActor, options.platform));
  } else if (current.phase !== "implement") {
    throw new Error(`Build cannot run from ${current.phase}`);
  }
  if (enteredReviewRepair) {
    return {
      command: "build",
      taskId,
      phase: "implement",
      success: true,
      diagnostics: {
        mode: "implement",
        implementationPrompt: "Review repair \u5DF2\u8FDB\u5165 implement\u3002\u5148\u4FEE\u590D repair.json \u4E2D\u7684 findings\u3001\u5199\u805A\u7126 RED/GREEN \u6D4B\u8BD5\uFF1B\u672C\u6B21\u4E0D\u4F1A seal \u6216\u521B\u5EFA revision\u3002",
        sealCommand: `kata build --change ${taskId} --seal`
      }
    };
  }
  if (!(options.seal ?? true)) {
    let buildOwnedPaths = [];
    try {
      const currentTask = JSON.parse(
        await readFile17(join21(root, ".kata/tasks", taskId, "task.json"), "utf8")
      );
      if (currentTask.ownedPaths?.length) {
        buildOwnedPaths = currentTask.ownedPaths;
      }
    } catch {
    }
    if (buildOwnedPaths.length === 0 && options.ownedPaths?.length) {
      buildOwnedPaths = options.ownedPaths;
    }
    const ownershipConflicts2 = buildOwnedPaths.length ? await findOwnershipConflicts(root, taskId, buildOwnedPaths) : [];
    return {
      command: "build",
      taskId,
      phase: "implement",
      success: true,
      diagnostics: {
        mode: "implement",
        implementationPrompt: "\u5148\u5199\u805A\u7126\u7684\u5931\u8D25\u6D4B\u8BD5\uFF08RED\uFF09\uFF0C\u518D\u6700\u5C0F\u5B9E\u73B0\u5E76\u8FD0\u884C\u805A\u7126 GREEN\uFF1B\u4E0D\u8981\u5728\u7F16\u7801\u524D\u5C01\u5B58 build \u8BC1\u636E\u3002",
        sealCommand: `kata build --change ${taskId} --seal`,
        ...ownershipConflicts2.length > 0 ? { ownershipConflicts: ownershipConflicts2 } : {}
      }
    };
  }
  const taskPath = join21(root, ".kata/tasks", taskId, "task.json");
  const task = JSON.parse(await readFile17(taskPath, "utf8"));
  const projectChecks = options.checks?.length ? options.checks : await resolveBuildChecks(root, await loadConfig(root), task.ownedPaths ?? []);
  let matrixDerivedChecks = [];
  if (!options.checks?.length && task.acceptanceMatrix) {
    try {
      matrixDerivedChecks = matrixChecks(root, task.acceptanceMatrix);
    } catch (error) {
      return {
        command: "build",
        taskId,
        phase: "implement",
        success: false,
        error: error instanceof Error ? error.message : String(error),
        diagnostics: { matrixError: true }
      };
    }
  }
  const checks = dedupeCheckCommands([
    ...projectChecks,
    ...matrixDerivedChecks
  ]);
  if (requiresMatrix(task.workflowProfile) && !task.acceptanceMatrix) {
    return {
      command: "build",
      taskId,
      phase: "implement",
      success: false,
      error: "Strict closure requires an acceptanceMatrix; add it to task.json before sealing.",
      diagnostics: { missingMatrix: true }
    };
  }
  const matrixErrors = validateMatrix(task.acceptance ?? [], task.acceptanceMatrix);
  if (requiresMatrix(task.workflowProfile) && matrixErrors.length > 0) {
    return {
      command: "build",
      taskId,
      phase: "implement",
      success: false,
      error: `Acceptance matrix validation failed: ${matrixErrors.length} error(s).`,
      diagnostics: { matrixErrors }
    };
  }
  if (!task.acceptanceMatrix) {
    const obligations = await readObligations(root, taskId);
    const unresolved = obligations.filter((o) => !o.resolvedAt);
    if (unresolved.length > 0) {
      return {
        command: "build",
        taskId,
        phase: "implement",
        success: false,
        error: "Legacy task has unresolved repair obligations; add an acceptanceMatrix to task.json so closure can record matrix-matched evidence for the affected AC(s).",
        diagnostics: {
          unresolvedObligations: unresolved.length,
          unresolvedAcceptanceIds: [...new Set(unresolved.map((o) => o.acceptanceId).filter((id) => Boolean(id)))]
        }
      };
    }
  }
  let ownedPaths2;
  try {
    ownedPaths2 = await resolveSealOwnedPaths(root, taskId, task, options);
  } catch (error) {
    return {
      command: "build",
      taskId,
      phase: "implement",
      success: false,
      error: error instanceof Error ? error.message : String(error),
      diagnostics: { missingOwnedPaths: true }
    };
  }
  const reviewRepairBaseline = await readActiveReviewRepairBaseline(root, taskId);
  if (reviewRepairBaseline) {
    const manifestHash = await computeManifestHash(root, ownedPaths2);
    if (manifestHash === reviewRepairBaseline) {
      return {
        command: "build",
        taskId,
        phase: "implement",
        success: false,
        error: "Cannot seal review repair without a changed task manifest; fix the recorded findings and tests before retrying --seal.",
        diagnostics: { mode: "implement", repairRequired: true }
      };
    }
  }
  let codeGraphCandidates = [];
  let codeGraphDisposition;
  const ownershipConflicts = ownedPaths2.length ? await findOwnershipConflicts(root, taskId, ownedPaths2) : [];
  if (ownershipConflicts.length > 0 && !options.allowOwnershipConflicts) {
    return {
      command: "build",
      taskId,
      phase: "implement",
      success: false,
      error: "Cannot seal while declared task ownership overlaps another task. Use --allow-ownership-conflicts to confirm and proceed.",
      diagnostics: { ownershipConflicts }
    };
  }
  if (requiresMatrix(task.workflowProfile)) {
    const coverage = validatePathCoverage(task.acceptanceMatrix, ownedPaths2);
    const persistedWaivers = await readWaivers(root, taskId);
    const waivers = [...new Map([...persistedWaivers, ...options.waivers ?? []].map((waiver) => [waiver.path, waiver])).values()];
    const waiverErrors = validateWaivers(waivers);
    if (waiverErrors.length > 0) {
      return { command: "build", taskId, phase: "implement", success: false, error: "Invalid recorded waiver.", diagnostics: { waiverErrors } };
    }
    if (task.workflowProfile?.strictClosure) {
      codeGraphCandidates = await discoverCodeGraphCandidates(root, task.acceptanceMatrix, ownedPaths2);
      codeGraphDisposition = classifyCodeGraphCandidates(task.acceptanceMatrix, ownedPaths2, waivers, codeGraphCandidates);
    }
    const waivedPaths = new Set(waivers.map((w) => w.path));
    const unwaivedMissingImpl = coverage.missingImplementationPaths.filter((p) => !waivedPaths.has(p));
    const unwaivedMissingTest = coverage.missingTestPaths.filter((p) => !waivedPaths.has(p));
    if (unwaivedMissingImpl.length > 0 || unwaivedMissingTest.length > 0 || (codeGraphDisposition?.unresolvedCandidates.length ?? 0) > 0) {
      return {
        command: "build",
        taskId,
        phase: "implement",
        success: false,
        error: "Owned path coverage incomplete: matrix implementation and test paths must be covered by owned paths or waived.",
        diagnostics: {
          missingImplementationPaths: unwaivedMissingImpl,
          missingTestPaths: unwaivedMissingTest,
          waivedImplementationPaths: coverage.missingImplementationPaths.filter((p) => waivedPaths.has(p)),
          waivedTestPaths: coverage.missingTestPaths.filter((p) => waivedPaths.has(p)),
          ...codeGraphCandidates.length > 0 ? { codeGraphCandidates, ...codeGraphDisposition ?? {} } : {},
          waivers
        }
      };
    }
    await writeWaivers(root, taskId, waivers);
  }
  const revision = ownedPaths2.length ? await createTaskRevision({
    root,
    taskId,
    ownedPaths: ownedPaths2,
    ...ownershipConflicts.length > 0 && options.allowOwnershipConflicts ? { ownershipConflicts, ownershipConflictsAcknowledged: true } : {}
  }) : void 0;
  const evidence = await collectEvidence(taskId, checks, {
    ...revision ? { revision } : {},
    ...options.signal ? { signal: options.signal } : {},
    ...options.onProgress ? { onProgress: options.onProgress } : {}
  });
  await writeEvidence(root, taskId, evidence);
  if (evidence.some((item) => item.exitCode !== 0)) {
    return {
      command: "build",
      taskId,
      phase: "implement",
      success: false,
      error: "Evidence sealing failed; fix the failing checks before retrying --seal.",
      diagnostics: {
        mode: "seal",
        evidenceCount: evidence.length,
        passing: evidence.filter((item) => item.exitCode === 0).length,
        failing: evidence.filter((item) => item.exitCode !== 0).length
      }
    };
  }
  if (revision && task.acceptanceMatrix) {
    const acIds = task.acceptanceMatrix.rows.map((r) => r.acceptanceId);
    await resolveObligationsForRevision(
      root,
      taskId,
      revision.id,
      acIds,
      evidence.filter((e) => e.exitCode === 0).map((e) => e.id),
      task.acceptanceMatrix,
      evidence
    );
  }
  if (revision && reviewRepairBaseline) {
    await resolveReviewRepair(root, taskId, revision.id);
  }
  const wikiClosure = await ensureWikiClosure(root, taskId);
  await guardTransition(options.guard, "check", taskId, "hardVerify");
  await transition(taskId, "hardVerify", actorFor(defaultActor, options.platform), { root });
  await guardTransition(options.guard, "apply", taskId, "hardVerify");
  return {
    command: "build",
    taskId,
    phase: "hardVerify",
    success: evidence.every((e) => e.exitCode === 0),
    diagnostics: {
      evidenceCount: evidence.length,
      passing: evidence.filter((e) => e.exitCode === 0).length,
      failing: evidence.filter((e) => e.exitCode !== 0).length,
      wikiClosure,
      ...ownedPaths2.length ? { ownedPaths: ownedPaths2, ownedPathsSource: task.ownedPaths?.length ? "task" : "build-option" } : {},
      ...codeGraphCandidates.length > 0 ? { codeGraphCandidates, ...codeGraphDisposition ?? {} } : {},
      ...revision ? { revisionId: revision.id } : {},
      ...ownershipConflicts.length > 0 ? { ownershipConflicts } : {}
    }
  };
}
function resolveCheckForRow(row, evidence, root) {
  const hasSelector = typeof evidence.testSelector === "string" && evidence.testSelector.length > 0;
  const template = evidence.command.trim();
  const hasPlaceholder = template.includes("{{selector}}");
  if (hasSelector && hasPlaceholder) {
    const runtimeProjectDir2 = row.testPaths.every((path) => path.startsWith("kata/")) ? join21(root, "kata") : root;
    const selector2 = testSelectorForRuntime(evidence.testSelector, runtimeProjectDir2, root);
    const filled = template.replace("{{selector}}", selector2);
    const [rawCommand2, ...args2] = filled.split(/\s+/);
    const runtimeEntry2 = rawCommand2 === "vitest" ? join21(runtimeProjectDir2, "node_modules", "vitest", "vitest.mjs") : rawCommand2 === "tsc" ? join21(runtimeProjectDir2, "node_modules", "typescript", "bin", "tsc") : void 0;
    const command2 = runtimeEntry2 ? process.execPath : rawCommand2;
    return {
      name: `${row.acceptanceId}-${evidence.kind}-${evidence.testSelector ?? evidence.command}`,
      kind: evidence.kind,
      command: command2,
      args: [...runtimeEntry2 ? [runtimeEntry2] : [], ...args2],
      cwd: runtimeProjectDir2,
      timeoutMs: evidence.kind === "test" || evidence.kind === "integration" || evidence.kind === "entrypoint" ? 12e4 : 6e4
    };
  }
  if (hasSelector) {
    const knownRunners = ["vitest", "pytest", "uv run pytest"];
    const isKnownRunner = knownRunners.some((runner) => template === runner || template.startsWith(runner + " "));
    if (isKnownRunner) {
      const [rawCommand2, ...args2] = template.split(/\s+/);
      const runtimeProjectDir2 = row.testPaths.every((path) => path.startsWith("kata/")) ? join21(root, "kata") : root;
      const selector2 = testSelectorForRuntime(evidence.testSelector, runtimeProjectDir2, root);
      const runtimeEntry2 = rawCommand2 === "vitest" ? join21(runtimeProjectDir2, "node_modules", "vitest", "vitest.mjs") : rawCommand2 === "pytest" ? rawCommand2 : void 0;
      const command2 = runtimeEntry2 === void 0 && rawCommand2 === "uv" ? template : runtimeEntry2 ? process.execPath : rawCommand2;
      return {
        name: `${row.acceptanceId}-${evidence.kind}-${evidence.testSelector ?? evidence.command}`,
        kind: evidence.kind,
        command: runtimeEntry2 ? process.execPath : rawCommand2,
        args: [...runtimeEntry2 ? [runtimeEntry2] : [], ...args2, ...selectorArgs(selector2)],
        cwd: runtimeProjectDir2,
        timeoutMs: evidence.kind === "test" || evidence.kind === "integration" || evidence.kind === "entrypoint" ? 12e4 : 6e4
      };
    }
    return new Error(`Matrix row ${row.acceptanceId} declares a testSelector but command "${template}" does not support selectors. Use vitest, pytest, uv run pytest, or a command template with {{selector}} placeholder.`);
  }
  const [rawCommand, ...args] = template.split(/\s+/);
  const runtimeProjectDir = row.testPaths.every((path) => path.startsWith("kata/")) ? join21(root, "kata") : root;
  const selector = evidence.testSelector ? testSelectorForRuntime(evidence.testSelector, runtimeProjectDir, root) : void 0;
  const runtimeEntry = rawCommand === "vitest" ? join21(runtimeProjectDir, "node_modules", "vitest", "vitest.mjs") : rawCommand === "tsc" ? join21(runtimeProjectDir, "node_modules", "typescript", "bin", "tsc") : void 0;
  const command = runtimeEntry ? process.execPath : rawCommand;
  return {
    name: `${row.acceptanceId}-${evidence.kind}-${evidence.testSelector ?? evidence.command}`,
    kind: evidence.kind,
    command,
    args: [...runtimeEntry ? [runtimeEntry] : [], ...args, ...selector ? selectorArgs(selector) : []],
    cwd: runtimeProjectDir,
    timeoutMs: evidence.kind === "test" || evidence.kind === "integration" || evidence.kind === "entrypoint" ? 12e4 : 6e4
  };
}
function testSelectorForRuntime(selector, runtimeProjectDir, root) {
  return runtimeProjectDir !== root && selector.startsWith("kata/") ? selector.slice("kata/".length) : selector;
}
function selectorArgs(selector) {
  return selector.split(/\s+/);
}
function matrixChecks(root, matrix) {
  const checks = [];
  for (const row of matrix.rows) {
    for (const evidence of row.evidence) {
      const result = resolveCheckForRow(row, evidence, root);
      if (result instanceof Error) {
        throw result;
      }
      checks.push(result);
    }
  }
  return checks.filter((check, index) => checks.findIndex(
    (candidate) => candidate.kind === check.kind && candidate.command === check.command && (candidate.args ?? []).join("\0") === (check.args ?? []).join("\0") && candidate.cwd === check.cwd
  ) === index);
}
function dedupeCheckCommands(checks) {
  return checks.filter((check, index) => checks.findIndex(
    (candidate) => candidate.kind === check.kind && candidate.command === check.command && (candidate.args ?? []).join("\0") === (check.args ?? []).join("\0") && candidate.cwd === check.cwd
  ) === index);
}
async function resolveSealOwnedPaths(root, taskId, task, options) {
  if (task.ownedPaths?.length) {
    const cliPaths = options.ownedPaths?.length ? options.ownedPaths : [];
    const merged = cliPaths.length ? [.../* @__PURE__ */ new Set([...task.ownedPaths, ...cliPaths])].sort() : task.ownedPaths;
    if (merged.length > task.ownedPaths.length) {
      await persistTaskOwnedPaths(root, taskId, task, merged);
    }
    return merged;
  }
  if (!options.ownedPaths?.length) {
    throw new Error("seal requires at least one --owned-path when the task has no ownedPaths");
  }
  const ownedPaths2 = [...new Set(options.ownedPaths)].sort();
  await persistTaskOwnedPaths(root, taskId, task, ownedPaths2);
  return ownedPaths2;
}
async function persistTaskOwnedPaths(root, taskId, task, ownedPaths2) {
  await writeFile13(
    join21(root, ".kata/tasks", taskId, "task.json"),
    `${JSON.stringify({ ...task, ownedPaths: ownedPaths2 }, null, 2)}
`,
    "utf8"
  );
}
async function writeEvidence(root, taskId, evidence) {
  const evidenceDir = join21(root, ".kata/evidence");
  await mkdir13(evidenceDir, { recursive: true });
  const { readdir: readdir11, unlink } = await import("node:fs/promises");
  try {
    const files = await readdir11(evidenceDir);
    for (const file of files) {
      if (file.startsWith(`${taskId}-`) && file.endsWith(".json")) {
        await unlink(join21(evidenceDir, file)).catch(() => {
        });
      }
    }
  } catch {
  }
  for (const envelope of evidence) {
    await writeFile13(
      join21(evidenceDir, `${taskId}-${evidenceFileSuffix(envelope)}.json`),
      `${JSON.stringify(envelope, null, 2)}
`,
      "utf8"
    );
  }
  const testEvidence = evidence.find((item) => item.kind === "test");
  if (testEvidence) {
    await writeFile13(
      join21(evidenceDir, `${taskId}-hard.json`),
      `${JSON.stringify(testEvidence, null, 2)}
`,
      "utf8"
    );
  }
}
function evidenceFileSuffix(envelope) {
  return (envelope.name ?? envelope.kind).replace(/[^A-Za-z0-9_.-]+/g, "-").replace(/^-|-$/g, "") || envelope.kind;
}
async function reenterImplementForReviewRepair(taskId, root, actor) {
  const reviewRaw = await readFile17(join21(root, ".kata/tasks", taskId, "review.json"), "utf8");
  const review = JSON.parse(reviewRaw);
  const taskRaw = await readFile17(join21(root, ".kata/tasks", taskId, "task.json"), "utf8");
  const task = JSON.parse(taskRaw);
  const isStrict = task.workflowProfile?.reviewMode === "strict";
  const revision = await readCurrentTaskRevision(root, taskId);
  if (review.revisionId !== revision?.id) {
    throw new Error("Build cannot run from review because its findings are not bound to the current sealed revision. Re-run /kata-review.");
  }
  const blockingFindings = (review.findings ?? []).filter((finding) => finding.severity === "blocking");
  const majorFindings = isStrict ? (review.findings ?? []).filter((finding) => finding.severity === "major") : [];
  if (blockingFindings.length === 0 && majorFindings.length === 0) {
    throw new Error("Build cannot run from review without blocking (or strict-mode major) review findings. Re-running /kata-review first ensures a fresh evaluation against the current sealed revision.");
  }
  const now = (/* @__PURE__ */ new Date()).toISOString();
  await withTaskLock(root, taskId, async () => {
    await appendStateEvent(root, {
      taskId,
      from: "review",
      to: "implement",
      actor,
      at: now
    });
    await writeCurrentState(root, {
      taskId,
      phase: "implement",
      actor,
      updatedAt: now
    });
  });
  await writeFile13(
    join21(root, ".kata/tasks", taskId, "repair.json"),
    `${JSON.stringify({
      taskId,
      fromPhase: "review",
      toPhase: "implement",
      actor,
      reason: "review_findings",
      ...revision ? { baselineRevisionId: revision.id, baselineManifestHash: revision.manifestHash } : {},
      findings: [...blockingFindings, ...majorFindings].map((finding) => ({
        title: finding.title,
        message: finding.message,
        fix: finding.fix
      })),
      createdAt: now
    }, null, 2)}
`,
    "utf8"
  );
}
async function readActiveReviewRepairBaseline(root, taskId) {
  try {
    const repair = JSON.parse(await readFile17(join21(root, ".kata/tasks", taskId, "repair.json"), "utf8"));
    if (repair.reason !== "review_findings" || repair.resolvedAt || !repair.baselineManifestHash) return void 0;
    return repair.baselineManifestHash;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return void 0;
    throw error;
  }
}
async function resolveReviewRepair(root, taskId, revisionId) {
  const repairPath = join21(root, ".kata/tasks", taskId, "repair.json");
  const repair = JSON.parse(await readFile17(repairPath, "utf8"));
  await writeFile13(repairPath, `${JSON.stringify({
    ...repair,
    resolvedAt: (/* @__PURE__ */ new Date()).toISOString(),
    resolvedRevisionId: revisionId
  }, null, 2)}
`, "utf8");
}
async function reenterImplementForVerifyRepair(taskId, root, actor) {
  let verifyRaw;
  try {
    verifyRaw = await readFile17(join21(root, ".kata/tasks", taskId, "verify.json"), "utf8");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  if (!verifyRaw) {
    const now2 = (/* @__PURE__ */ new Date()).toISOString();
    await appendStateEvent(root, { taskId, from: "hardVerify", to: "implement", actor, at: now2 });
    await writeCurrentState(root, { taskId, phase: "implement", actor, updatedAt: now2 });
    return;
  }
  const verify = JSON.parse(verifyRaw);
  const repairableScopes = /* @__PURE__ */ new Set([
    "missing_test_evidence",
    "stale_evidence",
    "failing_evidence",
    "blocking_review_finding",
    "revision_superseded",
    "insufficient_evidence_level",
    "unresolved_repair_obligation"
  ]);
  const failedAcceptance = verify.acceptance?.filter((criterion) => criterion.result === "FAIL") ?? [];
  const isRepairable = verify.result === "FAIL" && (failedAcceptance.length === 0 || failedAcceptance.every((criterion) => criterion.repairScope && repairableScopes.has(criterion.repairScope)));
  if (!isRepairable) {
    throw new Error("Build cannot run from hardVerify without a repairable verify FAIL result");
  }
  const now = (/* @__PURE__ */ new Date()).toISOString();
  await appendStateEvent(root, {
    taskId,
    from: "hardVerify",
    to: "implement",
    actor,
    at: now
  });
  await writeCurrentState(root, {
    taskId,
    phase: "implement",
    actor,
    updatedAt: now
  });
  await writeFile13(
    join21(root, ".kata/tasks", taskId, "repair.json"),
    `${JSON.stringify({
      taskId,
      fromPhase: "hardVerify",
      toPhase: "implement",
      actor,
      reason: failedAcceptance.length === 0 ? "verify_reseal" : "verify_fail",
      scopes: failedAcceptance.map((criterion) => ({
        id: criterion.id,
        repairScope: criterion.repairScope
      })),
      createdAt: now
    }, null, 2)}
`,
    "utf8"
  );
}
async function reenterImplementForRepair(taskId, root, actor) {
  const judgeRaw = await readFile17(join21(root, ".kata/tasks", taskId, "judge.json"), "utf8");
  const judgeResult = JSON.parse(judgeRaw);
  const repairableScopes = /* @__PURE__ */ new Set([
    "missing_test_evidence",
    "stale_evidence",
    "failing_evidence",
    "blocking_review_finding",
    "insufficient_evidence_level",
    "unresolved_repair_obligation"
  ]);
  const failedAcceptance = judgeResult.acceptance?.filter((criterion) => criterion.result === "FAIL") ?? [];
  const isRepairable = judgeResult.result === "FAIL" && failedAcceptance.length > 0 && failedAcceptance.every((criterion) => criterion.repairScope && repairableScopes.has(criterion.repairScope));
  if (!isRepairable) {
    throw new Error("Build cannot run from judge without a repairable judge FAIL result");
  }
  const now = (/* @__PURE__ */ new Date()).toISOString();
  await appendStateEvent(root, {
    taskId,
    from: "judge",
    to: "implement",
    actor,
    at: now
  });
  await writeCurrentState(root, {
    taskId,
    phase: "implement",
    actor,
    updatedAt: now
  });
  await writeFile13(
    join21(root, ".kata/tasks", taskId, "repair.json"),
    `${JSON.stringify({
      taskId,
      fromPhase: "judge",
      toPhase: "implement",
      actor,
      reason: "judge_fail",
      scopes: failedAcceptance.map((criterion) => ({
        id: criterion.id,
        repairScope: criterion.repairScope
      })),
      createdAt: now
    }, null, 2)}
`,
    "utf8"
  );
}
async function cmdVerify(taskId, root, options = {}) {
  const taskRaw = await readFile17(join21(root, ".kata/tasks", taskId, "task.json"), "utf8");
  const task = JSON.parse(taskRaw);
  const current = JSON.parse(await readFile17(join21(root, ".kata/tasks", taskId, "current-state.json"), "utf8"));
  const currentDiffHash = await computeDiffHash(root);
  const evidence = await readTaskEvidence(root, taskId, options);
  const scopeHashes = await currentScopeHashes(root, evidence);
  const revisionId = revisionIdForEvidence(evidence);
  const review = await readReview(root, taskId);
  const ignoredReviewFindings = revisionId && review.revisionId !== revisionId ? review.findings.length : 0;
  const findings = ignoredReviewFindings > 0 ? [] : review.findings;
  const revision = revisionId ? await readTaskRevision(root, taskId, revisionId) : void 0;
  const status = revision ? await revisionStatus(root, revision) : void 0;
  const drift = revision ? await workspaceDrift(root, revision.ownedPaths) : [];
  const obligations = await readObligations(root, taskId);
  const unresolvedObligations = obligations.filter((o) => !o.resolvedAt);
  const matrix = task.acceptanceMatrix;
  const verifyResult = status?.status === "superseded" ? supersededReadiness(taskId, task.acceptance, currentDiffHash, revision.id) : evaluateReadiness(taskId, task.acceptance, evidence, findings, currentDiffHash, scopeHashes, matrix, unresolvedObligations, task.workflowProfile?.reviewMode);
  if (revisionId) verifyResult.revisionId = revisionId;
  const implementationReady = verifyResult.result === "PASS";
  const wikiClosure = await evaluateWikiClosure(root, taskId);
  if (!wikiClosure.valid) verifyResult.result = "FAIL";
  await writeFile13(join21(root, ".kata/tasks", taskId, "verify.json"), `${JSON.stringify(verifyResult, null, 2)}
`, "utf8");
  const failedScopes = verifyResult.acceptance.filter((acceptance) => acceptance.result === "FAIL").map((acceptance) => acceptance.repairScope).filter((scope) => scope !== void 0);
  const repairReason = failedScopes.length > 0 && failedScopes.every((scope) => scope === "revision_superseded") ? "rebuild_superseded_revision" : failedScopes.length > 0 && failedScopes.every((scope) => scope === "stale_evidence") ? "rebuild_stale_evidence" : failedScopes.length > 0 && failedScopes.every((scope) => scope === "insufficient_evidence_level") ? "add_entrypoint_evidence" : failedScopes.length > 0 && failedScopes.every((scope) => scope === "unresolved_repair_obligation") ? "resolve_repair_obligations" : "repair_failed_verify";
  const repairAction = nextActionForTask(taskId, "/kata-build", "implementer", repairReason);
  const wikiClosureAction = nextActionForTask(taskId, "/kata-wiki-enrich", "implementer", "resolve_wiki_closure");
  const nextAction = implementationReady && !wikiClosure.valid ? wikiClosureAction : verifyResult.result === "PASS" ? {
    nextSkill: current.phase === "review" ? "/kata-judge" : "/kata-review",
    requiresUserConfirmation: true,
    modelOrPlatformSwitchAllowed: true,
    trustBoundary: current.phase === "review" ? "judge_gate" : "review_gate"
  } : repairAction;
  return {
    command: "verify",
    taskId,
    phase: current.phase,
    success: verifyResult.result === "PASS",
    ...verifyResult.result === "FAIL" ? { error: implementationReady && !wikiClosure.valid ? `Implementation verification passed; complete Wiki closure (${wikiClosure.reason}) before review/judge.` : wikiClosure.valid ? repairReason === "rebuild_stale_evidence" ? "Verify found stale evidence; reseal checks against the current implementation before review/judge." : repairReason === "add_entrypoint_evidence" ? "Verify requires integration/entrypoint evidence for at least one AC; unit evidence alone is insufficient." : repairReason === "resolve_repair_obligations" ? "Verify blocked by unresolved repair obligations; supply matrix-linked evidence and mark obligations resolved." : "Verify failed; repair evidence or blocking findings before review/judge." : `Verify failed; complete Wiki closure (${wikiClosure.reason}) before review/judge.` } : {},
    diagnostics: {
      verifyResult: verifyResult.result,
      acceptanceResults: verifyResult.acceptance.map((a) => ({
        id: a.id,
        result: a.result,
        repairScope: a.repairScope
      })),
      evidenceCount: evidence.length,
      findingCount: findings.length,
      blockingFindings: findings.filter((f) => f.severity === "blocking").length,
      implementationReady,
      governanceReady: wikiClosure.valid,
      wikiClosure,
      ...unresolvedObligations.length > 0 ? { unresolvedObligations: unresolvedObligations.length } : {},
      ...revisionId ? { revisionId } : {},
      ...status ? { revisionStatus: status.status } : {},
      ...revision ? { workspaceDrift: drift } : {},
      ...ignoredReviewFindings > 0 ? {
        ignoredReviewFindings,
        ignoredReviewRevisionId: review.revisionId ?? null
      } : {},
      nextAction
    }
  };
}
async function cmdReview(taskId, root, options = {}) {
  try {
    const isApprove = options.approve === true;
    if (isApprove) {
      const current = JSON.parse(await readFile17(join21(root, ".kata/tasks", taskId, "current-state.json"), "utf8"));
      if (current.phase !== "review") {
        return {
          command: "review",
          taskId,
          phase: current.phase,
          success: false,
          error: `Review approval requires review phase; current phase is ${current.phase}.`
        };
      }
      const reviewEvidence = options.reviewEvidence?.trim();
      if (!reviewEvidence) {
        return {
          command: "review",
          taskId,
          phase: "review",
          success: false,
          error: "Review approval requires non-empty review evidence."
        };
      }
      const reviewPath2 = join21(root, ".kata/tasks", taskId, "review.json");
      const revisionId2 = revisionIdForEvidence(await readTaskEvidence(root, taskId, options));
      const existing = await readReview(root, taskId);
      if (revisionId2 && existing.revisionId !== revisionId2) {
        return {
          command: "review",
          taskId,
          phase: "review",
          success: false,
          error: "Review approval requires findings recorded for the same sealed revision as current evidence. Re-run /kata-review before approving."
        };
      }
      if (existing.findings.some((f) => f.severity === "blocking" || f.severity === "major")) {
        return {
          command: "review",
          taskId,
          phase: "review",
          success: false,
          error: "Cannot approve review with blocking or major findings; resolve findings first."
        };
      }
      await writeFile13(reviewPath2, `${JSON.stringify({ ...revisionId2 ? { revisionId: revisionId2 } : {}, findings: existing.findings, status: "approved", reviewEvidence, approvedAt: (/* @__PURE__ */ new Date()).toISOString() }, null, 2)}
`, "utf8");
      return { command: "review", taskId, phase: "review", success: true, diagnostics: { role: "reviewer", approval: true, reviewEvidence, ...revisionId2 ? { revisionId: revisionId2 } : {} } };
    }
    if (!options.confirmHostModel) {
      return {
        command: "review",
        taskId,
        phase: "hardVerify",
        success: false,
        error: "Review requires explicit user confirmation at the review trust boundary.",
        diagnostics: { requiresUserConfirmation: true, trustBoundary: "review_gate" }
      };
    }
    await guardTransition(options.guard, "check", taskId, "review");
    const state = await transition(taskId, "review", actorFor(reviewerActor, options.platform), { root });
    await guardTransition(options.guard, "apply", taskId, "review");
    const reviewPath = join21(root, ".kata/tasks", taskId, "review.json");
    const revisionId = revisionIdForEvidence(await readTaskEvidence(root, taskId, options));
    try {
      const previous = JSON.parse(await readFile17(reviewPath, "utf8"));
      if (revisionId && previous.revisionId !== revisionId) {
        if (previous.findings?.length) {
          const historyPath = join21(root, ".kata/tasks", taskId, "review-history.jsonl");
          const historyEntry = JSON.stringify({
            revisionId: previous.revisionId,
            findings: previous.findings,
            status: previous.status ?? "pending",
            archivedAt: (/* @__PURE__ */ new Date()).toISOString()
          }) + "\n";
          await appendFile2(historyPath, historyEntry, "utf8");
        }
        await writeFile13(reviewPath, `${JSON.stringify({ revisionId, findings: [], status: "pending" }, null, 2)}
`, "utf8");
      }
    } catch {
      await writeFile13(reviewPath, `${JSON.stringify({ ...revisionId ? { revisionId } : {}, findings: [], status: "pending" }, null, 2)}
`, "utf8");
    }
    return { command: "review", taskId, phase: state.phase, success: true, diagnostics: { role: "reviewer", ...revisionId ? { revisionId } : {} } };
  } catch (error) {
    return { command: "review", taskId, phase: "hardVerify", success: false, error: `Review transition failed: ${error.message}` };
  }
}
async function cmdJudge(taskId, root, options = {}) {
  const current = JSON.parse(await readFile17(join21(root, ".kata/tasks", taskId, "current-state.json"), "utf8"));
  if (current.phase !== "review") {
    return {
      command: "judge",
      taskId,
      phase: current.phase,
      success: false,
      error: `Judge requires review phase; current phase is ${current.phase}. Run /kata-review first, then ask the user whether to keep this platform/model or switch before /kata-judge.`,
      diagnostics: {
        requiresUserConfirmation: true,
        trustBoundary: "judge_gate",
        nextSkill: current.phase === "hardVerify" ? "/kata-review" : "/kata",
        modelOrPlatformSwitchAllowed: true
      }
    };
  }
  if (!options.confirmHostModel) {
    return {
      command: "judge",
      taskId,
      phase: "review",
      success: false,
      error: "Judge requires explicit user confirmation at the judge trust boundary.",
      diagnostics: { requiresUserConfirmation: true, trustBoundary: "judge_gate" }
    };
  }
  const taskRaw = await readFile17(join21(root, ".kata/tasks", taskId, "task.json"), "utf8");
  const task = JSON.parse(taskRaw);
  const review = await readReview(root, taskId);
  if (review.status !== "approved" || !review.reviewEvidence?.trim()) {
    return {
      command: "judge",
      taskId,
      phase: "review",
      success: false,
      error: review.status === "pending" ? "Review has no explicit evidence-backed conclusion. Approve review with /kata-review --approve --review-evidence <summary> or record findings before judge." : "Review has no explicit conclusion. Run /kata-review first."
    };
  }
  const currentDiffHash = await computeDiffHash(root);
  const evidence = await readTaskEvidence(root, taskId, options);
  const findings = review.findings;
  const evidenceRevisionId = revisionIdForEvidence(evidence);
  const reviewRevisionId = await readReviewRevisionId(root, taskId);
  if (evidenceRevisionId && reviewRevisionId !== evidenceRevisionId) {
    return {
      command: "judge",
      taskId,
      phase: "review",
      success: false,
      error: "Judge requires review findings bound to the same sealed revision as evidence. Re-run /kata-review for the current revision.",
      diagnostics: { revisionId: evidenceRevisionId, reviewRevisionId: reviewRevisionId ?? null, repairScope: "cross_revision_review" }
    };
  }
  const scopeHashes = await currentScopeHashes(root, evidence);
  const obligations = await readObligations(root, taskId);
  const judgeResult = await judge({
    root,
    taskId,
    acceptance: task.acceptance,
    evidence,
    findings,
    currentDiffHash,
    currentScopeHashes: scopeHashes,
    matrix: task.acceptanceMatrix,
    reviewMode: task.workflowProfile?.reviewMode
  });
  if (judgeResult.result === "FAIL") {
    await persistBlockingJudgeResult(
      root,
      taskId,
      judgeResult.acceptance.filter((a) => a.result === "FAIL").map((a) => ({ id: a.id, result: a.result }))
    );
  }
  let judgePhase = "judge";
  let judgeTransitionError = null;
  try {
    await guardTransition(options.guard, "check", taskId, "judge");
    await transition(taskId, "judge", actorFor(judgeActor, options.platform), { root });
    await guardTransition(options.guard, "apply", taskId, "judge");
  } catch (error) {
    judgePhase = "review";
    judgeTransitionError = error instanceof Error ? error.message : String(error);
  }
  return {
    command: "judge",
    taskId,
    phase: judgeResult.result === "PASS" && judgeTransitionError === null ? "judge" : judgePhase,
    success: judgeResult.result === "PASS" && judgeTransitionError === null,
    ...judgeTransitionError ? { error: `Judge transition failed: ${judgeTransitionError}` } : {},
    diagnostics: {
      judgeResult: judgeResult.result,
      acceptanceResults: judgeResult.acceptance.map((a) => ({
        id: a.id,
        result: a.result,
        repairScope: a.repairScope
      })),
      evidenceCount: evidence.length,
      findingCount: findings.length,
      blockingFindings: findings.filter((f) => f.severity === "blocking").length
    }
  };
}
async function readTaskEvidence(root, taskId, options = {}) {
  const evidenceDir = join21(root, ".kata/evidence");
  let evidence = [];
  try {
    const { readdir: readdir11 } = await import("node:fs/promises");
    const files = await readdir11(evidenceDir);
    const candidateFiles = files.filter((f) => f.startsWith(`${taskId}-`));
    for (const file of candidateFiles) {
      const raw = await readFile17(join21(evidenceDir, file), "utf8");
      const parsed = JSON.parse(raw);
      if (parsed.taskId === taskId) evidence.push(parsed);
    }
  } catch {
    evidence = options.checks ? await collectEvidence(taskId, options.checks) : [];
  }
  return evidence;
}
async function readReview(root, taskId) {
  try {
    const reviewRaw = await readFile17(join21(root, ".kata/tasks", taskId, "review.json"), "utf8");
    const reviewParsed = JSON.parse(reviewRaw);
    return { revisionId: reviewParsed.revisionId, status: reviewParsed.status, reviewEvidence: reviewParsed.reviewEvidence, findings: reviewParsed.findings ?? [] };
  } catch {
    return { findings: [] };
  }
}
async function readReviewRevisionId(root, taskId) {
  try {
    const raw = await readFile17(join21(root, ".kata/tasks", taskId, "review.json"), "utf8");
    return JSON.parse(raw).revisionId;
  } catch {
    return void 0;
  }
}
function evaluateReadiness(taskId, acceptance, evidence, findings, currentDiffHash, scopeHashes, matrix, unresolvedObligations = [], reviewMode) {
  const freshEvidence = evidence.filter((item) => checkFreshness(item, currentDiffHash, scopeHashes.get(item.id)).fresh);
  const freshPassingTestEvidence = freshEvidence.filter((item) => item.kind === "test" && item.exitCode === 0);
  const failingTestEvidence = freshEvidence.find((item) => item.kind === "test" && item.exitCode !== 0);
  const blockingFindings = findings.filter((finding) => finding.severity === "blocking" || reviewMode === "strict" && finding.severity === "major");
  const acceptanceResults = acceptance.map((criterion) => {
    const acceptanceId = criterion.id ?? "";
    const blockingFinding = blockingFindings.find((finding) => !finding.acceptanceId || finding.acceptanceId === acceptanceId);
    const obligation = unresolvedObligations.find((o) => o.acceptanceId === acceptanceId || !o.acceptanceId);
    if (failingTestEvidence) return { id: acceptanceId, result: "FAIL", repairScope: "failing_evidence" };
    if (obligation) return { id: acceptanceId, result: "FAIL", repairScope: "unresolved_repair_obligation" };
    if (freshPassingTestEvidence.length === 0 && evidence.some((item) => item.kind === "test")) {
      return { id: acceptanceId, result: "FAIL", repairScope: "stale_evidence" };
    }
    if (freshPassingTestEvidence.length === 0) return { id: acceptanceId, result: "FAIL", repairScope: "missing_test_evidence" };
    if (matrix) {
      const row = getMatrixRowForAc(matrix, acceptanceId);
      if (row && (row.verificationLevel === "integration" || row.verificationLevel === "entrypoint")) {
        const hasRowSpecificEvidence = freshEvidence.some((item) => evidenceMatchesRow(row, item.command, item.kind));
        if (!hasRowSpecificEvidence) return { id: acceptanceId, result: "FAIL", repairScope: "insufficient_evidence_level" };
      }
    }
    if (blockingFinding) return { id: acceptanceId, result: "FAIL", repairScope: "blocking_review_finding" };
    return { id: acceptanceId, result: "PASS", evidenceIds: freshPassingTestEvidence.map((item) => item.id) };
  });
  return {
    taskId,
    result: acceptanceResults.every((item) => item.result === "PASS") ? "PASS" : "FAIL",
    diffHash: currentDiffHash,
    acceptance: acceptanceResults,
    evidenceIds: freshPassingTestEvidence.map((item) => item.id)
  };
}
function supersededReadiness(taskId, acceptance, currentDiffHash, revisionId) {
  return {
    taskId,
    result: "FAIL",
    diffHash: currentDiffHash,
    revisionId,
    acceptance: acceptance.map((criterion) => ({
      id: criterion.id ?? "",
      result: "FAIL",
      repairScope: "revision_superseded"
    }))
  };
}
function revisionIdForEvidence(evidence) {
  const revisionIds = [...new Set(evidence.map((item) => item.revisionId).filter((id) => Boolean(id)))];
  if (revisionIds.length > 1) throw new Error("Evidence from multiple task revisions cannot be verified together");
  return revisionIds[0];
}
async function currentScopeHashes(root, evidence) {
  const { computeScopeHash: computeScopeHash2 } = await Promise.resolve().then(() => (init_evidence(), evidence_exports));
  return new Map(await Promise.all(evidence.filter((item) => item.scope).map(async (item) => [item.id, await computeScopeHash2(root, item.scope?.paths ?? [])])));
}
async function cmdArchive(taskId, root, options = {}) {
  let archivePhase = "distill";
  const current = JSON.parse(await readFile17(join21(root, ".kata/tasks", taskId, "current-state.json"), "utf8"));
  if (!options.confirmHostModel) {
    return {
      command: "archive",
      taskId,
      phase: current.phase,
      success: false,
      error: "Archive requires explicit user confirmation at the archive trust boundary.",
      diagnostics: { requiresUserConfirmation: true, trustBoundary: "archive_gate" }
    };
  }
  const review = await readReview(root, taskId);
  if (review.status !== "approved" || !review.reviewEvidence?.trim()) {
    return {
      command: "archive",
      taskId,
      phase: current.phase,
      success: false,
      error: "Archive requires an evidence-backed Review approval before a Judge result can be archived."
    };
  }
  if (current.phase === "judge") {
    try {
      await guardTransition(options.guard, "check", taskId, "distill");
      await transition(taskId, "distill", actorFor(defaultActor, options.platform), { root });
      await guardTransition(options.guard, "apply", taskId, "distill");
    } catch (error) {
      return {
        command: "archive",
        taskId,
        phase: current.phase,
        success: false,
        error: `Archive requires a current-revision Judge PASS before transition: ${error.message}`
      };
    }
  } else if (current.phase !== "distill" && current.phase !== "archive") {
    return { command: "archive", taskId, phase: current.phase, success: false, error: `Archive cannot run from ${current.phase}` };
  }
  const distillation = await distillPassedTaskKnowledge(root, taskId);
  const wikiClosure = await evaluateWikiClosure(root, taskId);
  if (!wikiClosure.valid) {
    const latest = JSON.parse(await readFile17(join21(root, ".kata/tasks", taskId, "current-state.json"), "utf8"));
    return {
      command: "archive",
      taskId,
      phase: latest.phase,
      success: false,
      error: `Archive blocked; complete Wiki closure (${wikiClosure.reason}).`,
      diagnostics: { wikiClosure, distillation }
    };
  }
  const taskRaw = await readFile17(join21(root, ".kata/tasks", taskId, "task.json"), "utf8");
  const task = JSON.parse(taskRaw);
  let judgeRaw = null;
  try {
    judgeRaw = await readFile17(join21(root, ".kata/tasks", taskId, "judge.json"), "utf8");
  } catch {
  }
  let reviewRaw = null;
  try {
    reviewRaw = await readFile17(join21(root, ".kata/tasks", taskId, "review.json"), "utf8");
  } catch {
  }
  let evidenceIds = [];
  try {
    const { readdir: readdir11 } = await import("node:fs/promises");
    const files = await readdir11(join21(root, ".kata/evidence"));
    evidenceIds = files.filter((f) => f.startsWith(`${taskId}-`));
  } catch {
  }
  try {
    await guardTransition(options.guard, "check", taskId, "archive");
    await transition(taskId, "archive", actorFor(defaultActor, options.platform), { root });
    await guardTransition(options.guard, "apply", taskId, "archive");
    archivePhase = "archive";
  } catch {
    archivePhase = "distill";
  }
  let codegraphRefresh;
  if (archivePhase === "archive") {
    try {
      const { stat: stat6 } = await import("node:fs/promises");
      await stat6(join21(root, ".codegraph/index.db"));
      const { execFileSync: execFileSync6 } = await import("node:child_process");
      const output = execFileSync6("codegraph", ["index"], {
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 3e4
      });
      codegraphRefresh = { ok: true, output: output.trim() };
    } catch (error) {
      const nodeError = error;
      if (nodeError?.code === "ENOENT") {
        codegraphRefresh = { ok: false, output: "CodeGraph not initialized; skip index refresh." };
      } else {
        const detail = error instanceof Error ? error.message : String(error);
        codegraphRefresh = { ok: false, output: detail };
      }
    }
  }
  return {
    command: "archive",
    taskId,
    phase: archivePhase,
    success: archivePhase === "archive",
    diagnostics: {
      taskTitle: task.title,
      acceptanceCount: task.acceptance.length,
      acceptance: task.acceptance.map((a) => ({ id: a.id, statement: a.statement })),
      evidenceFiles: evidenceIds,
      hasJudgeResult: judgeRaw !== null,
      hasReviewResult: reviewRaw !== null,
      distillation,
      distillationHint: "Read task artifacts, acceptance criteria, review findings, and judge result. Synthesize decisions, constraints, and norms into a wiki record via proposeFromPassedTask() or kata wiki ingest.",
      ...codegraphRefresh ? { codegraphRefresh } : {}
    }
  };
}
async function cmdHotfix(taskId, root, options) {
  const openResult = await cmdOpen(taskId, root, {
    title: options.title ?? `Hotfix ${taskId}`,
    acceptance: options.acceptance ?? [{ id: "AC-1", statement: "Fix is correct." }],
    guard: options.guard,
    workflowProfile: options.workflowProfile
  });
  if (!openResult.success) return openResult;
  const designResult = await cmdDesign(taskId, root, options);
  if (!designResult.success) return designResult;
  const buildResult = await cmdBuild(taskId, root, options);
  if (!buildResult.success) return buildResult;
  return buildResult;
}
async function cmdTweak(taskId, root, options) {
  const openResult = await cmdOpen(taskId, root, {
    title: options.title ?? `Tweak ${taskId}`,
    acceptance: options.acceptance ?? [{ id: "AC-1", statement: "Tweak is correct." }],
    guard: options.guard,
    workflowProfile: options.workflowProfile
  });
  if (!openResult.success) return openResult;
  await cmdDesign(taskId, root, options);
  const buildResult = await cmdBuild(taskId, root, options);
  if (!buildResult.success) return buildResult;
  return buildResult;
}

// src/workflow/context-fabric.ts
import { createHash as createHash6, randomUUID as randomUUID6 } from "node:crypto";
import { execFileSync as execFileSync3 } from "node:child_process";
import { mkdir as mkdir14, readFile as readFile18, writeFile as writeFile14 } from "node:fs/promises";
import { join as join22, resolve as resolve5 } from "node:path";
import { existsSync as existsSync2 } from "node:fs";
async function createContextPacket(input) {
  assertValidTaskId(input.taskId);
  assertRole(input.fromRole);
  assertRole(input.toRole);
  const handoff = await createHandoff(input.root, input.taskId, input.toRole);
  const task = JSON.parse(await readFile18(join22(input.root, ".kata/tasks", input.taskId, "task.json"), "utf8"));
  const context = await buildContextManifest({ root: input.root, taskId: input.taskId, sourceRefs: handoff.context.sourceRefs });
  const designRefs = designRefsFor(input.root, input.taskId, input.toRole);
  const packet = { protocolVersion: 1, id: `handoff-${randomUUID6().slice(0, 12)}`, taskId: input.taskId, createdAt: (/* @__PURE__ */ new Date()).toISOString(), from: { role: input.fromRole, ...input.platform ? { platform: safePlatform(input.platform) } : {} }, to: { role: input.toRole }, phase: handoff.fromPhase, repository: await anchor(input.root, input.taskId), task, context: { requiredReads: existingReads(input.root, input.taskId, designRefs), designRefs, sourceRefs: [...handoff.context.sourceRefs].sort(), authoritativeWiki: context.authoritativeWiki.map((record) => ({ id: record.id, path: `.kata/wiki/${record.id}.json` })), excludedWiki: context.excludedWiki.map((record) => ({ id: record.id, reason: record.reason })), evidencePaths: handoff.context.evidenceIds.map((id) => `.kata/evidence/${id}`), priorArtifacts: roleArtifacts(input.root, input.taskId) }, permissions: { allowedWrites: allowedWrites(input.toRole, input.taskId, input.root), guardInstructions: handoff.guardInstructions }, nextAction: `Perform ${input.toRole} work after verifying this handoff.` };
  await writePacket(input.root, packet);
  return packet;
}
async function readContextPacket(root, taskId, id) {
  assertValidTaskId(taskId);
  safeId(id);
  return JSON.parse(await readFile18(packetPath(root, taskId, id), "utf8"));
}
async function acknowledgeContextPacket(input) {
  const packet = await readContextPacket(input.root, input.taskId, input.id);
  assertRole(input.role);
  if (packet.to.role !== input.role) throw new Error(`Handoff role ${input.role} does not match packet recipient ${packet.to.role}.`);
  const verification = await verifyContextPacket({ root: input.root, taskId: input.taskId, id: input.id });
  if (!verification.valid) throw new Error(`Cannot acknowledge invalid handoff packet: ${verification.reason}`);
  const receipt = { protocolVersion: 1, taskId: input.taskId, handoffId: input.id, platform: safePlatform(input.platform), role: input.role, packetSha256: hash(JSON.stringify(packet)), acknowledgedAt: (/* @__PURE__ */ new Date()).toISOString(), repository: await anchor(input.root, input.taskId) };
  await writeFile14(receiptPath(input.root, input.taskId, input.id), `${JSON.stringify(receipt, null, 2)}
`);
  return receipt;
}
async function requireAcknowledgedContextPacket(input) {
  const packet = await readContextPacket(input.root, input.taskId, input.id);
  if (packet.to.role !== input.role) throw new Error(`Handoff role ${input.role} does not match packet recipient ${packet.to.role}.`);
  const verification = await verifyContextPacket({ root: input.root, taskId: input.taskId, id: input.id });
  if (!verification.valid) throw new Error(`Cannot use invalid handoff packet: ${verification.reason}`);
  let receipt;
  try {
    receipt = JSON.parse(await readFile18(receiptPath(input.root, input.taskId, input.id), "utf8"));
  } catch {
    throw new Error(`Workflow mutation requires an acknowledged receipt for handoff ${input.id}.`);
  }
  if (receipt.taskId !== input.taskId || receipt.handoffId !== input.id || receipt.role !== input.role) {
    throw new Error(`Workflow mutation requires an acknowledged receipt for the expected ${input.role} role.`);
  }
  if (receipt.packetSha256 !== hash(JSON.stringify(packet))) {
    throw new Error(`Workflow mutation requires a current acknowledged receipt for handoff ${input.id}.`);
  }
  return receipt;
}
async function verifyContextPacket(input) {
  const packet = await readContextPacket(input.root, input.taskId, input.id);
  const current = await anchor(input.root, input.taskId);
  if (packet.repository.head !== current.head) return { valid: false, reason: "head_mismatch" };
  if (packet.repository.branch !== current.branch) return { valid: false, reason: "branch_mismatch" };
  if (packet.repository.scope && !sameScopeIdentity(packet.repository.scope, current.scope)) return { valid: false, reason: "diff_mismatch" };
  if (packet.repository.diffHash !== current.diffHash) return { valid: false, reason: "diff_mismatch" };
  try {
    const receipt = JSON.parse(await readFile18(receiptPath(input.root, input.taskId, input.id), "utf8"));
    if (receipt.packetSha256 !== hash(JSON.stringify(packet))) return { valid: false, reason: "packet_hash_mismatch" };
  } catch {
  }
  return { valid: true };
}
async function anchor(root, taskId) {
  const revision = await readCurrentTaskRevision(root, taskId);
  const scope = revision ? { kind: "revision", revisionId: revision.id, paths: revision.ownedPaths, hash: await computeManifestHash(root, revision.ownedPaths) } : { kind: "task_context", paths: taskContextPaths(root, taskId), hash: await computeManifestHash(root, taskContextPaths(root, taskId)) };
  return { head: git(root, ["rev-parse", "HEAD"]), branch: git(root, ["branch", "--show-current"]), diffHash: scope.hash, scope, worktreeRoot: "." };
}
function git(root, args) {
  try {
    const value = execFileSync3("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return value || null;
  } catch {
    return null;
  }
}
function existingReads(root, taskId, designRefs) {
  return ["AGENTS.md", ".llmwiki/SCHEMA.md", ".llmwiki/index.md", ".llmwiki/log.md", `.kata/tasks/${taskId}/task.json`, `.kata/tasks/${taskId}/current-state.json`, ...designRefs].filter((path) => {
    try {
      return resolve5(root, path).startsWith(resolve5(root));
    } catch {
      return false;
    }
  });
}
function designRefsFor(root, taskId, role) {
  const designPath = `.kata/tasks/${taskId}/design.md`;
  return role === "implementer" && existsSync2(join22(root, designPath)) ? [designPath] : [];
}
function taskContextPaths(root, taskId) {
  const base = `.kata/tasks/${taskId}`;
  return [`${base}/task.json`, `${base}/current-state.json`, ...existsSync2(join22(root, base, "design.md")) ? [`${base}/design.md`] : []];
}
function sameScopeIdentity(left, right) {
  if (left.kind !== right.kind || left.paths.length !== right.paths.length) return false;
  if (left.kind === "revision" && (right.kind !== "revision" || left.revisionId !== right.revisionId)) return false;
  return left.paths.every((path, index) => path === right.paths[index]);
}
function roleArtifacts(root, taskId) {
  const base = `.kata/tasks/${taskId}`;
  return [`${base}/review.json`, `${base}/judge.json`, `${base}/repair.json`];
}
function allowedWrites(role, taskId, root = process.cwd()) {
  if (role === "designer") return ["docs/", `.kata/tasks/${taskId}/`];
  if (role === "implementer") return [existsSync2(join22(root, "packages")) ? "packages/" : "src/", "tests/", "docs/"];
  return [`.kata/tasks/${taskId}/${role === "reviewer" ? "review.json" : role === "judge" ? "judge.json" : "wiki/"}`];
}
async function writePacket(root, packet) {
  const directory = join22(root, ".kata/tasks", packet.taskId, "handoffs");
  await mkdir14(directory, { recursive: true });
  await writeFile14(packetPath(root, packet.taskId, packet.id), `${JSON.stringify(packet, null, 2)}
`);
}
function packetPath(root, taskId, id) {
  return join22(root, ".kata/tasks", taskId, "handoffs", `${id}.json`);
}
function receiptPath(root, taskId, id) {
  return join22(root, ".kata/tasks", taskId, "handoffs", `${id}.receipt.json`);
}
function hash(value) {
  return createHash6("sha256").update(value).digest("hex");
}
function safeId(id) {
  if (!/^handoff-[a-z0-9-]{1,63}$/.test(id)) throw new Error("Invalid handoff id");
}
function safePlatform(platform) {
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(platform)) throw new Error("Invalid platform");
  return platform;
}
function assertRole(role) {
  if (!["designer", "implementer", "reviewer", "judge", "distiller", "approver"].includes(role)) throw new Error(`Invalid handoff role: ${role}`);
}

// src/workflow/delegation-prompt.ts
async function createWorkflowHandoff(input) {
  const packet = await createContextPacket(input);
  return {
    packet,
    prompt: renderDelegationPrompt(input.taskId, packet.id, "<actual-platform>", input.toRole, packet.context.designRefs)
  };
}
function renderDelegationPrompt(taskId, handoffId, platform, role, designRefs = []) {
  const designGuidance = role === "implementer" && designRefs.length > 0 ? ["", "\u7ED1\u5B9A\u8BBE\u8BA1\u5F15\u7528\uFF08\u5FC5\u987B\u5148\u9605\u8BFB\uFF09\uFF1A", ...designRefs.map((path) => `- ${path}`)] : [];
  const implementationGuidance = role === "implementer" ? [
    "",
    `\u5148\u8FDB\u5165\u5B9E\u65BD\u9636\u6BB5\uFF08\u6B64\u65F6\u4E0D\u8981 seal\uFF09\uFF1A/kata-build ${taskId}`,
    `CLI fallback\uFF1Akata build --change ${taskId}`,
    "\u6536\u5230\u5B9E\u65BD\u9636\u6BB5\u7684 TDD \u5408\u540C\u540E\uFF0C\u518D\u5F00\u59CB\u9605\u8BFB\u3001\u6D4B\u8BD5\u4E0E\u7F16\u7801\u3002",
    "",
    "\u5B9E\u65BD\u987A\u5E8F\uFF1A\u5148\u9605\u8BFB\u8BBE\u8BA1\u5F15\u7528\u548C requiredReads\uFF0C\u5148\u5199\u805A\u7126\u7684\u5931\u8D25\u6D4B\u8BD5\uFF08RED\uFF09\uFF0C\u518D\u6700\u5C0F\u5B9E\u73B0\u5E76\u8FD0\u884C\u805A\u7126 GREEN\u3002",
    "\u4E0D\u8981\u5728\u7F16\u7801\u524D\u5C01\u5B58 build \u8BC1\u636E\u3002\u5B9E\u73B0\u548C\u805A\u7126\u6D4B\u8BD5\u5B8C\u6210\u540E\uFF0C\u518D\u6267\u884C\uFF1A",
    `kata build --change ${taskId} --seal`
  ] : [];
  return [
    `\u8BF7\u4F7F\u7528 Kata \u63A5\u624B\u4EFB\u52A1\uFF1A${taskId}`,
    "",
    `Role: ${role}`,
    "Platform: choose the receiving host platform.",
    `Handoff: ${handoffId}`,
    "",
    "\u5148\u6267\u884C\uFF1A",
    "",
    `kata handoff verify --task ${taskId} --id ${handoffId}`,
    `kata handoff show --task ${taskId} --id ${handoffId}`,
    `kata handoff acknowledge --task ${taskId} --id ${handoffId} --platform <actual-platform> --role ${role}`,
    "",
    "\u7136\u540E\u8BFB\u53D6 packet.requiredReads \u4E2D\u7684\u6240\u6709\u6587\u4EF6\uFF0C\u9075\u5B88 allowedWrites \u548C guardInstructions\uFF0C\u8FD0\u884C\u5339\u914D\u7684 /kata-* skill\u3002",
    ...designGuidance,
    "\u63A5\u6536\u65B9\u53EF\u5728\u4EFB\u610F\u5DF2\u8BC6\u522B\u5E73\u53F0\u63A5\u624B\uFF0C\u5E76\u4F7F\u7528\u8BE5\u5E73\u53F0\u81EA\u5DF1\u7684\u6A21\u578B\u9009\u62E9\u5668\u6216\u914D\u7F6E\uFF1BKata \u4E0D\u914D\u7F6E\u3001\u4E0D\u8DEF\u7531\u4E5F\u4E0D\u8BB0\u5F55\u5BBF\u4E3B\u6A21\u578B\u3002",
    ...implementationGuidance,
    "\u4E0D\u8981\u6267\u884C\u8D85\u51FA\u59D4\u6258\u89D2\u8272\u7684\u540E\u7EED\u9636\u6BB5\u3002"
  ].join("\n");
}

// src/workflow/user-choice-gate.ts
import { mkdir as mkdir15, readFile as readFile19, writeFile as writeFile15 } from "node:fs/promises";
import { join as join23 } from "node:path";
async function createUserChoiceGate(input) {
  assertValidTaskId(input.taskId);
  const gate = { taskId: input.taskId, boundary: input.boundary, ...input.revisionId ? { revisionId: input.revisionId } : {}, createdAt: (/* @__PURE__ */ new Date()).toISOString() };
  await mkdir15(join23(input.root, ".kata/tasks", input.taskId), { recursive: true });
  await writeFile15(pathFor2(input.root, input.taskId, input.boundary), `${JSON.stringify(gate, null, 2)}
`);
}
async function approveUserChoiceGate(input) {
  const gate = await readGate(input.root, input.taskId, input.boundary);
  assertRevision(gate, input.revisionId);
  if (gate.consumedAt) throw new Error(`User choice gate ${input.boundary} has already been consumed.`);
  gate.choice = input.choice;
  gate.approvedAt = (/* @__PURE__ */ new Date()).toISOString();
  await writeFile15(pathFor2(input.root, input.taskId, input.boundary), `${JSON.stringify(gate, null, 2)}
`);
}
async function requireUserChoiceGate(input) {
  const gate = await readGate(input.root, input.taskId, input.boundary).catch(() => void 0);
  if (!gate || !gate.choice || gate.consumedAt) throw new Error(`${input.boundary} requires an explicit user choice before continuing.`);
  assertRevision(gate, input.revisionId);
  return gate;
}
async function consumeUserChoiceGate(input) {
  const gate = await requireUserChoiceGate(input);
  gate.consumedAt = (/* @__PURE__ */ new Date()).toISOString();
  await writeFile15(pathFor2(input.root, input.taskId, input.boundary), `${JSON.stringify(gate, null, 2)}
`);
}
async function readGate(root, taskId, boundary) {
  assertValidTaskId(taskId);
  return JSON.parse(await readFile19(pathFor2(root, taskId, boundary), "utf8"));
}
function assertRevision(gate, revisionId) {
  if (gate.revisionId !== revisionId) throw new Error(`User choice gate ${gate.boundary} is not bound to the current revision.`);
}
function pathFor2(root, taskId, boundary) {
  return join23(root, ".kata/tasks", taskId, `user-choice-${boundary}.json`);
}

// src/wiki/drift.ts
init_record();
init_store();
import { readFile as readFile20 } from "node:fs/promises";
import { join as join24 } from "node:path";
async function verifySources(root) {
  const records = await readWikiRecords(root);
  const intact = [];
  const stale = [];
  const missingSources = /* @__PURE__ */ new Set();
  for (const record of records) {
    if (record.status === "rejected") {
      intact.push(record.id);
      continue;
    }
    const changedSources = [];
    const sourceHashEntries = Object.entries(record.sourceHashes);
    if (record.sourceRefs.length > 0 && sourceHashEntries.length === 0) {
      stale.push({ id: record.id, reason: "source_missing", changedSources: [...record.sourceRefs] });
      for (const sourceRef of record.sourceRefs) missingSources.add(sourceRef);
      await updateWikiRecord(root, record.id, { status: "stale" });
      continue;
    }
    for (const [sourcePath, expectedHash] of sourceHashEntries) {
      try {
        const absolutePath = join24(root, sourcePath);
        const content = await readFile20(absolutePath, "utf8");
        const currentHash = computeFileHash(content);
        if (currentHash !== expectedHash) {
          changedSources.push(sourcePath);
        }
      } catch {
        changedSources.push(sourcePath);
        missingSources.add(sourcePath);
      }
    }
    if (changedSources.length > 0) {
      const reason = changedSources.some((s) => missingSources.has(s)) ? "source_missing" : "source_changed";
      stale.push({ id: record.id, reason, changedSources });
      await updateWikiRecord(root, record.id, { status: "stale" });
    } else {
      intact.push(record.id);
    }
  }
  return {
    checked: records.length,
    intact,
    stale,
    missing: [...missingSources].sort()
  };
}

// src/wiki/promotion.ts
init_store();
async function promote(root, id, approval) {
  const record = await findWikiRecord(root, id);
  if (!record) {
    throw new Error(`Wiki record '${id}' not found`);
  }
  if (record.status !== "candidate") {
    throw new Error(`Cannot promote record '${id}': current status is '${record.status}', expected 'candidate'`);
  }
  const updated = await updateWikiRecord(root, id, {
    status: "verified",
    lastVerifiedAt: approval.approvedAt,
    approvalEvent: { ...approval }
  });
  return updated;
}
async function rejectCandidate(root, id, rejection) {
  const record = await findWikiRecord(root, id);
  if (!record) {
    throw new Error(`Wiki record '${id}' not found`);
  }
  if (record.status !== "candidate") {
    throw new Error(`Cannot reject record '${id}': current status is '${record.status}', expected 'candidate'`);
  }
  const updated = await updateWikiRecord(root, id, { status: "rejected", rejectionEvent: { ...rejection } });
  return updated;
}
async function retireWikiRecord(root, id, rejection) {
  const record = await findWikiRecord(root, id);
  if (!record) {
    throw new Error(`Wiki record '${id}' not found`);
  }
  if (record.status === "rejected") {
    throw new Error(`Cannot retire record '${id}': current status is already 'rejected'`);
  }
  const reason = rejection.reason.startsWith("retired:") ? rejection.reason : `retired: ${rejection.reason}`;
  const updated = await updateWikiRecord(root, id, {
    status: "rejected",
    rejectionEvent: { ...rejection, reason }
  });
  return updated;
}

// src/cli.ts
init_store();

// src/wiki/lifecycle.ts
import { mkdir as mkdir16, readFile as readFile21, readdir as readdir9, writeFile as writeFile16 } from "node:fs/promises";
import { join as join25 } from "node:path";
init_store();
var reviewAfterDays = 90;
var maxCandidatesPerTask = 2;
async function auditWiki(root) {
  const recordsBeforeDrift = await readWikiRecords(root);
  const sources = await verifySources(root);
  const lint = await lintLlmWiki({ root });
  const records = await readWikiRecords(root);
  const now = Date.now();
  const reviewDueIds = recordsBeforeDrift.filter((record) => record.status === "verified" && now - Date.parse(record.lastVerifiedAt) > reviewAfterDays * 864e5).map((record) => record.id).sort();
  const duplicates = /* @__PURE__ */ new Map();
  for (const record of records.filter((item) => item.status === "candidate" || item.status === "verified")) {
    const key = record.statement.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
    duplicates.set(key, [...duplicates.get(key) ?? [], record.id]);
  }
  const candidatesByTask = /* @__PURE__ */ new Map();
  for (const record of recordsBeforeDrift.filter((item) => item.status === "candidate")) candidatesByTask.set(record.validationTaskId, (candidatesByTask.get(record.validationTaskId) ?? 0) + 1);
  const pages = await countPages(join25(root, ".llmwiki"));
  const duplicateGroups = [...duplicates.values()].filter((group) => group.length > 1).sort((a, b) => a[0].localeCompare(b[0]));
  const overBudgetTasks = [...candidatesByTask.entries()].filter(([, count]) => count > maxCandidatesPerTask).map(([taskId, candidates]) => ({ taskId, candidates, limit: maxCandidatesPerTask })).sort((a, b) => a.taskId.localeCompare(b.taskId));
  const recommendedActions = lifecycleActions(records, {
    sourceDrift: sources.stale,
    reviewDueIds,
    duplicateGroups,
    overBudgetTaskIds: new Set(overBudgetTasks.map((entry) => entry.taskId)),
    originalStatusById: new Map(recordsBeforeDrift.map((record) => [record.id, record.status]))
  });
  return { generatedAt: (/* @__PURE__ */ new Date()).toISOString(), pageCount: pages, staleIds: sources.stale.map((entry) => entry.id).sort(), reviewDueIds, duplicateGroups, overBudgetTasks, lintOk: lint.ok, lintIssues: lint.issues.length, recommendedActions };
}
async function createRefreshPacket(root, taskId) {
  const audit = await auditWiki(root);
  const path = join25(root, ".kata/tasks", taskId, "wiki-refresh.json");
  await mkdir16(join25(root, ".kata/tasks", taskId), { recursive: true });
  await writeFile16(path, `${JSON.stringify({ taskId, generatedAt: audit.generatedAt, staleIds: audit.staleIds, reviewDueIds: audit.reviewDueIds, duplicateGroups: audit.duplicateGroups, instructions: ["Revalidate code/document anchors before editing.", "Update, merge, mark stale, or reject records; do not promote automatically."] }, null, 2)}
`);
  return { path: `.kata/tasks/${taskId}/wiki-refresh.json`, audit };
}
async function relevantWiki(root, taskId, limit = 8) {
  const task = JSON.parse(await readFile21(join25(root, ".kata/tasks", taskId, "task.json"), "utf8"));
  const terms = new Set(`${task.title ?? ""} ${(task.acceptance ?? []).map((item) => item.statement ?? "").join(" ")}`.toLowerCase().match(/[\p{L}\p{N}_-]{3,}/gu) ?? []);
  return (await readWikiRecords(root)).filter((record) => record.status === "verified").map((record) => ({ record, score: score(record, terms) })).filter((item) => item.score > 0).sort((a, b) => b.score - a.score || a.record.id.localeCompare(b.record.id)).slice(0, limit).map((item) => item.record);
}
function score(record, terms) {
  const text = `${record.statement} ${record.scope.join(" ")} ${record.sourceRefs.join(" ")}`.toLowerCase();
  return [...terms].reduce((total, term) => total + (text.includes(term) ? 1 : 0), 0);
}
async function countPages(root) {
  try {
    const entries = await readdir9(root, { withFileTypes: true });
    const counts = await Promise.all(entries.map((entry) => entry.isDirectory() ? countPages(join25(root, entry.name)) : entry.name.endsWith(".md") ? 1 : 0));
    return counts.reduce((a, b) => a + b, 0);
  } catch {
    return 0;
  }
}
function lifecycleActions(records, context) {
  const actions = /* @__PURE__ */ new Map();
  const driftById = new Map(context.sourceDrift.map((entry) => [entry.id, entry]));
  const duplicateIds = new Set(context.duplicateGroups.flat());
  const reviewDueIds = new Set(context.reviewDueIds);
  for (const record of records.filter((item) => item.status !== "rejected")) {
    const reasons = [];
    const changedSources = [];
    const drift = driftById.get(record.id);
    if (drift) {
      reasons.push(drift.reason);
      changedSources.push(...drift.changedSources);
    }
    if (duplicateIds.has(record.id)) reasons.push("duplicate");
    if (reviewDueIds.has(record.id)) reasons.push("review_due");
    const originalStatus = context.originalStatusById.get(record.id) ?? record.status;
    if (originalStatus === "candidate" && context.overBudgetTaskIds.has(record.validationTaskId)) reasons.push("candidate_over_budget");
    const successors = records.filter((candidate) => candidate.id !== record.id && candidate.status !== "rejected" && candidate.kind === record.kind && overlaps(candidate.scope, record.scope) && hasSuccessorLanguage(candidate.statement)).map((candidate) => candidate.id).sort();
    if (successors.length > 0) reasons.push("semantic_superseded");
    if (usesAbsoluteLanguage(record.statement) && records.some((candidate) => candidate.id !== record.id && overlaps(candidate.scope, record.scope) && (hasConditionalLanguage(candidate.statement) || hasSuccessorLanguage(candidate.statement)))) {
      reasons.push("scope_changed");
    }
    if (records.some((candidate) => candidate.id !== record.id && candidate.kind === record.kind && overlaps(candidate.scope, record.scope) && conflicts(record.statement, candidate.statement))) {
      reasons.push("conflict");
    }
    const uniqueReasons = [...new Set(reasons)];
    if (uniqueReasons.length === 0) continue;
    actions.set(record.id, {
      id: record.id,
      status: record.status,
      reasons: uniqueReasons,
      recommendedAction: chooseAction(record, uniqueReasons, successors),
      confidence: confidence(uniqueReasons, successors),
      successorIds: successors,
      changedSources: [...new Set(changedSources)].sort()
    });
  }
  return [...actions.values()].sort((a, b) => a.id.localeCompare(b.id));
}
function chooseAction(record, reasons, successors) {
  if (reasons.includes("semantic_superseded") && successors.length > 0) return "retire";
  if (reasons.includes("conflict")) return "review_conflict";
  if (reasons.includes("source_missing") && record.status !== "verified") return "retire";
  if (reasons.includes("duplicate") && record.status === "candidate") return reasons.includes("candidate_over_budget") ? "merge" : "retire_duplicate";
  if (reasons.includes("source_changed") || reasons.includes("scope_changed")) return "revalidate";
  return "review";
}
function confidence(reasons, successors) {
  if ((reasons.includes("source_missing") || reasons.includes("semantic_superseded")) && successors.length > 0) return "high";
  if (reasons.includes("source_changed") || reasons.includes("duplicate")) return "medium";
  return "low";
}
function overlaps(a, b) {
  return a.some((left) => b.includes(left));
}
function hasSuccessorLanguage(statement) {
  return /replace|replaces|supersede|supersedes|no longer|instead|自动|不再|替代/i.test(statement);
}
function hasConditionalLanguage(statement) {
  return /legacy|current_worktree|mode|profile|revision-bound|revision scoped|条件|模式/i.test(statement);
}
function usesAbsoluteLanguage(statement) {
  return /\ball\b|\balways\b|\bnever\b|\bmust\b|所有|必须/i.test(statement);
}
function conflicts(a, b) {
  const text = `${a}
${b}`.toLowerCase();
  return [
    ["manual", "automatic"],
    ["required", "optional"],
    ["repository-wide", "revision-scoped"],
    ["promote", "reject"],
    ["\u624B\u52A8", "\u81EA\u52A8"],
    ["\u5168\u4ED3", "revision"]
  ].some(([left, right]) => text.includes(left) && text.includes(right));
}

// src/hooks/runtime.ts
import { mkdir as mkdir17, readFile as readFile22, rm as rm4, writeFile as writeFile17 } from "node:fs/promises";
import { dirname as dirname7, join as join26 } from "node:path";
async function activateHookTask(input) {
  assertValidTaskId(input.taskId);
  const phase = await readTaskPhase(input.root, input.taskId);
  const expectedRole = roleForPhase(phase);
  if (input.role !== expectedRole) {
    throw new Error(`Hook role ${input.role} does not match current phase ${phase}; expected ${expectedRole}.`);
  }
  const branch = currentGitBranch(input.root);
  const active = {
    taskId: input.taskId,
    role: input.role,
    phase,
    ...input.platform ? { platform: input.platform } : {},
    ...branch ? { branch } : {},
    origin: input.origin ?? "manual",
    activatedAt: (/* @__PURE__ */ new Date()).toISOString()
  };
  const path = activeHookTaskPath(input.root);
  await mkdir17(dirname7(path), { recursive: true });
  await writeFile17(path, `${JSON.stringify(active, null, 2)}
`, "utf8");
  return active;
}
function roleForPhase(phase) {
  if (phase === "intake" || phase === "plan") return "designer";
  if (phase === "implement") return "implementer";
  if (phase === "hardVerify" || phase === "review") return "reviewer";
  if (phase === "judge") return "judge";
  if (phase === "distill") return "distiller";
  return "approver";
}
async function deactivateHookTask(root) {
  await rm4(activeHookTaskPath(root), { force: true });
}
async function readActiveHookTask(root) {
  try {
    return JSON.parse(await readFile22(activeHookTaskPath(root), "utf8"));
  } catch (error) {
    if (isNodeError7(error) && error.code === "ENOENT") return null;
    throw error;
  }
}
async function readTaskPhase(root, taskId) {
  const state = JSON.parse(await readFile22(join26(root, ".kata/tasks", taskId, "current-state.json"), "utf8"));
  return state.phase;
}
function activeHookTaskPath(root) {
  return join26(root, ".kata/runtime/active-task.json");
}
function isNodeError7(error) {
  return error instanceof Error && "code" in error;
}

// src/adapters/doctor.ts
import { readFile as readFile23, stat as stat5 } from "node:fs/promises";
import { join as join27 } from "node:path";
async function doctor(platform, scope, options = {}) {
  const root = installationRoot(scope, options);
  const manifest = await readOwnershipManifest(root);
  const checks = [];
  for (const command of skillCommands) {
    checks.push(await checkPath(root, manifest, platformSkillPath(platform, scope, command.id), "skill"));
    const commandPath = platformCommandPath(platform, scope, command.id);
    if (commandPath) checks.push(await checkPath(root, manifest, commandPath, "command"));
  }
  const rulePath = platformRulePath(platform, scope, "kata-agent-contract");
  if (rulePath) checks.push(await checkPath(root, manifest, rulePath, "rule"));
  const definition = platformDefinitionById[platform];
  if (definition.hookFormat) {
    const base = platformSkillsDir(platform, scope);
    checks.push(await checkPath(root, manifest, `${base}/hooks/kata-hook-guard.mjs`, "hook"));
    const hookConfigPath = hookConfigPathFor2(platform, scope);
    if (hookConfigPath) checks.push(await checkPath(root, manifest, hookConfigPath, "hook"));
  }
  if (scope === "project") {
    checks.push(await checkPath(root, manifest, "AGENTS.md", "support"));
    checks.push(await checkPath(root, manifest, ".kata/skills-index.md", "support"));
    checks.push(await checkExists(root, ".llmwiki", "wiki"));
  }
  const summary = summarize(checks);
  return {
    command: "doctor",
    platform,
    scope,
    root,
    ok: summary.missing === 0 && summary.conflicts === 0,
    checks,
    summary
  };
}
function hookConfigPathFor2(platform, scope) {
  const base = platformSkillsDir(platform, scope);
  const format = platformDefinitionById[platform].hookFormat;
  if (format === "claude-code") return `${base}/settings.local.json`;
  if (format === "gemini") return `${base}/settings.json`;
  if (format === "windsurf") return `${base}/hooks.json`;
  if (format === "copilot") return `${base}/hooks/kata-guard.json`;
  return null;
}
async function checkPath(root, manifest, relativePath, kind) {
  const content = await readOptional2(join27(root, relativePath));
  if (content === void 0) return { path: relativePath, kind, status: "missing" };
  const owned = manifest.files?.[relativePath];
  if (owned?.sha256 && owned.sha256 !== sha2562(content)) {
    return { path: relativePath, kind, status: "conflict", reason: "content differs from ownership manifest" };
  }
  return { path: relativePath, kind, status: "ok" };
}
async function checkExists(root, relativePath, kind) {
  try {
    await stat5(join27(root, relativePath));
    return { path: relativePath, kind, status: "ok" };
  } catch (error) {
    if (isNodeError8(error) && error.code === "ENOENT") return { path: relativePath, kind, status: "missing" };
    throw error;
  }
}
async function readOwnershipManifest(root) {
  const content = await readOptional2(join27(root, ".kata/adapters/manifest.json"));
  if (!content) return {};
  try {
    return JSON.parse(content);
  } catch {
    return {};
  }
}
async function readOptional2(path) {
  try {
    return await readFile23(path, "utf8");
  } catch (error) {
    if (isNodeError8(error) && error.code === "ENOENT") return void 0;
    throw error;
  }
}
function summarize(checks) {
  const summary = { ok: 0, missing: 0, conflicts: 0, skipped: 0 };
  for (const check of checks) {
    if (check.status === "conflict") summary.conflicts += 1;
    else summary[check.status] += 1;
  }
  return summary;
}
function isNodeError8(error) {
  return error instanceof Error && "code" in error;
}

// src/core/git-flow.ts
import { execFileSync as execFileSync4, spawn as spawn3 } from "node:child_process";
var runGit = (root, args) => {
  try {
    return { ok: true, stdout: execFileSync4("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() };
  } catch {
    return { ok: false, stdout: "" };
  }
};
function inspectGitFlow(root, taskId, run = runGit, branchKind = "feature", install2 = installGitFlow) {
  const dirty = run(root, ["status", "--porcelain"]);
  if (!dirty.ok) return failed("repository_unavailable");
  const unmanagedChanges = (dirty.stdout ?? "").split("\n").filter((line) => line.trim() && !line.slice(3).startsWith(".kata/"));
  if (unmanagedChanges.length > 0) return failed("worktree_dirty");
  const currentBranch = run(root, ["branch", "--show-current"]);
  const configuredBase = run(root, ["config", "--get", baseConfigKey(branchKind)]);
  const fallbackBase = branchKind === "hotfix" ? "master" : "develop";
  const baseBranch = configuredBase.ok && configuredBase.stdout ? configuredBase.stdout : run(root, ["rev-parse", "--verify", "--quiet", fallbackBase]).ok ? fallbackBase : currentBranch.ok && currentBranch.stdout ? currentBranch.stdout : "";
  if (!baseBranch) return failed("base_branch_unresolved");
  const branch = `${branchKind}/${taskId}`;
  const existing = run(root, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]).ok;
  let flowVersion = configuredBase.ok ? run(root, ["flow", "version"]) : { ok: false, stdout: "" };
  let installation = configuredBase.ok && !flowVersion.ok ? install2(root) : void 0;
  if (installation?.status === "installed") {
    flowVersion = run(root, ["flow", "version"]);
    if (!flowVersion.ok) installation = { ...installation, status: "failed" };
  }
  const gitFlowAvailable = configuredBase.ok && flowVersion.ok;
  const strategy = gitFlowAvailable ? "git-flow" : "manual";
  if (existing) {
    if (currentBranch.stdout === branch) return { strategy, branch, baseBranch, status: "active", command: [], ...installation ? { installation } : {} };
    return { strategy, branch, baseBranch, status: "failed", command: [], reason: "target_branch_exists", ...installation ? { installation } : {} };
  }
  return {
    strategy,
    branch,
    baseBranch,
    status: "pending_confirmation",
    command: strategy === "git-flow" ? ["flow", branchKind, "start", taskId] : ["switch", "-c", branch, baseBranch],
    ...installation ? { installation } : {}
  };
}
function baseConfigKey(branchKind) {
  return branchKind === "hotfix" ? "gitflow.branch.master" : "gitflow.branch.develop";
}
var installAttemptConfigKey = "kata.gitflow-install-attempted";
var packageManagers = {
  darwin: [{ binary: "brew", args: ["install", "git-flow-avh"], manualCommand: "brew install git-flow-avh" }],
  linux: [
    { binary: "apt-get", args: ["install", "-y", "git-flow"], manualCommand: "sudo apt-get install -y git-flow" },
    { binary: "dnf", args: ["install", "-y", "gitflow"], manualCommand: "sudo dnf install -y gitflow" },
    { binary: "pacman", args: ["-S", "--noconfirm", "gitflow"], manualCommand: "sudo pacman -S --noconfirm gitflow" },
    { binary: "apk", args: ["add", "git-flow"], manualCommand: "sudo apk add git-flow" }
  ]
};
var commandExists = (command) => {
  try {
    execFileSync4(command, ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};
var installGitFlow = (root) => {
  const candidate = packageManagers[process.platform]?.find(({ binary }) => commandExists(binary));
  if (!candidate) {
    return {
      status: "unsupported",
      manualCommand: process.platform === "win32" ? "Install Git Flow for Windows, then rerun the Kata command." : "Install git-flow with your system package manager, then rerun the Kata command."
    };
  }
  if (runGit(root, ["config", "--local", "--get", installAttemptConfigKey]).ok) {
    return { status: "failed", command: [candidate.binary, ...candidate.args], manualCommand: candidate.manualCommand };
  }
  try {
    execFileSync4(candidate.binary, candidate.args, { stdio: "ignore", timeout: 12e4 });
    runGit(root, ["config", "--local", "--unset-all", installAttemptConfigKey]);
    return { status: "installed", command: [candidate.binary, ...candidate.args], manualCommand: candidate.manualCommand };
  } catch {
    runGit(root, ["config", "--local", installAttemptConfigKey, (/* @__PURE__ */ new Date()).toISOString()]);
    return { status: "failed", command: [candidate.binary, ...candidate.args], manualCommand: candidate.manualCommand };
  }
};
async function initializeGitFlowProject(root, options) {
  const run = options.run ?? runGit;
  const install2 = options.install ?? installGitFlow;
  const execute = options.execute ?? ((cwd2, args) => {
    execFileSync4("git", args, { cwd: cwd2, stdio: "ignore", timeout: 12e4 });
  });
  const executeInteractive = options.executeInteractive ?? runInteractiveGitFlow;
  const repository = run(root, ["rev-parse", "--is-inside-work-tree"]);
  if (!repository.ok || repository.stdout !== "true") return { status: "skipped", reason: "not_a_git_repository" };
  const master = run(root, ["config", "--get", "gitflow.branch.master"]);
  const develop = run(root, ["config", "--get", "gitflow.branch.develop"]);
  if (master.ok && develop.ok) return { status: "already_initialized" };
  if (master.ok || develop.ok) return { status: "skipped", reason: "git_flow_partially_initialized" };
  let flowVersion = run(root, ["flow", "version"]);
  const installation = flowVersion.ok ? void 0 : install2(root);
  if (installation?.status === "installed") flowVersion = run(root, ["flow", "version"]);
  if (!flowVersion.ok) {
    return {
      status: "failed",
      ...installation ? { installation } : {},
      reason: installation?.status === "failed" ? "git_flow_install_failed" : "git_flow_unavailable"
    };
  }
  const command = ["flow", "init", ...options.interactive ? [] : ["-d"]];
  try {
    if (options.interactive) await executeInteractive(root, command);
    else execute(root, command);
    return { status: "initialized", command, ...installation ? { installation } : {} };
  } catch (error) {
    return {
      status: "failed",
      command,
      ...installation ? { installation } : {},
      reason: error instanceof Error ? error.message : String(error)
    };
  }
}
function runInteractiveGitFlow(root, args) {
  return new Promise((resolve6, reject) => {
    const child = spawn3("git", args, { cwd: root, stdio: "inherit", env: { ...process.env } });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve6() : reject(new Error(`git ${args.join(" ")} exited with code ${code}`)));
  });
}
function applyGitFlowPlan(root, plan, run = runGit) {
  if (plan.status !== "pending_confirmation" || plan.command.length === 0) return { ...plan, status: "failed" };
  const result = run(root, plan.command);
  return {
    strategy: plan.strategy,
    branch: plan.branch,
    baseBranch: plan.baseBranch,
    status: result.ok ? "active" : "failed",
    ...plan.installation ? { installation: plan.installation } : {}
  };
}
function failed(reason) {
  return { strategy: "manual", branch: "", baseBranch: "", status: "failed", command: [], reason };
}

// src/cli.ts
function getRuntimeCompatibility(manifestPath2) {
  return loadCometCompatibility(manifestPath2);
}
var quietOutput = false;
var jsonOutput = false;
async function main(argv = process.argv.slice(2)) {
  const previousQuiet = quietOutput;
  const previousJson = jsonOutput;
  jsonOutput = previousJson || isJsonOutput(argv);
  quietOutput = previousQuiet || isQuietOutput(argv) || isDefaultSilentInstallerCommand(argv);
  try {
    await runMain(stripOutputModeArgs(argv));
  } finally {
    quietOutput = previousQuiet;
    jsonOutput = previousJson;
  }
}
async function runMain(argv) {
  const [command, maybeChange] = argv;
  if (!command) {
    throw new Error("Usage: kata <init|update|uninstall|discover|comet|codegraph|tasks> [--platform name] [--scope project|global] [--root path]");
  }
  const requestedChange = parseChangeArg(argv.slice(1));
  const workspaceRoot = parseRootArg(argv) ?? (requestedChange && command !== "open" && (isWorkflowCommand(command) || command === "status") ? resolveWorkspaceRootForTask(requestedChange) : resolveWorkspaceRoot());
  if (isWorkflowCommand(command) && (argv.includes("--help") || argv.includes("-h"))) {
    outputResult({
      command,
      usage: "kata <init|update|uninstall|discover|comet|codegraph|status|open|design|build|verify|archive|hotfix|tweak|collect|next> [change|--change change]",
      readOnly: true
    });
    return;
  }
  if (command === "init" && shouldUseInitWizard(argv.slice(1))) {
    const result = await runInitWizardCommand(argv.slice(1), workspaceRoot);
    outputResult(result);
    return;
  }
  if (command === "init" && !process.stdin.isTTY && !argv.includes("--yes") && (!argv.includes("--platform") || !argv.includes("--scope"))) {
    throw new Error("kata init requires explicit --platform and --scope choices in non-interactive mode; use the installation Skill to collect user confirmation first.");
  }
  if (isInstallerCommand(command) && (maybeChange === void 0 || maybeChange.startsWith("--"))) {
    const args = parseInstallerArgs(argv.slice(1));
    if (!args.options.root) args.options.root = workspaceRoot;
    if (command === "uninstall") {
      const platformLabel = args.platform === "generic" ? "all platforms" : args.platform;
      const confirmed = args.options.force ?? await confirmDestructive(
        `Uninstall Kata components from platform: ${platformLabel}`,
        ["Removes hooks, rules, skills, and related files.", "Cannot be undone automatically."]
      );
      if (!confirmed) {
        outputResult({ command: "uninstall", aborted: true });
        return;
      }
    }
    if (command === "update" && !argv.includes("--platform")) {
      outputResult(await runAggregateUpdate(args.scope, args.options));
      return;
    }
    const report = command === "init" ? await install(args.platform, args.scope, args.options) : command === "update" ? await update(args.platform, args.scope, args.options) : await uninstall(args.platform, args.scope, args.options);
    const runtimeRefresh = command === "update" ? await runRuntimeRefresh(args.options.root) : void 0;
    const gitFlowInit = command === "init" ? args.options.dryRun ? { status: "skipped", reason: "dry_run" } : await initializeGitFlowProject(args.options.root, { interactive: process.stdin.isTTY && !args.yes }) : void 0;
    outputResult({
      ...report,
      ...runtimeRefresh ? { runtimeRefresh } : {},
      ...gitFlowInit ? { gitFlowInit } : {}
    });
    return;
  }
  if (command === "discover") {
    const args = parseInstallerArgs(argv.slice(1), { requirePlatform: false });
    if (!args.options.root) args.options.root = workspaceRoot;
    outputResult({ platforms: await discoverPlatforms(args.options) });
    return;
  }
  if (command === "doctor") {
    const result = await runDoctorCommand(argv.slice(1));
    outputResult(result);
    return;
  }
  if (command === "recover") {
    const taskId = parseChangeArg(argv.slice(1)) ?? maybeChange;
    if (!taskId || taskId.startsWith("--")) throw new Error("Usage: kata recover --change <task-id>");
    outputResult({ command: "recover", ...await recover(taskId, { root: workspaceRoot }) });
    return;
  }
  if (command === "wiki") {
    const result = await runWikiCommand(argv.slice(1));
    outputResult(result);
    return;
  }
  if (command === "tasks") {
    const result = await runTasksCommand(argv.slice(1));
    outputResult(result);
    return;
  }
  if (command === "relations") {
    const result = await runRelationsCommand(argv.slice(1));
    outputResult(result);
    return;
  }
  if (command === "orient") {
    const result = await runOrientCommand(argv.slice(1));
    outputResult(result);
    return;
  }
  if (command === "hooks") {
    const result = await runHooksCommand(argv.slice(1));
    outputResult(result);
    return;
  }
  if (command === "handoff") {
    outputResult(await runHandoffCommand(argv.slice(1)));
    return;
  }
  if (command === "gate") {
    outputResult(await runGateCommand(argv.slice(1), workspaceRoot));
    return;
  }
  if (command === "collect") {
    outputResult(await runCollectCommand(argv.slice(1)));
    return;
  }
  if (command === "comet") {
    const result = await runCometCommand(argv.slice(1), workspaceRoot);
    outputResult(result);
    return;
  }
  if (command === "codegraph") {
    const result = await runCodegraphCommand(argv.slice(1));
    outputResult(result);
    return;
  }
  if (command === "git-flow") {
    outputResult(await runGitFlowCommand(argv.slice(1), workspaceRoot));
    return;
  }
  let change = parseChangeArg(argv.slice(1));
  let resolved = null;
  if (!change && (isResumableWorkflowCommand(command) || command === "status")) {
    resolved = await resolveTaskForCurrentBranch(workspaceRoot);
    if (resolved) change = resolved.taskId;
  }
  if (command === "status" && !change) {
    outputResult(await runDispatchStatusCommand(workspaceRoot));
    return;
  }
  if (!change) {
    throw new Error(
      "Usage: kata <init|update|uninstall|discover|comet|codegraph|status|open|design|build|verify|archive|hotfix|tweak|collect|next> [change|--change change]"
    );
  }
  if (command === "status") {
    outputResult(await runLocalStatusCommand(change, resolved, workspaceRoot));
    return;
  }
  const client = new CometClient({ compatibility: getRuntimeCompatibility() });
  if (command === "init") {
    const initLanguage = process.stdin.isTTY ? await (await Promise.resolve().then(() => (init_prompt(), prompt_exports))).select("Language for skills", [
      { value: "en", label: "English" },
      { value: "zh", label: "\u4E2D\u6587" }
    ]) : "zh";
    await client.init(change, { language: initLanguage });
    outputResult({
      command: "init",
      gitFlowInit: await initializeGitFlowProject(workspaceRoot, { interactive: process.stdin.isTTY })
    });
  } else if (command === "next") outputResult(await client.next(change));
  else if (isWorkflowCommand(command)) {
    const result = await runWorkflowCommand(command, change, workspaceRoot, workflowPlatform(argv.slice(1)) ?? resolved?.platform, argv.slice(1));
    outputResult(result);
  } else throw new Error(`Unknown command: ${command}`);
}
async function runAggregateUpdate(scope, options) {
  const managed = await listManagedPlatforms(scope, options);
  const detected = (await discoverPlatforms(options)).filter((platform) => platform.scope === scope).map((platform) => platform.platform);
  const realPlatforms = [.../* @__PURE__ */ new Set([...managed, ...detected])].filter((platform) => platform !== "generic").sort();
  const targets = [...realPlatforms];
  if (targets.length === 0 || managed.includes("generic")) targets.push("generic");
  writeUpdateProgress(`Kata update \xB7 ${scope === "project" ? "\u5F53\u524D\u9879\u76EE" : "\u5168\u5C40\u5B89\u88C5"}
`);
  const reports = [];
  for (const platform of targets) {
    writeUpdateProgress(`
\u2192 \u66F4\u65B0 ${platform}
`);
    const report = await update(platform, scope, options);
    reports.push(report);
    writeUpdateProgress(formatUpdateReport(report));
  }
  const runtimeRefresh = await runRuntimeRefresh(options.root);
  writeUpdateProgress(formatRuntimeRefresh(runtimeRefresh));
  return { ...mergeInstallReports({ command: "update", mode: "auto", scope, reports }), runtimeRefresh };
}
async function runRuntimeRefresh(root) {
  const timeoutMs = runtimeRefreshTimeoutMs();
  const comet = await withTimeout(updateComet(), timeoutMs, `Comet update timed out after ${timeoutMs}ms`).then((result) => ({ success: true, previousVersion: result.previousVersion, installedVersion: result.installedVersion })).catch((error) => ({ success: false, error: error instanceof Error ? error.message : String(error) }));
  const runCodegraph = (subcommand) => {
    try {
      const output = execFileSync5("codegraph", [subcommand], {
        encoding: "utf-8",
        maxBuffer: 10 * 1024 * 1024,
        cwd: root,
        env: codeGraphExecutionEnv(),
        stdio: ["ignore", "pipe", "pipe"]
      }).trim();
      return { success: true, ...output ? { output } : {} };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  };
  return { comet, codegraphSync: runCodegraph("sync"), codegraphIndex: runCodegraph("index") };
}
function runtimeRefreshTimeoutMs() {
  const configured = Number.parseInt(process.env.KATA_RUNTIME_REFRESH_TIMEOUT_MS ?? "", 10);
  return Number.isSafeInteger(configured) && configured >= 1e3 && configured <= 12e4 ? configured : 3e4;
}
async function withTimeout(operation, timeoutMs, message) {
  let timer;
  try {
    return await Promise.race([
      operation,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
function isQuietOutput(argv) {
  return process.env.STRATA_QUIET === "1" || process.env.STRATA_QUIET === "true" || argv.includes("--quiet");
}
function isJsonOutput(argv) {
  return argv.includes("--json") || process.env.STRATA_JSON === "1" || process.env.STRATA_JSON === "true";
}
function isDefaultSilentInstallerCommand(argv) {
  const command = argv[0];
  return (command === "init" || command === "uninstall") && !isJsonOutput(argv);
}
function stripOutputModeArgs(argv) {
  return argv.filter((arg) => arg !== "--quiet" && arg !== "--json");
}
function parseRootArg(argv) {
  const index = argv.indexOf("--root");
  return index >= 0 ? argv[index + 1] : void 0;
}
function parseChangeArg(argv) {
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--change") return argv[index + 1];
    if (value === "--platform" || value === "--root" || value === "--role" || value === "--task-kind" || value === "--mode" || value === "--routing-mode" || value === "--failures" || value === "--failure-count" || value === "--isolation" || value === "--isolation-mode" || value === "--development" || value === "--development-mode" || value === "--review" || value === "--review-mode") {
      index += 1;
      continue;
    }
    if (value?.startsWith("--")) continue;
    return value;
  }
  return void 0;
}
function workflowPlatform(argv) {
  const index = argv.indexOf("--platform");
  return index >= 0 ? argv[index + 1] : void 0;
}
function statusDiagnostic(candidates = []) {
  const recommended = recommendNextTask(candidates);
  const action = recommended ? nextActionForTask(recommended.taskId, recommended.nextSkill, recommended.suggestedRole, recommended.suggestedReason) : null;
  return {
    command: "status",
    taskId: null,
    phase: "dispatch",
    success: true,
    diagnostics: {
      message: candidates.length > 0 ? "Multiple same-branch Kata tasks were discovered. Pick the recommended task or pass --change explicitly." : "No same-branch Kata task was discovered. Provide a change id with --change, or open a new task.",
      usage: "kata <status|open|design|build|verify|archive|hotfix|tweak|next> --change <id>"
    },
    candidates,
    recommended: recommended ? {
      taskId: recommended.taskId,
      nextSkill: recommended.nextSkill,
      role: recommended.suggestedRole,
      reason: recommended.suggestedReason,
      slashCommand: action?.slashCommand,
      cliCommand: action?.cliCommand
    } : null,
    nextAction: action,
    askUser: recommended ? [
      `\u53D1\u73B0 ${candidates.length} \u4E2A\u5F53\u524D\u5206\u652F\u4EFB\u52A1\uFF0C\u5EFA\u8BAE\u5904\u7406\uFF1A${recommended.taskId}`,
      `\u786E\u8BA4\u4E0B\u4E00\u6B65\uFF1A${action?.slashCommand ?? recommended.nextSkill}`
    ] : ["\u8BF7\u9009\u62E9 Kata task\uFF0C\u6216\u8F93\u5165\u8981\u5F00\u542F\u7684\u65B0 change id\u3002"]
  };
}
function isInstallerCommand(command) {
  return command === "init" || command === "update" || command === "uninstall";
}
function isWorkflowCommand(command) {
  return ["open", "design", "build", "review", "judge", "verify", "archive", "hotfix", "tweak"].includes(command);
}
function isResumableWorkflowCommand(command) {
  return ["design", "build", "review", "judge", "verify", "archive"].includes(command);
}
function shouldUseInitWizard(argv) {
  if (argv.includes("--platform") || argv.includes("--scope") || argv.includes("--home")) return false;
  if (argv.includes("--yes")) return true;
  return argv.length === 0 && process.stdin.isTTY;
}
async function runInitWizardCommand(argv, defaultRoot) {
  const args = parseInstallerArgs(argv, { requirePlatform: false, allowWizard: true });
  const root = args.options.root ?? defaultRoot ?? resolveWorkspaceRoot();
  const useAuto = args.yes || !process.stdin.isTTY;
  let platforms = await discoverPlatforms({ ...args.options, root });
  const plan = useAuto ? await (async () => {
    platforms = await discoverPlatforms({ ...args.options, root });
    return planDetectedInit(platforms, { scope: "project", language: "zh" });
  })() : await promptInitPlan(platforms);
  const cometInit = useAuto ? {
    command: "comet init",
    status: "deferred",
    path: null,
    root,
    scope: plan.scope,
    language: plan.language,
    nextCommand: `comet init ${root} --scope ${plan.scope} --language ${plan.language}`
  } : await initCometProject({
    root,
    scope: plan.scope,
    language: plan.language
  });
  const gitFlowInit = args.options.dryRun ? { status: "skipped", reason: "dry_run" } : await initializeGitFlowProject(root, { interactive: !useAuto && process.stdin.isTTY });
  const reports = [];
  const preStates = [];
  for (const platform of plan.selected) {
    preStates.push(await identifyPlatformInstallState(platform, { ...args.options, root }));
  }
  for (const platform of plan.selected) {
    reports.push(
      await install(
        platform.platform,
        plan.scope,
        optionsForWizardInstall(args.options, plan.scope, platform.root, plan.language)
      )
    );
  }
  const codegraphResult = useAuto ? { codegraph: { status: "deferred", nextCommand: "kata codegraph install --yes" } } : (() => {
    try {
      const output = execFileSync5("codegraph", ["index"], {
        encoding: "utf-8",
        cwd: root,
        env: codeGraphExecutionEnv()
      }).trim();
      return { codegraph: { status: "initialized", ...output ? { error: void 0 } : {} } };
    } catch (error) {
      return { codegraph: { status: "failed", error: error instanceof Error ? error.message : String(error) } };
    }
  })();
  const result = mergeInstallReports({
    command: "init",
    mode: useAuto ? "auto" : "interactive",
    scope: plan.scope,
    reports
  });
  return { ...result, cometInit, gitFlowInit, ...codegraphResult };
}
async function runWorkflowCommand(command, change, root, platform, argv = []) {
  const waivers = command === "build" ? await readWaiversFile(argv) : void 0;
  const inputPhase = await readWorkflowPhase(root, change);
  const boundary = boundaryForCommand(command, inputPhase);
  if (boundary) await requireUserChoiceGate({ root, taskId: change, boundary });
  if (command !== "open" && inputPhase !== null && inputPhase !== "intake") {
    await requireWorkflowReceipt(root, change, roleForCommand(command));
  }
  const explicitChange = parseChangeArg(argv.slice(1));
  let workflowProfile = requiresWorkflowProfile(command) ? await resolveWorkflowProfile(command, argv) : void 0;
  const abortController = command === "build" ? new AbortController() : void 0;
  const onProgress = command === "build" && argv.includes("--seal") ? (event) => {
    process.stderr.write(`${JSON.stringify(event)}
`);
  } : void 0;
  if (abortController) {
    const onSignal = () => {
      abortController.abort();
      process.removeListener("SIGINT", onSignal);
      process.removeListener("SIGTERM", onSignal);
    };
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
  }
  const branchPreparationOnly = workflowProfile?.isolationMode === "git_flow" && command !== "open";
  const commandToRun = branchPreparationOnly ? "open" : command;
  const result = await runCommand(commandToRun, change, root, {
    title: command === "hotfix" ? `Hotfix ${change}` : command === "tweak" ? `Tweak ${change}` : `Change ${change}`,
    acceptance: [{ id: "AC-1", statement: "Implement the change." }],
    ...platform ? { platform } : {},
    ...commandToRun === "build" ? { seal: argv.includes("--seal") } : {},
    ...command === "review" ? { approve: argv.includes("--approve") } : {},
    ...command === "review" && reviewEvidenceArg(argv) ? { reviewEvidence: reviewEvidenceArg(argv) } : {},
    ...command === "review" || command === "judge" || command === "archive" ? { confirmHostModel: boundary !== null } : {},
    ...commandToRun === "open" || commandToRun === "build" ? { allowOwnershipConflicts: argv.includes("--allow-ownership-conflicts") } : {},
    ...waivers ? { waivers } : {},
    ...(commandToRun === "open" || commandToRun === "build") && ownedPaths(argv).length ? { ownedPaths: ownedPaths(argv) } : {},
    ...workflowProfile ? { workflowProfile } : {},
    ...onProgress ? { onProgress, signal: abortController?.signal } : {}
  });
  if (explicitChange && result.taskId !== change) {
    return { command, taskId: change, phase: "intake", success: false, error: `Task ID mismatch: requested ${change} but result returned ${result.taskId}.` };
  }
  if (boundary && result.success) await consumeUserChoiceGate({ root, taskId: change, boundary });
  const nextBoundary = result.success ? result.phase === "plan" ? "implementation_gate" : result.phase === "hardVerify" && command === "verify" ? "review_gate" : result.phase === "review" && command === "review" && argv.includes("--approve") ? "judge_gate" : result.phase === "judge" && command === "judge" ? "archive_gate" : null : null;
  if (nextBoundary) await createUserChoiceGate({ root, taskId: result.taskId, boundary: nextBoundary });
  if (result.success && workflowProfile?.isolationMode === "git_flow") {
    const plan = inspectGitFlow(root, result.taskId, void 0, gitFlowBranchKindForCommand(command));
    workflowProfile = await updateGitFlowProfile(root, result.taskId, plan);
  }
  const upstream = await readUpstreamSummary(root, result.taskId).catch(() => null);
  const suggestion = workflowProfile ? null : upstream ? suggestCandidateAction(result.phase, upstream) : null;
  const gitFlowPending = workflowProfile?.gitFlow?.status === "pending_confirmation";
  const gitFlowManualCommand = workflowProfile?.gitFlow?.installation?.status !== "installed" ? workflowProfile?.gitFlow?.installation?.manualCommand : void 0;
  const phaseNextSkill = gitFlowPending ? "/kata" : nextSkillForPhase(result.phase);
  const nextAction = suggestion ? nextActionForTask(result.taskId, suggestion.nextSkill, suggestion.role, suggestion.reason) : null;
  const workflowNextAction = workflowProfile ? gitFlowPending ? {
    taskId: result.taskId,
    nextSkill: "/kata",
    slashCommand: "/kata",
    cliCommand: `kata git-flow apply --change ${result.taskId} --confirm`,
    role: "implementer",
    reason: "git_flow_confirmation_required",
    requiresUserConfirmation: true,
    ...gitFlowManualCommand ? { pauseInstruction: `Git Flow \u81EA\u52A8\u5B89\u88C5\u672A\u5B8C\u6210\uFF1B\u8BF7\u5148\u624B\u52A8\u6267\u884C\uFF1A${gitFlowManualCommand}` } : {}
  } : nextActionForTask(result.taskId, phaseNextSkill, roleForPhase2(result.phase), workflowNextReason(result.phase)) : null;
  const completion = result.success ? workflowCompletion(result.phase, workflowNextAction ?? nextAction) : null;
  const effectiveAction = workflowNextAction ?? nextAction;
  const fromRole = roleForCompletedCommand(command);
  const toRole = effectiveAction ? handoffRole(effectiveAction.role) : null;
  const handoff = result.success && fromRole && toRole && fromRole !== toRole ? await createWorkflowHandoff({ root, taskId: result.taskId, fromRole, toRole }) : null;
  const shouldAskUser = suggestion !== null || workflowNextAction?.requiresUserConfirmation === true;
  const active = result.success ? await activateHookTask({
    root,
    taskId: result.taskId,
    role: roleForPhase2(result.phase),
    ...platform ? { platform } : {},
    origin: "workflow"
  }).catch(() => null) : null;
  return {
    command: result.command,
    taskId: result.taskId,
    phase: result.phase,
    success: result.success,
    execution: {
      workspaceRoot: realpathSync(root),
      executable: process.argv[1] ?? process.execPath,
      runtimeVersion: process.version,
      inputPhase,
      outputPhase: result.phase,
      ...upstream?.currentRevisionId ? { revisionId: upstream.currentRevisionId } : {},
      handoffValidated: command === "open" ? false : true
    },
    phaseNextSkill,
    ...completion ? { completion } : {},
    ...handoff ? {
      handoff: {
        id: handoff.packet.id,
        path: `.kata/tasks/${result.taskId}/handoffs/${handoff.packet.id}.json`,
        sha256: createPacketHash(handoff.packet),
        packet: handoff.packet,
        targetPrompt: handoff.prompt
      }
    } : {},
    ...workflowProfile && workflowNextAction ? { workflowProfile, nextAction: workflowNextAction } : {},
    ...suggestion ? {
      nextSkill: suggestion.nextSkill,
      recommended: {
        taskId: result.taskId,
        nextSkill: suggestion.nextSkill,
        role: suggestion.role,
        reason: suggestion.reason,
        slashCommand: nextAction?.slashCommand,
        cliCommand: nextAction?.cliCommand
      },
      nextAction
    } : {},
    ...upstream ? { upstream } : {},
    ...shouldAskUser ? { askUser: statusActionPrompts(suggestion ?? { nextSkill: phaseNextSkill, role: roleForPhase2(result.phase), reason: workflowNextReason(result.phase) }) } : {},
    ...active ? {
      activeTask: {
        taskId: active.taskId,
        role: active.role,
        phase: active.phase,
        ...active.platform ? { platform: active.platform } : {},
        ...active.branch ? { branch: active.branch } : {},
        ...active.origin ? { origin: active.origin } : {},
        active: true
      }
    } : {},
    ...result.diagnostics ? { diagnostics: result.diagnostics } : {},
    ...result.error ? { error: result.error } : {}
  };
}
async function readWorkflowPhase(root, taskId) {
  try {
    const state = JSON.parse(await readFile24(join28(root, ".kata/tasks", taskId, "current-state.json"), "utf8"));
    return typeof state.phase === "string" ? state.phase : null;
  } catch {
    return null;
  }
}
function roleForCommand(command) {
  if (command === "review" || command === "verify") return "reviewer";
  if (command === "judge") return "judge";
  if (command === "archive") return "distiller";
  return "implementer";
}
function boundaryForCommand(command, phase) {
  if (command === "build" && phase === "plan") return "implementation_gate";
  if (command === "review" && phase === "hardVerify") return "review_gate";
  if (command === "judge" && phase === "review") return "judge_gate";
  if (command === "archive" && (phase === "judge" || phase === "distill")) return "archive_gate";
  return null;
}
async function runGateCommand(argv, root) {
  if (argv[0] !== "approve") throw new Error("Usage: kata gate approve --task <id> --boundary <implementation_gate|review_gate|judge_gate|archive_gate> --choice <continue_current|switched|delegated>");
  const task = valueAfter(argv, "--task");
  const boundary = valueAfter(argv, "--boundary");
  const choice = valueAfter(argv, "--choice");
  if (!task || !boundary || !choice) throw new Error("kata gate approve requires --task, --boundary, and --choice");
  await approveUserChoiceGate({ root, taskId: task, boundary, choice });
  return { command: "gate approve", taskId: task, boundary, choice, approved: true };
}
function valueAfter(argv, flag) {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : void 0;
}
async function requireWorkflowReceipt(root, taskId, role) {
  const handoffDirectory = join28(root, ".kata/tasks", taskId, "handoffs");
  let entries;
  try {
    entries = await readdir10(handoffDirectory);
  } catch {
    throw new Error(`Workflow mutation requires a current acknowledged handoff receipt for ${role}.`);
  }
  const ids = entries.filter((entry) => entry.startsWith("handoff-") && entry.endsWith(".receipt.json")).map((entry) => entry.slice(0, -".receipt.json".length)).sort().reverse();
  for (const id of ids) {
    try {
      await requireAcknowledgedContextPacket({ root, taskId, id, role });
      return;
    } catch {
    }
  }
  throw new Error(`Workflow mutation requires a current acknowledged handoff receipt for ${role}.`);
}
function reviewEvidenceArg(argv) {
  const index = argv.indexOf("--review-evidence");
  const value = index >= 0 ? argv[index + 1] : void 0;
  return value?.trim() || void 0;
}
function roleForCompletedCommand(command) {
  if (command === "design") return "designer";
  if (command === "build") return "implementer";
  if (command === "verify" || command === "review") return "reviewer";
  if (command === "judge") return "judge";
  if (command === "archive") return "distiller";
  return null;
}
function handoffRole(role) {
  return ["designer", "implementer", "reviewer", "judge", "distiller"].includes(role) ? role : null;
}
function workflowCompletion(phase, nextAction) {
  if (!nextAction) return null;
  const archiveNote = phase === "archive" ? "\n\u5F52\u6863\u5DF2\u5B8C\u6210\u3002\u5EFA\u8BAE\u4F7F\u7528 git \u63D0\u4EA4\u672C\u8F6E\u5DE5\u4F5C\u6D41\u6D89\u53CA\u7684\u6240\u6709\u66F4\u6539\uFF0C\u5E76\u63A8\u9001\u5230\u8FDC\u7AEF\u3002" : "";
  return {
    phase,
    nextAction,
    userMessage: [
      `\u5F53\u524D\u9636\u6BB5\uFF1A${phase}\u3002`,
      `\u4E0B\u4E00\u6B65\uFF1A${nextAction.slashCommand}`,
      `CLI \u5907\u7528\uFF1A${nextAction.cliCommand}`,
      ...nextAction.requiresUserConfirmation && nextAction.pauseInstruction ? [nextAction.pauseInstruction] : [],
      ...archiveNote ? [archiveNote] : []
    ].join("\n")
  };
}
function workflowNextReason(phase) {
  if (phase === "intake") return "design_intake_task";
  if (phase === "plan") return "choose_execution_mode";
  return "continue_workflow";
}
function ownedPaths(argv) {
  return argv.flatMap((value, index) => value === "--owned-path" && argv[index + 1] ? [argv[index + 1]] : []);
}
async function readWaiversFile(argv) {
  const index = argv.indexOf("--waivers-file");
  if (index === -1) return void 0;
  const path = argv[index + 1];
  if (!path) throw new Error("Invalid waivers file: --waivers-file requires a path.");
  let parsed;
  try {
    parsed = JSON.parse(await readFile24(path, "utf8"));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid waivers file: ${detail}`);
  }
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.waivers)) {
    throw new Error("Invalid waivers file: expected an object with a waivers array.");
  }
  const waivers = parsed.waivers;
  const errors = validateWaivers(waivers);
  if (errors.length > 0) throw new Error(`Invalid waivers file: ${errors.join("; ")}`);
  return waivers;
}
async function runGitFlowCommand(argv, root) {
  if (argv[0] !== "apply") throw new Error("Usage: kata git-flow apply --change <task-id>");
  const taskId = parseChangeArg(argv.slice(1));
  if (!taskId) throw new Error("Usage: kata git-flow apply --change <task-id>");
  const task = JSON.parse(await readFile24(join28(root, ".kata/tasks", taskId, "task.json"), "utf8"));
  if (!isWorkflowProfile(task.workflowProfile) || task.workflowProfile.isolationMode !== "git_flow") {
    throw new Error(`Task ${taskId} does not use Git Flow isolation`);
  }
  const inspected = inspectGitFlow(root, taskId, void 0, gitFlowBranchKindForProfile(task.workflowProfile));
  if (inspected.status === "pending_confirmation" && !argv.includes("--confirm")) {
    return {
      command: "git-flow apply",
      taskId,
      workflowProfile: task.workflowProfile,
      nextAction: {
        slashCommand: "/kata",
        cliCommand: `kata git-flow apply --change ${taskId} --confirm`,
        reason: "git_flow_confirmation_required",
        requiresUserConfirmation: true
      }
    };
  }
  const state = inspected.status === "pending_confirmation" ? applyGitFlowPlan(root, inspected) : inspected;
  const workflowProfile = await updateGitFlowProfile(root, taskId, state);
  return {
    command: "git-flow apply",
    taskId,
    workflowProfile,
    nextAction: state.status === "active" ? { slashCommand: `/kata-design ${taskId}`, cliCommand: `kata design --change ${taskId}` } : { cliCommand: `kata git-flow apply --change ${taskId} --confirm`, reason: inspected.reason ?? "git_flow_setup_failed" }
  };
}
function gitFlowBranchKindForCommand(command) {
  return command === "hotfix" ? "hotfix" : "feature";
}
function gitFlowBranchKindForProfile(profile) {
  return profile.gitFlow?.branch.startsWith("hotfix/") ? "hotfix" : "feature";
}
function requiresWorkflowProfile(command) {
  return command === "open" || command === "hotfix" || command === "tweak";
}
async function resolveWorkflowProfile(command, argv = []) {
  const explicit = parseWorkflowProfileArgs(argv);
  if (!explicit.isolationMode || !explicit.developmentMode || !explicit.reviewMode) {
    throw new Error(`kata ${command} requires explicit --isolation, --development, and --review choices; use /kata-${command} to collect user confirmation first.`);
  }
  return {
    ...defaultWorkflowProfile(),
    isolationMode: explicit.isolationMode,
    developmentMode: explicit.developmentMode,
    reviewMode: explicit.reviewMode
  };
}
function parseWorkflowProfileArgs(argv) {
  return {
    isolationMode: parseEnumArg(argv, ["--isolation", "--isolation-mode"], isolationModes, "isolation mode"),
    developmentMode: parseEnumArg(argv, ["--development", "--development-mode"], developmentModes, "development mode"),
    reviewMode: parseEnumArg(argv, ["--review", "--review-mode"], reviewModes, "review mode")
  };
}
function parseEnumArg(argv, flags, allowed, label) {
  const flag = flags.find((candidate) => argv.includes(candidate));
  if (!flag) return void 0;
  const value = argv[argv.indexOf(flag) + 1];
  if (!value) throw new Error(`Missing ${label} after ${flag}`);
  if (!allowed.includes(value)) {
    throw new Error(`Invalid ${label}: ${value}. Expected one of: ${allowed.join(", ")}`);
  }
  return value;
}
function roleForPhase2(phase) {
  if (phase === "intake") return "designer";
  if (phase === "plan" || phase === "implement") return "implementer";
  if (phase === "hardVerify") return "reviewer";
  if (phase === "review") return "reviewer";
  if (phase === "judge") return "judge";
  if (phase === "distill") return "distiller";
  return "dispatcher";
}
async function resolveTaskForCurrentBranch(root) {
  const active = await resolveActiveTaskForCurrentBranch(root);
  if (active) {
    return {
      taskId: active.taskId,
      source: "active",
      ...active.branch ? { branch: active.branch } : {},
      ...active.platform ? { platform: active.platform } : {},
      ...active.role ? { role: active.role } : {},
      ...active.origin ? { origin: active.origin } : {}
    };
  }
  return discoverSingleTaskForCurrentBranch(root);
}
async function resolveActiveTaskForCurrentBranch(root) {
  const active = await readActiveHookTask(root);
  if (!active) return null;
  const branch = currentGitBranch(root);
  if (active.branch && branch && active.branch !== branch) {
    throw new Error(`Active task belongs to branch ${active.branch}; current branch is ${branch}. Pass --change explicitly or activate a task on this branch.`);
  }
  return active;
}
async function discoverSingleTaskForCurrentBranch(root) {
  const branch = currentGitBranch(root);
  if (!branch) return null;
  let taskIds;
  try {
    taskIds = await readdir10(join28(root, ".kata/tasks"));
  } catch {
    return null;
  }
  const matches = [];
  for (const taskId of taskIds) {
    try {
      const task = JSON.parse(await readFile24(join28(root, ".kata/tasks", taskId, "task.json"), "utf8"));
      if (task.branch === branch && task.phase !== "archive") matches.push(task.id ?? taskId);
    } catch {
    }
  }
  if (matches.length !== 1) return null;
  return { taskId: matches[0], source: "discovered", branch };
}
async function runLocalStatusCommand(change, resolved, root = resolveWorkspaceRoot()) {
  const terminal = await resolveTerminalTask(root, change);
  if (terminal.taskId !== change) {
    const targetStatus = await runLocalStatusCommand(terminal.taskId, resolved, root);
    return {
      ...targetStatus,
      command: "status",
      redirectedFrom: change,
      relationRedirects: terminal.redirects,
      askUser: [
        `\u4EFB\u52A1 ${change} \u5DF2\u901A\u8FC7 ${terminal.redirects[0]?.type ?? "relation"} \u6307\u5411 ${terminal.taskId}\uFF1B\u8BF7\u7EE7\u7EED\u5904\u7406 ${terminal.taskId}\u3002`
      ]
    };
  }
  if (await requiresRecovery(change, { root }).catch(() => false)) await recover(change, { root });
  const state = JSON.parse(await readFile24(join28(root, ".kata/tasks", change, "current-state.json"), "utf8"));
  const autoActive = resolved?.source === "discovered" ? await activateHookTask({
    root,
    taskId: change,
    role: roleForPhase2(state.phase),
    ...resolved.platform ? { platform: resolved.platform } : {},
    origin: "discovered"
  }).catch(() => null) : null;
  const effectiveResolved = autoActive ? {
    taskId: autoActive.taskId,
    source: "active",
    ...autoActive.branch ? { branch: autoActive.branch } : {},
    ...autoActive.platform ? { platform: autoActive.platform } : {},
    role: autoActive.role,
    ...autoActive.origin ? { origin: autoActive.origin } : {}
  } : resolved;
  const taskContext = await readTaskContext(root, change);
  const upstream = await readUpstreamSummary(root, change);
  const suggestion = suggestCandidateAction(state.phase, upstream);
  const phaseNextSkill = nextSkillForPhase(state.phase);
  const nextAction = nextActionForTask(change, suggestion.nextSkill, suggestion.role, suggestion.reason);
  const hasArtifactOverride = suggestion.nextSkill !== phaseNextSkill || suggestion.reason.startsWith("repair_");
  const shouldAskUser = hasArtifactOverride || nextAction.requiresUserConfirmation;
  return {
    command: "status",
    taskId: change,
    phase: state.phase,
    nextSkill: suggestion.nextSkill,
    phaseNextSkill,
    recommended: {
      taskId: change,
      nextSkill: suggestion.nextSkill,
      role: suggestion.role,
      reason: suggestion.reason,
      slashCommand: nextAction.slashCommand,
      cliCommand: nextAction.cliCommand
    },
    nextAction,
    upstream,
    ...shouldAskUser ? {
      ...hasArtifactOverride ? { artifactOverride: true } : {},
      askUser: statusActionPrompts(suggestion)
    } : {},
    ...effectiveResolved?.source === "active" && effectiveResolved.taskId === change ? { active: true } : {},
    ...effectiveResolved?.source === "discovered" && effectiveResolved.taskId === change ? { discovered: true } : {},
    ...effectiveResolved?.source === "active" && effectiveResolved.origin === "discovered" ? { discovered: true } : {},
    ...autoActive ? { discovered: true, autoActivated: true } : {},
    ...effectiveResolved?.branch ? { branch: effectiveResolved.branch } : {},
    ...effectiveResolved?.platform ? { platform: effectiveResolved.platform } : {},
    ...effectiveResolved?.role ? { activeRole: effectiveResolved.role } : {},
    ...state.updatedAt ? { updatedAt: state.updatedAt } : {},
    ...state.actor ? { actor: state.actor } : {},
    ...state.activeSession ? { activeSession: state.activeSession } : {},
    task: taskContext.task,
    state,
    requiredReads: taskContext.requiredReads,
    context: taskContext.context
  };
}
async function runDispatchStatusCommand(root) {
  const candidates = await listTaskCandidates(root);
  if (candidates.length === 1) {
    const active = await activateHookTask({
      root,
      taskId: candidates[0].taskId,
      role: candidates[0].suggestedRole,
      origin: "discovered"
    }).catch(() => null);
    return {
      ...await runLocalStatusCommand(candidates[0].taskId, active ? {
        taskId: active.taskId,
        source: "active",
        ...active.branch ? { branch: active.branch } : {},
        ...active.platform ? { platform: active.platform } : {},
        role: active.role,
        ...active.origin ? { origin: active.origin } : {}
      } : { taskId: candidates[0].taskId, source: "discovered", ...candidates[0].branch ? { branch: candidates[0].branch } : {} }, root),
      autoDispatched: true,
      ...active ? { autoActivated: true } : {}
    };
  }
  return statusDiagnostic(candidates);
}
async function readTaskContext(root, change) {
  const taskRaw = await readFile24(join28(root, ".kata/tasks", change, "task.json"), "utf8");
  const task = JSON.parse(taskRaw);
  let context;
  try {
    context = await buildContextManifest({ root, taskId: change, sourceRefs: [] });
  } catch {
    context = { taskId: change, sourceRefs: [], authoritativeWiki: [], excludedWiki: [], warnings: [] };
  }
  return {
    task: {
      title: task.title,
      acceptance: task.acceptance
    },
    requiredReads: [
      "AGENTS.md",
      ".kata/skills-index.md",
      ".llmwiki/SCHEMA.md",
      ".llmwiki/index.md",
      ".llmwiki/log.md",
      `.kata/tasks/${change}/task.json`,
      `.kata/tasks/${change}/current-state.json`
    ],
    context: {
      authoritativeWikiCount: context.authoritativeWiki.length,
      excludedWikiCount: context.excludedWiki.length,
      sourceRefs: context.sourceRefs,
      warnings: context.warnings
    }
  };
}
async function runWikiCommand(argv) {
  const [subcommand, ...rest] = argv;
  if (!subcommand || subcommand === "--help" || subcommand === "-h") {
    return {
      command: "wiki help",
      commands: ["init --from <path>", "orient", "ingest --from <path>", "query --q <question>", "lint", "verify", "task --kind enrich", "register", "candidate", "closure --task <task-id> --decision <captured|not_applicable|deferred> --reason <text>", "audit", "lifecycle", "refresh --task <task-id>", "relevance --task <task-id>", "promote <wiki-id> --by <actor> --role <role>", "reject <wiki-id> --by <actor> --role <role> --reason <reason>", "retire <wiki-id> --by <actor> --role <role> --reason <reason>"],
      aliases: { propose: "task --kind enrich" },
      examples: ["kata wiki task --kind enrich --from docs", "kata wiki propose --task <task-id> --from docs", "kata wiki candidate"]
    };
  }
  const args = subcommand === "promote" || subcommand === "reject" || subcommand === "retire" ? parseWikiArgs(rest.slice(1)) : parseWikiArgs(rest);
  if (subcommand === "init") {
    if (!args.from) throw new Error("Usage: kata wiki init --from <path> [--wiki <path>] [--root <path>]");
    const result = await initLlmWiki({ root: args.root, wikiPath: args.wikiPath, from: args.from });
    return {
      command: "wiki init",
      wikiPath: result.wikiPath,
      importedCount: result.importedSources.length,
      importedSources: result.importedSources
    };
  }
  if (subcommand === "orient") {
    const result = await orientLlmWiki({ root: args.root, wikiPath: args.wikiPath });
    return {
      command: "wiki orient",
      wikiPath: result.wikiPath,
      schemaBytes: result.schema.length,
      indexBytes: result.index.length,
      recentLog: result.recentLog
    };
  }
  if (subcommand === "ingest") {
    if (!args.from) throw new Error("Usage: kata wiki ingest --from <path> [--wiki <path>] [--root <path>]");
    const result = await ingestLlmWiki({ root: args.root, wikiPath: args.wikiPath, from: args.from });
    return {
      command: "wiki ingest",
      wikiPath: result.wikiPath,
      importedCount: result.importedSources.length,
      importedSources: result.importedSources,
      pagesWritten: result.pagesWritten,
      governedRecords: result.governedRecords
    };
  }
  if (subcommand === "query") {
    if (!args.query) throw new Error("Usage: kata wiki query --q <question> [--file] [--wiki <path>] [--root <path>]");
    const result = await queryLlmWiki({ root: args.root, wikiPath: args.wikiPath, query: args.query, file: args.file });
    return {
      command: "wiki query",
      wikiPath: result.wikiPath,
      answer: result.answer,
      citations: result.citations,
      ...result.filedPath ? { filedPath: result.filedPath } : {}
    };
  }
  if (subcommand === "lint") {
    const result = await lintLlmWiki({ root: args.root, wikiPath: args.wikiPath });
    return {
      command: "wiki lint",
      wikiPath: result.wikiPath,
      ok: result.ok,
      issues: result.issues
    };
  }
  if (subcommand === "task") {
    if (args.kind !== "bootstrap" && args.kind !== "enrich" && args.kind !== "distill") {
      throw new Error("Usage: kata wiki task --kind <bootstrap|enrich|distill> [--from <path>] [--wiki <path>] [--root <path>]");
    }
    return { ...await buildLlmWikiTask({ root: args.root, wikiPath: args.wikiPath, kind: args.kind, from: args.from }) };
  }
  if (subcommand === "propose") {
    const packet = await buildLlmWikiTask({ root: args.root, wikiPath: args.wikiPath, kind: "enrich", from: args.from });
    return { ...packet, ...args.task ? { sourceTask: args.task } : {}, alias: "wiki propose" };
  }
  if (subcommand === "candidate") {
    const root = args.root ?? resolveWorkspaceRoot();
    const candidates = (await readWikiRecords(root)).filter((record) => record.status === "candidate");
    return { command: "wiki candidate", candidates };
  }
  if (subcommand === "closure") {
    if (!args.task || !args.decision || !args.reason || !["captured", "not_applicable", "deferred"].includes(args.decision)) {
      throw new Error("Usage: kata wiki closure --task <task-id> --decision <captured|not_applicable|deferred> --reason <text> [--candidate <wiki-id>]");
    }
    const root = args.root ?? resolveWorkspaceRoot();
    const closure = await writeWikiClosure(root, args.task, { decision: args.decision, reason: args.reason, candidateIds: args.candidates });
    const evaluation = await evaluateWikiClosure(root, args.task);
    const lint = closure.decision === "captured" ? await lintLlmWiki({ root, wikiPath: args.wikiPath }) : null;
    const sources = closure.decision === "captured" ? await verifySources(root) : null;
    return { command: "wiki closure", closure, evaluation, ...lint ? { lint } : {}, ...sources ? { sources } : {} };
  }
  if (subcommand === "audit") return { command: "wiki audit", ...await auditWiki(args.root ?? resolveWorkspaceRoot()) };
  if (subcommand === "lifecycle") return { command: "wiki lifecycle", ...await auditWiki(args.root ?? resolveWorkspaceRoot()) };
  if (subcommand === "refresh") {
    if (!args.task) throw new Error("Usage: kata wiki refresh --task <task-id> [--root <path>]");
    return { command: "wiki refresh", ...await createRefreshPacket(args.root ?? resolveWorkspaceRoot(), args.task) };
  }
  if (subcommand === "relevance") {
    if (!args.task) throw new Error("Usage: kata wiki relevance --task <task-id> [--root <path>]");
    return { command: "wiki relevance", taskId: args.task, records: await relevantWiki(args.root ?? resolveWorkspaceRoot(), args.task) };
  }
  if (subcommand === "verify") {
    const root = args.root ?? resolveWorkspaceRoot();
    const result = await verifySources(root);
    return {
      command: "wiki verify",
      checked: result.checked,
      intact: result.intact,
      stale: result.stale,
      missing: result.missing
    };
  }
  if (subcommand === "register") {
    const result = await registerWikiPages({ root: args.root, wikiPath: args.wikiPath });
    return result;
  }
  if (subcommand === "rebuild") {
    const confirmed = args.force ?? await confirmDestructive(
      "This will remove all existing wiki pages and governed records, then regenerate the enrich task-packet.",
      ["Concepts, entities, comparisons, and queries will be deleted.", "Governed candidate records in .kata/wiki/ will be deleted."]
    );
    if (!confirmed) {
      return { command: "wiki rebuild", aborted: true };
    }
    const result = await rebuildLlmWiki({ root: args.root, wikiPath: args.wikiPath });
    return result;
  }
  if (subcommand === "promote") {
    const id = rest[0];
    if (!id || id.startsWith("--") || !args.by || !args.role) {
      throw new Error("Usage: kata wiki promote <wiki-id> --by <actor> --role <role> [--root <path>]");
    }
    const approvedAt = (/* @__PURE__ */ new Date()).toISOString();
    const record = await promote(args.root ?? resolveWorkspaceRoot(), id, { approvedBy: args.by, role: args.role, approvedAt });
    return {
      command: "wiki promote",
      id: record.id,
      status: record.status,
      approvedBy: args.by,
      role: args.role,
      approvedAt
    };
  }
  if (subcommand === "reject") {
    const id = rest[0];
    if (!id || id.startsWith("--") || !args.by || !args.role || !args.reason) {
      throw new Error("Usage: kata wiki reject <wiki-id> --by <actor> --role <role> --reason <reason> [--root <path>]");
    }
    const rejectedAt = (/* @__PURE__ */ new Date()).toISOString();
    const record = await rejectCandidate(args.root ?? resolveWorkspaceRoot(), id, {
      rejectedBy: args.by,
      role: args.role,
      rejectedAt,
      reason: args.reason
    });
    return {
      command: "wiki reject",
      id: record.id,
      status: record.status,
      rejectedBy: args.by,
      role: args.role,
      rejectedAt,
      reason: args.reason
    };
  }
  if (subcommand === "retire") {
    const id = rest[0];
    if (!id || id.startsWith("--") || !args.by || !args.role || !args.reason) {
      throw new Error("Usage: kata wiki retire <wiki-id> --by <actor> --role <role> --reason <reason> [--root <path>]");
    }
    const rejectedAt = (/* @__PURE__ */ new Date()).toISOString();
    const record = await retireWikiRecord(args.root ?? resolveWorkspaceRoot(), id, {
      rejectedBy: args.by,
      role: args.role,
      rejectedAt,
      reason: args.reason
    });
    return {
      command: "wiki retire",
      id: record.id,
      status: record.status,
      rejectedBy: args.by,
      role: args.role,
      rejectedAt,
      reason: record.rejectionEvent?.reason ?? args.reason
    };
  }
  throw new Error(`Unknown wiki command: ${subcommand ?? ""}`);
}
async function runTasksCommand(argv) {
  const [subcommand, ...rest] = argv;
  const args = parseTasksArgs(rest);
  const root = args.root ?? resolveWorkspaceRoot();
  if (subcommand === "relate") {
    if (!args.from || !args.to || !args.type) {
      throw new Error("Usage: kata tasks relate --from <task> --to <task> --type <superseded_by|covered_by|duplicate_of|merged_into|parent_of|spawned_from|related_to> [--reason <text>] [--root <path>]");
    }
    const record = await addTaskRelation({
      root,
      fromTaskId: args.from,
      toTaskId: args.to,
      type: parseTaskRelationType(args.type),
      ...args.reason ? { reason: args.reason } : {},
      createdBy: "kata-cli"
    });
    const terminal = await resolveTerminalTask(root, args.from);
    return {
      command: "tasks relate",
      fromTaskId: args.from,
      toTaskId: args.to,
      type: args.type,
      relationPath: `.kata/tasks/${args.from}/task-relations.json`,
      relations: record.relations,
      ...terminal.taskId !== args.from ? { redirectsTo: terminal.taskId, relationRedirects: terminal.redirects } : {},
      nextAction: {
        slashCommand: `/kata ${terminal.taskId}`,
        cliCommand: `kata status --change ${terminal.taskId}`
      }
    };
  }
  if (subcommand === "relations" || subcommand === "show") {
    if (!args.task && !args.from) throw new Error("Usage: kata tasks relations --task <task> [--root <path>]");
    const taskId = args.task ?? args.from;
    const record = await readTaskRelations(root, taskId);
    const terminal = await resolveTerminalTask(root, taskId);
    return {
      command: "tasks relations",
      taskId,
      relations: record.relations,
      ...terminal.taskId !== taskId ? { redirectsTo: terminal.taskId, relationRedirects: terminal.redirects } : {}
    };
  }
  throw new Error(`Unknown tasks command: ${subcommand ?? ""}`);
}
async function runRelationsCommand(argv) {
  const [subcommand, ...rest] = argv;
  const args = parseRelationsArgs(rest);
  const root = args.root ?? resolveWorkspaceRoot();
  if (subcommand === "add" || subcommand === "relate") {
    if (!args.from || !args.to || !args.type) {
      throw new Error("Usage: kata relations add --from <task:id|change:id> --to <task:id|change:id> --type <relation> [--reason <text>] [--root <path>]");
    }
    const from = parseRelationEndpoint(args.from);
    const to = parseRelationEndpoint(args.to);
    const graph = await addKataRelation({
      root,
      from,
      to,
      type: parseTaskRelationType(args.type),
      ...args.reason ? { reason: args.reason } : {},
      createdBy: "kata-cli"
    });
    return {
      command: "relations add",
      from,
      to,
      type: args.type,
      graphPath: ".kata/relations.json",
      relation: graph.relations.at(-1) ?? null
    };
  }
  if (subcommand === "show" || subcommand === "list") {
    if (!args.id) throw new Error("Usage: kata relations show --id <task:id|change:id> [--root <path>]");
    const endpoint = parseRelationEndpoint(args.id);
    return {
      command: "relations show",
      ...await findKataRelations(root, endpoint)
    };
  }
  throw new Error(`Unknown relations command: ${subcommand ?? ""}`);
}
async function runHandoffCommand(argv) {
  const [subcommand, ...rest] = argv;
  const args = parseHandoffArgs(rest);
  const root = args.root ?? (args.task ? resolveWorkspaceRootForTask(args.task) : resolveWorkspaceRoot());
  if (!args.task) throw new Error("Usage: kata handoff <create|show|verify|acknowledge> --task <id>");
  if (subcommand === "create") {
    if (!args.from || !args.to) throw new Error("Usage: kata handoff create --task <id> --from <role> --to <role>");
    const packet = await createContextPacket({ root, taskId: args.task, fromRole: args.from, toRole: args.to, ...args.platform ? { platform: args.platform } : {} });
    return { command: "handoff create", taskId: args.task, id: packet.id, path: `.kata/tasks/${args.task}/handoffs/${packet.id}.json`, sha256: createPacketHash(packet), packet };
  }
  if (!args.id) throw new Error("Usage: kata handoff <show|verify|acknowledge> --task <id> --id <handoff-id>");
  if (subcommand === "show") return { command: "handoff show", packet: await readContextPacket(root, args.task, args.id) };
  if (subcommand === "verify") return { command: "handoff verify", ...await verifyContextPacket({ root, taskId: args.task, id: args.id }) };
  if (subcommand === "acknowledge") {
    if (!args.platform || !args.role) throw new Error("Usage: kata handoff acknowledge --task <id> --id <handoff-id> --platform <name> --role <role>");
    const receipt = await acknowledgeContextPacket({ root, taskId: args.task, id: args.id, platform: args.platform, role: args.role });
    const active = await activateHookTask({
      root,
      taskId: args.task,
      role: args.role,
      platform: args.platform,
      origin: "handoff"
    }).catch((error) => {
      if (error instanceof Error && error.message.includes("does not match current phase")) return null;
      throw error;
    });
    return {
      command: "handoff acknowledge",
      receipt,
      ...active ? { activeTask: {
        taskId: active.taskId,
        role: active.role,
        phase: active.phase,
        ...active.platform ? { platform: active.platform } : {},
        ...active.branch ? { branch: active.branch } : {},
        ...active.origin ? { origin: active.origin } : {},
        active: true
      } } : {}
    };
  }
  throw new Error(`Unknown handoff command: ${subcommand ?? ""}`);
}
function createPacketHash(packet) {
  return createHash7("sha256").update(JSON.stringify(packet)).digest("hex");
}
async function runCollectCommand(argv) {
  const args = parseDelegationArgs(argv);
  const root = args.root ?? resolveWorkspaceRoot();
  const candidates = (await listTaskCandidates(root)).filter((task) => ["plan", "implement", "hardVerify", "review", "judge", "distill"].includes(task.phase));
  const selected = args.change ? candidates.find((task) => task.taskId === args.change) ?? await readTaskCandidate(root, args.change) : void 0;
  const recommended = selected ?? recommendNextTask(candidates);
  const next = recommended ? recommended.nextSkill : "/kata";
  const action = recommended ? nextActionForTask(recommended.taskId, next, recommended.suggestedRole, recommended.suggestedReason) : null;
  return {
    command: "collect",
    mode: "interactive",
    selectedTask: selected ?? null,
    candidates,
    recommended: {
      taskId: recommended?.taskId ?? null,
      nextSkill: next,
      role: recommended?.suggestedRole ?? null,
      reason: recommended?.suggestedReason ?? null,
      upstream: recommended?.upstream ?? null,
      slashCommand: action?.slashCommand ?? null,
      cliCommand: action?.cliCommand ?? null
    },
    nextAction: action,
    askUser: [
      selected ? `\u786E\u8BA4\u56DE\u6536\u4EFB\u52A1\uFF1A${selected.taskId}` : recommended ? `\u5EFA\u8BAE\u56DE\u6536\u4EFB\u52A1\uFF1A${recommended.taskId}` : "\u8BF7\u9009\u62E9\u8981\u56DE\u6536\u7684 Kata task\uFF0C\u6216\u8F93\u5165 task id\u3002",
      `\u786E\u8BA4\u4E0B\u4E00\u6B65\uFF1A${action?.slashCommand ?? next}`,
      recommended?.upstream?.blockingFindings ? "\u68C0\u6D4B\u5230\u4E0A\u6E38 blocking review findings\uFF1B\u5EFA\u8BAE\u4F5C\u4E3A implementer repair\u3002" : "\u5982\u679C\u6765\u81EA\u5176\u4ED6\u5E73\u53F0\uFF0C\u8BF7\u786E\u8BA4\u8BE5\u5E73\u53F0\u5DF2\u7ECF\u5B8C\u6210 handoff acknowledge \u5E76\u5199\u5165 evidence\u3002"
    ]
  };
}
function parseDelegationArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[index + 1];
    if (key === "--change" || key === "--task") {
      if (value === void 0) throw new Error(`${key} requires a value`);
      args.change = value;
      index += 1;
      continue;
    }
    if (key === "--to" || key === "--platform") {
      if (value === void 0) throw new Error(`${key} requires a value`);
      args.to = value;
      index += 1;
      continue;
    }
    if (key === "--role") {
      if (value === void 0) throw new Error(`${key} requires a value`);
      args.role = value;
      index += 1;
      continue;
    }
    if (key === "--from") {
      if (value === void 0) throw new Error(`${key} requires a value`);
      args.from = value;
      index += 1;
      continue;
    }
    if (key === "--root") {
      if (value === void 0) throw new Error(`${key} requires a value`);
      args.root = value;
      index += 1;
      continue;
    }
    if (key === "--create") {
      args.create = true;
      continue;
    }
    if (key?.startsWith("--")) throw new Error(`Unknown delegation option: ${key}`);
    if (!args.change) args.change = key;
  }
  return args;
}
async function listTaskCandidates(root) {
  const tasksRoot = join28(root, ".kata/tasks");
  let entries;
  try {
    entries = await readdir10(tasksRoot);
  } catch {
    return [];
  }
  const branch = currentGitBranch(root) ?? void 0;
  const candidates = [];
  for (const entry of entries.sort()) {
    const candidate = await readTaskCandidate(root, entry).catch(() => null);
    if (!candidate) continue;
    if (branch && candidate.branch && candidate.branch !== branch) continue;
    candidates.push(candidate);
  }
  return candidates.sort((a, b) => b.priority - a.priority || a.taskId.localeCompare(b.taskId));
}
async function readTaskCandidate(root, taskId) {
  const task = JSON.parse(await readFile24(join28(root, ".kata/tasks", taskId, "task.json"), "utf8"));
  const terminal = await resolveTerminalTask(root, taskId);
  if (terminal.taskId !== taskId) {
    throw new Error(`Task ${taskId} is redirected to ${terminal.taskId}`);
  }
  const state = JSON.parse(await readFile24(join28(root, ".kata/tasks", taskId, "current-state.json"), "utf8"));
  const phase = state.phase ?? "intake";
  const upstream = await readUpstreamSummary(root, taskId);
  const suggestion = suggestCandidateAction(phase, upstream);
  return {
    taskId,
    title: task.title ?? taskId,
    phase,
    nextSkill: suggestion.nextSkill,
    suggestedRole: suggestion.role,
    suggestedReason: suggestion.reason,
    priority: suggestion.priority,
    upstream,
    ...task.branch ? { branch: task.branch } : {}
  };
}
function recommendNextTask(candidates) {
  return candidates.find((task) => task.phase !== "archive") ?? candidates[0];
}
function parseHandoffArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[index + 1];
    const target = key === "--task" ? "task" : key === "--id" ? "id" : key === "--from" ? "from" : key === "--to" ? "to" : key === "--role" ? "role" : key === "--platform" ? "platform" : key === "--root" ? "root" : void 0;
    if (!target || value === void 0) throw new Error(`Unknown handoff option: ${key}`);
    args[target] = value;
    index += 1;
  }
  return args;
}
async function runOrientCommand(argv) {
  const args = parseOrientArgs(argv);
  const root = args.root ?? resolveWorkspaceRoot();
  const resolved = args.change ? null : await resolveTaskForCurrentBranch(root);
  let change = args.change ?? resolved?.taskId;
  if (!change) {
    throw new Error("Usage: kata orient [--change <id>] [--root <path>] [--role <role>] [--platform <name>] [--task-kind <kind>] [--mode <mode>] [--failures <n>]");
  }
  const terminal = await resolveTerminalTask(root, change);
  const relationRedirects = terminal.taskId !== change ? terminal.redirects : [];
  change = terminal.taskId;
  const role = args.role ?? "implementer";
  const handoff = await createHandoff(root, change, role);
  const contextPacket = await createContextPacket({ root, taskId: change, fromRole: role, toRole: role, ...args.platform ? { platform: args.platform } : {} });
  const taskContext = await readTaskContext(root, change);
  const state = JSON.parse(await readFile24(join28(root, ".kata/tasks", change, "current-state.json"), "utf8"));
  const phase = typeof state.phase === "string" ? state.phase : handoff.fromPhase;
  const upstream = await readUpstreamSummary(root, change);
  const suggestion = suggestCandidateAction(phase, upstream);
  const phaseNextSkill = nextSkillForPhase(phase);
  const nextAction = nextActionForTask(change, suggestion.nextSkill, suggestion.role, suggestion.reason);
  const hasArtifactOverride = suggestion.nextSkill !== phaseNextSkill || suggestion.reason.startsWith("repair_");
  const shouldAskUser = hasArtifactOverride || nextAction.requiresUserConfirmation;
  return {
    command: "orient",
    taskId: change,
    ...relationRedirects.length > 0 ? { redirectedFrom: relationRedirects[0]?.fromTaskId, relationRedirects } : {},
    phase: handoff.fromPhase,
    role,
    ...args.platform ? { platform: args.platform } : {},
    ...resolved?.source === "active" && resolved.taskId === change ? { active: true } : {},
    ...resolved?.source === "discovered" && resolved.taskId === change ? { discovered: true } : {},
    ...resolved?.source === "active" && resolved.origin === "discovered" ? { discovered: true } : {},
    ...resolved?.branch ? { branch: resolved.branch } : {},
    ...resolved?.origin ? { origin: resolved.origin } : {},
    ...args.taskKind ? { taskKind: args.taskKind } : {},
    nextSkill: suggestion.nextSkill,
    phaseNextSkill,
    recommended: {
      taskId: change,
      nextSkill: suggestion.nextSkill,
      role: suggestion.role,
      reason: suggestion.reason,
      slashCommand: nextAction.slashCommand,
      cliCommand: nextAction.cliCommand
    },
    nextAction,
    upstream,
    ...shouldAskUser ? {
      ...hasArtifactOverride ? { artifactOverride: true } : {},
      askUser: statusActionPrompts(suggestion)
    } : {},
    task: taskContext.task,
    state,
    requiredReads: taskContext.requiredReads,
    context: taskContext.context,
    guardInstructions: handoff.guardInstructions,
    handoff: { id: contextPacket.id, path: `.kata/tasks/${change}/handoffs/${contextPacket.id}.json`, sha256: createPacketHash(contextPacket), verificationCommand: `kata handoff verify --task ${change} --id ${contextPacket.id}` },
    legacyHandoff: handoff,
    reminders: [
      "Wiki reduces project-context mistakes; CI, tests, Reviewer, and Judge prevent code-correctness mistakes.",
      "Use the suggested /kata-* skill after reading required project and Wiki files."
    ]
  };
}
async function runHooksCommand(argv) {
  const [subcommand, ...rest] = argv;
  const args = parseHooksArgs(rest);
  const root = args.root ?? resolveWorkspaceRoot();
  if (subcommand === "activate") {
    if (!args.change) throw new Error("Usage: kata hooks activate --change <id> [--role <role>] [--platform <name>] [--root <path>]");
    const active = await activateHookTask({
      root,
      taskId: args.change,
      role: args.role ?? "implementer",
      ...args.platform ? { platform: args.platform } : {}
    });
    return {
      command: "hooks activate",
      taskId: active.taskId,
      role: active.role,
      phase: active.phase,
      ...active.platform ? { platform: active.platform } : {},
      ...active.branch ? { branch: active.branch } : {},
      ...active.origin ? { origin: active.origin } : {},
      activatedAt: active.activatedAt,
      active: true
    };
  }
  if (subcommand === "deactivate") {
    await deactivateHookTask(root);
    return { command: "hooks deactivate", active: false };
  }
  if (subcommand === "status") {
    const active = await readActiveHookTask(root);
    return active ? {
      command: "hooks status",
      active: true,
      taskId: active.taskId,
      role: active.role,
      phase: active.phase,
      ...active.platform ? { platform: active.platform } : {},
      ...active.branch ? { branch: active.branch } : {},
      ...active.origin ? { origin: active.origin } : {},
      activatedAt: active.activatedAt
    } : { command: "hooks status", active: false };
  }
  throw new Error(`Unknown hooks command: ${subcommand ?? ""}. Usage: kata hooks <activate|deactivate|status>`);
}
async function runDoctorCommand(argv) {
  const hasExplicitPlatform = argv.includes("--platform");
  const args = parseInstallerArgs(argv, { requirePlatform: false });
  if (hasExplicitPlatform) return doctor(args.platform, args.scope, args.options);
  const discovered = await discoverPlatforms(args.options);
  const scoped = discovered.filter((platform) => platform.scope === args.scope);
  const realPlatforms = scoped.filter((platform) => platform.platform !== "generic");
  const targets = realPlatforms.length > 0 ? realPlatforms : scoped.filter((platform) => platform.platform === "generic");
  const reports = [];
  for (const target of targets) {
    reports.push(await doctor(target.platform, target.scope, { ...args.options, ...target.scope === "project" ? { root: target.root } : { home: target.root } }));
  }
  return {
    command: "doctor",
    mode: "aggregate",
    scope: args.scope,
    ok: reports.every((report) => report.ok),
    reports,
    summary: aggregateDoctorSummary(reports)
  };
}
function aggregateDoctorSummary(reports) {
  return reports.reduce(
    (summary, report) => ({
      ok: summary.ok + report.summary.ok,
      missing: summary.missing + report.summary.missing,
      conflicts: summary.conflicts + report.summary.conflicts,
      skipped: summary.skipped + report.summary.skipped
    }),
    { ok: 0, missing: 0, conflicts: 0, skipped: 0 }
  );
}
function parseOrientArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];
    if (arg === "--change" && value !== void 0) {
      args.change = value;
      index += 1;
    } else if (arg === "--root" && value !== void 0) {
      args.root = value;
      index += 1;
    } else if (arg === "--role" && value !== void 0) {
      args.role = value;
      index += 1;
    } else if (arg === "--platform" && value !== void 0) {
      args.platform = value;
      index += 1;
    } else if (arg === "--task-kind" && value !== void 0) {
      args.taskKind = value;
      index += 1;
    } else if ((arg === "--mode" || arg === "--routing-mode") && value !== void 0) {
      args.routingMode = value;
      index += 1;
    } else if ((arg === "--failures" || arg === "--failure-count") && value !== void 0) {
      const parsed = Number.parseInt(value, 10);
      if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`Invalid failure count: ${value}`);
      args.failureCount = parsed;
      index += 1;
    } else {
      throw new Error(`Unknown orient option: ${arg}`);
    }
  }
  return args;
}
function parseTasksArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];
    if (arg === "--from" && value !== void 0) {
      args.from = value;
      index += 1;
    } else if (arg === "--to" && value !== void 0) {
      args.to = value;
      index += 1;
    } else if ((arg === "--task" || arg === "--change") && value !== void 0) {
      args.task = value;
      index += 1;
    } else if (arg === "--type" && value !== void 0) {
      args.type = value;
      index += 1;
    } else if (arg === "--reason" && value !== void 0) {
      args.reason = value;
      index += 1;
    } else if (arg === "--root" && value !== void 0) {
      args.root = value;
      index += 1;
    } else if (arg?.startsWith("--")) {
      throw new Error(`Unknown tasks option: ${arg}`);
    } else if (!args.task) {
      args.task = arg;
    } else {
      throw new Error(`Unexpected tasks argument: ${arg}`);
    }
  }
  return args;
}
function parseRelationsArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];
    if (arg === "--from" && value !== void 0) {
      args.from = value;
      index += 1;
    } else if (arg === "--to" && value !== void 0) {
      args.to = value;
      index += 1;
    } else if ((arg === "--id" || arg === "--endpoint") && value !== void 0) {
      args.id = value;
      index += 1;
    } else if (arg === "--type" && value !== void 0) {
      args.type = value;
      index += 1;
    } else if (arg === "--reason" && value !== void 0) {
      args.reason = value;
      index += 1;
    } else if (arg === "--root" && value !== void 0) {
      args.root = value;
      index += 1;
    } else {
      throw new Error(`Unknown relations option: ${arg}`);
    }
  }
  return args;
}
function parseRelationEndpoint(value) {
  const separator = value.indexOf(":");
  if (separator === -1) {
    return { type: "task", id: value };
  }
  const type = value.slice(0, separator);
  const id = value.slice(separator + 1);
  if ((type === "task" || type === "change") && id.length > 0) return { type, id };
  throw new Error(`Invalid relation endpoint: ${value}`);
}
function parseTaskRelationType(value) {
  const allowed = [
    "superseded_by",
    "covered_by",
    "duplicate_of",
    "merged_into",
    "parent_of",
    "spawned_from",
    "related_to",
    "contains",
    "implements",
    "repairs",
    "depends_on",
    "blocked_by"
  ];
  if (allowed.includes(value)) return value;
  throw new Error(`Invalid task relation type: ${value}`);
}
function parseHooksArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];
    if (arg === "--change" && value !== void 0) {
      args.change = value;
      index += 1;
    } else if (arg === "--root" && value !== void 0) {
      args.root = value;
      index += 1;
    } else if (arg === "--role" && value !== void 0) {
      args.role = value;
      index += 1;
    } else if (arg === "--platform" && value !== void 0) {
      args.platform = value;
      index += 1;
    } else {
      throw new Error(`Unknown hooks option: ${arg}`);
    }
  }
  return args;
}
function parseWikiArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];
    if (arg === "--from" && value !== void 0) {
      args.from = value;
      index += 1;
    } else if (arg === "--root" && value !== void 0) {
      args.root = value;
      index += 1;
    } else if (arg === "--wiki" && value !== void 0) {
      args.wikiPath = value;
      index += 1;
    } else if ((arg === "--q" || arg === "--query") && value !== void 0) {
      args.query = value;
      index += 1;
    } else if (arg === "--file") {
      args.file = true;
    } else if (arg === "--by" && value !== void 0) {
      args.by = value;
      index += 1;
    } else if (arg === "--role" && value !== void 0) {
      args.role = value;
      index += 1;
    } else if (arg === "--reason" && value !== void 0) {
      args.reason = value;
      index += 1;
    } else if (arg === "--kind" && value !== void 0) {
      args.kind = value;
      index += 1;
    } else if (arg === "--task" && value !== void 0) {
      args.task = value;
      index += 1;
    } else if (arg === "--decision" && value !== void 0) {
      args.decision = value;
      index += 1;
    } else if (arg === "--candidate" && value !== void 0) {
      args.candidates = [...args.candidates ?? [], value];
      index += 1;
    } else if (arg === "--force") {
      args.force = true;
    } else {
      throw new Error(`Unknown wiki option: ${arg}`);
    }
  }
  return args;
}
function parseInstallerArgs(argv, settings = {}) {
  let platform = "generic";
  let scope = "project";
  const options = {};
  let yes = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];
    if (arg === "--platform" && value !== void 0) {
      platform = parsePlatform(value);
      index += 1;
    } else if (arg === "--scope" && value !== void 0) {
      scope = parseScope(value);
      index += 1;
    } else if (arg === "--root" && value !== void 0) {
      options.root = value;
      index += 1;
    } else if (arg === "--home" && value !== void 0) {
      options.home = value;
      index += 1;
    } else if (arg === "--language" && value !== void 0) {
      options.language = parseLanguage(value);
      index += 1;
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--force") {
      options.force = true;
    } else if (arg === "--wiki-from" && value !== void 0) {
      options.wikiFrom = value;
      index += 1;
    } else if (arg === "--no-wiki") {
      options.noWiki = true;
    } else if (settings.allowWizard && arg === "--yes") {
      yes = true;
    } else if (arg !== void 0) {
      throw new Error(`Unknown installer option: ${arg}`);
    }
  }
  if (settings.requirePlatform !== false && platform === "generic" && argv.length === 0) {
    platform = "generic";
  }
  return { platform, scope, options, ...yes ? { yes } : {} };
}
function parseLanguage(value) {
  if (value === "en" || value === "zh") return value;
  throw new Error(`Invalid language: ${value}`);
}
var CODEGRAPH_SUBCOMMANDS = ["explore", "query", "impact", "affected", "node", "status", "index", "sync"];
function isCodegraphSubcommand(value) {
  return CODEGRAPH_SUBCOMMANDS.includes(value);
}
async function runCodegraphCommand(argv) {
  const [subcommand, ...rest] = argv;
  if (!subcommand || !isCodegraphSubcommand(subcommand)) {
    throw new Error(`Unknown codegraph command: ${subcommand ?? ""}. Usage: kata codegraph <${CODEGRAPH_SUBCOMMANDS.join("|")}> [args...]`);
  }
  try {
    const stdout = execFileSync5("codegraph", [subcommand, ...rest], {
      encoding: "utf-8",
      maxBuffer: 10 * 1024 * 1024,
      cwd: resolveWorkspaceRoot(),
      env: codeGraphExecutionEnv()
    }).trim();
    return {
      command: `codegraph ${subcommand}`,
      success: true,
      args: rest,
      ...stdout ? { output: stdout } : {}
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      command: `codegraph ${subcommand}`,
      success: false,
      args: rest,
      error: message
    };
  }
}
async function runCometCommand(argv, root = resolveWorkspaceRoot()) {
  const [subcommand, ...rest] = argv;
  const args = parseCometArgs(rest);
  if (subcommand === "acknowledge-open") {
    if (!args.change) throw new Error("Usage: kata comet acknowledge-open --change <id>");
    return { command: "comet acknowledge-open", taskId: args.change, workflowProfile: await acknowledgeCometOpen(root, args.change), nextAction: { slashCommand: `/kata-design ${args.change}`, cliCommand: `kata design --change ${args.change}` } };
  }
  if (subcommand === "install" || subcommand === "update") {
    const result = subcommand === "install" ? await installComet(args.version) : await updateComet();
    return {
      command: `comet ${subcommand}`,
      previousVersion: result.previousVersion,
      installedVersion: result.installedVersion,
      method: result.method,
      path: result.path,
      compatUpdated: result.compatUpdated
    };
  }
  if (subcommand === "version") {
    const compat = readCometCompatibility();
    const installed = await getCometVersion();
    return {
      command: "comet version",
      compatibility: compat,
      installed: installed ?? null,
      compatMinVersion: compat.minVersion,
      compatMaxVersion: compat.maxVersion ?? null
    };
  }
  if (subcommand === "path") {
    const binaryPath = await resolveCometPath();
    return {
      command: "comet path",
      path: binaryPath,
      found: binaryPath !== null
    };
  }
  if (subcommand === "verify") {
    const result = await verifyComet();
    return {
      command: "comet verify",
      exists: result.exists,
      executable: result.executable,
      version: result.version,
      compatible: result.compatible,
      path: result.path
    };
  }
  throw new Error(`Unknown comet command: ${subcommand ?? ""}. Usage: kata comet <install|update|version|path|verify|acknowledge-open>`);
}
function parseCometArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];
    if ((arg === "--version" || arg === "-v") && value !== void 0) {
      args.version = value;
      index += 1;
    } else if (arg === "--change" && value !== void 0) {
      args.change = value;
      index += 1;
    } else if (arg !== void 0) {
      throw new Error(`Unknown comet option: ${arg}`);
    }
  }
  return args;
}
function parsePlatform(value) {
  if (value in platformDefinitionById) return value;
  throw new Error(`Unknown platform: ${value}`);
}
function parseScope(value) {
  if (value === "project" || value === "global") return value;
  throw new Error(`Unknown install scope: ${value}`);
}
function isCliEntrypoint() {
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1] ?? "");
  } catch {
    return false;
  }
}
function outputResult(result) {
  if (quietOutput) return;
  if (!jsonOutput && isUpdateResult(result)) {
    process.stdout.write(renderUpdateSummary(result));
    return;
  }
  process.stdout.write(JSON.stringify(result) + "\n");
}
function writeUpdateProgress(message) {
  if (!quietOutput && !jsonOutput) process.stdout.write(message);
}
function isUpdateResult(result) {
  return result.command === "update" || typeof result.platform === "string" && "written" in result && "unchanged" in result;
}
function formatUpdateReport(report) {
  const changes = [
    `\u5199\u5165 ${report.written.length}`,
    `\u4FDD\u6301 ${report.unchanged.length}`,
    `\u51B2\u7A81 ${report.conflicts.length}`,
    `\u79FB\u9664 ${report.removed.length}`
  ].join(" \xB7 ");
  return `  ${report.dryRun ? "\u9884\u89C8\u5B8C\u6210" : "\u5B8C\u6210"}\uFF1A${changes}
`;
}
function renderUpdateSummary(result) {
  const reports = Array.isArray(result.reports) ? result.reports : [{
    platform: String(result.platform),
    summary: {
      written: Array.isArray(result.written) ? result.written.length : 0,
      unchanged: Array.isArray(result.unchanged) ? result.unchanged.length : 0,
      conflicts: Array.isArray(result.conflicts) ? result.conflicts.length : 0,
      removed: Array.isArray(result.removed) ? result.removed.length : 0,
      dryRun: result.dryRun === true
    }
  }];
  const total = reports.reduce((sum, report) => ({
    written: sum.written + report.summary.written,
    unchanged: sum.unchanged + report.summary.unchanged,
    conflicts: sum.conflicts + report.summary.conflicts,
    removed: sum.removed + report.summary.removed
  }), { written: 0, unchanged: 0, conflicts: 0, removed: 0 });
  const status = total.conflicts > 0 ? "\u5B8C\u6210\uFF08\u5B58\u5728\u9700\u4EBA\u5DE5\u5904\u7406\u7684\u51B2\u7A81\uFF09" : "\u5B8C\u6210";
  const runtimeRefresh = result.runtimeRefresh;
  return `
${status}
\u5E73\u53F0\uFF1A${reports.map((report) => report.platform).join("\u3001")}
\u53D8\u66F4\uFF1A\u5199\u5165 ${total.written} \xB7 \u4FDD\u6301 ${total.unchanged} \xB7 \u51B2\u7A81 ${total.conflicts} \xB7 \u79FB\u9664 ${total.removed}
${runtimeRefresh ? formatRuntimeRefresh(runtimeRefresh) : ""}${jsonOutput ? "" : "\u63D0\u793A\uFF1A\u4F7F\u7528 --json \u83B7\u53D6\u673A\u5668\u53EF\u8BFB\u62A5\u544A\uFF0C\u4F7F\u7528 --quiet \u9759\u9ED8\u6267\u884C\u3002\n"}`;
}
function formatRuntimeRefresh(result) {
  const status = (value) => value.success ? "\u5B8C\u6210" : "\u5931\u8D25";
  const cometVersion = result.comet.success && result.comet.installedVersion ? ` (${result.comet.installedVersion})` : "";
  return `\u8FD0\u884C\u65F6\uFF1AComet \u66F4\u65B0 ${status(result.comet)}${cometVersion} \xB7 CodeGraph sync ${status(result.codegraphSync)} \xB7 CodeGraph index ${status(result.codegraphIndex)}
`;
}
if (isCliEntrypoint()) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
export {
  getRuntimeCompatibility,
  main,
  roleForPhase2 as roleForPhase
};
//# sourceMappingURL=cli.js.map
