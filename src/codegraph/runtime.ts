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
