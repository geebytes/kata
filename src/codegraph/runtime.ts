import { dirname } from 'node:path';

export function codeGraphExecutionEnv(
  inherited: NodeJS.ProcessEnv = process.env,
  nodeExecutable = process.execPath,
): NodeJS.ProcessEnv {
  const runtimeBin = dirname(nodeExecutable);
  const inheritedPath = inherited.PATH ?? '';
  return {
    ...inherited,
    PATH: inheritedPath ? `${runtimeBin}:${inheritedPath}` : runtimeBin,
  };
}
