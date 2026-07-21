import { dirname } from 'node:path';
export function codeGraphExecutionEnv(inherited = process.env, nodeExecutable = process.execPath) {
    const runtimeBin = dirname(nodeExecutable);
    const inheritedPath = inherited.PATH ?? '';
    return {
        ...inherited,
        PATH: inheritedPath ? `${runtimeBin}:${inheritedPath}` : runtimeBin,
    };
}
//# sourceMappingURL=runtime.js.map