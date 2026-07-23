#!/usr/bin/env node
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
  console.error(`Kata hook blocked write to ${targetPath}: ${denial}`);
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
  const raw = String(targetPath).replaceAll('\\', '/');
  if (!raw || raw.includes('\u0000')) return null;
  if (/^[A-Za-z]:\//.test(raw)) return null;
  const absolute = raw.startsWith('/') ? resolve(raw) : resolve(projectRoot, raw);
  const rel = relative(projectRoot, absolute).replaceAll('\\', '/');
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
