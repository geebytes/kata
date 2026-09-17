import { dirname } from 'node:path';

export function codeGraphExecutionEnv(
  inherited: NodeJS.ProcessEnv = process.env,
  nodeExecutable = process.execPath,
): NodeJS.ProcessEnv {
  const runtimeBin = dirname(nodeExecutable);
  const overrideBin = inherited.STRATA_CODEGRAPH_BIN ? dirname(inherited.STRATA_CODEGRAPH_BIN) : undefined;
  const inheritedPath = inherited.PATH ?? '';
  const pathSegments = [overrideBin, runtimeBin, inheritedPath].filter((segment): segment is string => Boolean(segment));
  return {
    ...inherited,
    PATH: pathSegments.join(':'),
  };
}

/**
 * How to reach the CodeGraph binary, in one place.
 *
 * Four call sites used to pass the environment fix and working directory by convention, and the archive-time refresh
 * passed neither — so the one call that runs when a task is archived could not find a codegraph installed beside the
 * running Node, and did not run in the workspace root. Callers ask this instead of remembering.
 */
export function codeGraphBinary(inherited: NodeJS.ProcessEnv = process.env): string {
  return inherited.STRATA_CODEGRAPH_BIN || 'codegraph';
}

export function codeGraphInvocation(root: string, inherited: NodeJS.ProcessEnv = process.env): {
  command: string;
  env: NodeJS.ProcessEnv;
  cwd: string;
} {
  return { command: codeGraphBinary(inherited), env: codeGraphExecutionEnv(inherited), cwd: root };
}
