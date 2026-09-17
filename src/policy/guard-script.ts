import { renderPolicySource } from './hook-policy.js';

/**
 * The hook guard every platform installs.
 *
 * It is a standalone program: kata writes it into a project (or into a global config directory) and the platform runs
 * it on the agent's tool calls, so it cannot import anything at run time. Its text is assembled here from the policy's
 * own source — one rendering, not a copy — which is why this lives beside `hook-policy.ts` rather than with the
 * installer that writes it: the rule and the program that enforces it change together.
 */

export function renderHookGuardScript(): string {
  return `#!/usr/bin/env node
// Managed by Kata. Active-task hook guard.
import { readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

${renderPolicySource()}

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
const normalizedPath = normalizeHookPath(root, targetPath, { resolve, relative });
const denial = evaluateHookWrite({ role }, normalizedPath, { ...task, id: taskId, phase });

if (denial) {
  console.error(\`Kata hook blocked write to \${targetPath}: \${denial}\`);
  console.error('Run: kata-cli orient --change ' + taskId + ' --role ' + role);
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

`;
}

