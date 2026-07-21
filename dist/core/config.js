import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
export async function loadConfig(root) {
    const parsed = await readConfigObject(root);
    try {
        return {
            ...(parsed.language !== undefined ? { language: parseResponseLanguage(parsed.language) } : {}),
            ...(isRecord(parsed.quality) ? { quality: parseQualityConfig(parsed.quality) } : {}),
        };
    }
    catch (error) {
        throw new Error(`Invalid Kata config: ${error instanceof Error ? error.message : String(error)}`);
    }
}
export async function readConfigObject(root) {
    const configPath = join(root, '.kata-config.json');
    let raw;
    try {
        raw = await readFile(configPath, 'utf8');
    }
    catch (error) {
        if (isNodeError(error) && error.code === 'ENOENT')
            return {};
        throw error;
    }
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch (error) {
        throw new Error(`Invalid Kata config JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!isRecord(parsed))
        throw new Error('Invalid Kata config: root must be an object');
    return parsed;
}
export async function writeConfigPatch(root, patch) {
    const current = await readConfigObject(root);
    const next = { ...current, ...patch };
    await writeFile(join(root, '.kata-config.json'), `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    return next;
}
function parseQualityConfig(value) {
    const buildChecks = Array.isArray(value.buildChecks)
        ? value.buildChecks.map(parseQualityCheck)
        : undefined;
    return {
        ...(buildChecks ? { buildChecks } : {}),
    };
}
function parseQualityCheck(value) {
    if (!isRecord(value))
        throw new Error('quality.buildChecks entries must be objects');
    if (typeof value.command !== 'string' || value.command.length === 0) {
        throw new Error('quality.buildChecks[].command is required');
    }
    const args = value.args === undefined
        ? undefined
        : Array.isArray(value.args) && value.args.every((item) => typeof item === 'string')
            ? value.args
            : (() => { throw new Error('quality.buildChecks[].args must be a string array'); })();
    const kind = value.kind === undefined
        ? undefined
        : isEvidenceKind(value.kind)
            ? value.kind
            : (() => { throw new Error('quality.buildChecks[].kind is invalid'); })();
    return {
        ...(typeof value.name === 'string' ? { name: value.name } : {}),
        ...(kind ? { kind } : {}),
        command: value.command,
        ...(args ? { args } : {}),
        ...(typeof value.timeoutMs === 'number' ? { timeoutMs: value.timeoutMs } : {}),
    };
}
function isEvidenceKind(value) {
    return typeof value === 'string' && ['lint', 'typecheck', 'test', 'ci', 'review', 'judge', 'security'].includes(value);
}
function parseResponseLanguage(value) {
    if (value === 'en' || value === 'zh')
        return value;
    throw new Error('language must be "en" or "zh"');
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function isNodeError(error) {
    return error instanceof Error && 'code' in error;
}
//# sourceMappingURL=config.js.map