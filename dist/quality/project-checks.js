import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
export async function resolveBuildChecks(root, config) {
    const configured = config.quality?.buildChecks?.map((check) => ({
        name: check.name ?? inferCheckName(check.command, check.args ?? []),
        kind: check.kind ?? inferEvidenceKind(check.name ?? check.args?.[0] ?? check.command),
        command: check.command,
        args: check.args ?? [],
        cwd: root,
        timeoutMs: check.timeoutMs ?? defaultTimeoutMs(check.name ?? check.args?.[0] ?? check.command),
    })) ?? [];
    const discovered = await discoverProjectQualityChecks(root);
    // Explicit project configuration or discovered project gates already define
    // the baseline suite. Generic TypeScript/Vitest fallbacks apply only when a
    // project declares neither, otherwise a configured Python/Go/etc. project
    // would receive unrelated failing checks.
    const defaults = configured.length > 0 || discovered.length > 0 ? [] : [
        { name: 'typecheck', kind: 'typecheck', command: process.execPath, args: ['node_modules/typescript/lib/tsc.js', '--noEmit'], cwd: root, timeoutMs: 60_000 },
        { name: 'test', kind: 'test', command: process.execPath, args: ['node_modules/vitest/dist/cli.js', 'run'], cwd: root, timeoutMs: 120_000 },
    ];
    const merged = [...configured, ...discovered, ...defaults];
    return dedupeChecks(merged);
}
async function discoverProjectQualityChecks(root) {
    const files = await candidateConstraintFiles(root);
    const commands = [];
    for (const file of files) {
        const content = await readFile(file, 'utf8').catch(() => '');
        commands.push(...extractAcceptanceGateCommands(content));
    }
    return dedupe(commands).map((command) => commandLineToCheck(root, command)).filter((check) => Boolean(check));
}
async function candidateConstraintFiles(root) {
    const files = [join(root, 'AGENTS.md')];
    const skillsRoot = join(root, '.agents/skills');
    let skillNames = [];
    try {
        skillNames = await readdir(skillsRoot);
    }
    catch {
        skillNames = [];
    }
    for (const skillName of skillNames.sort()) {
        files.push(join(skillsRoot, skillName, 'SKILL.md'));
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
        if (!inAcceptanceGate)
            continue;
        if (/^```/.test(line.trim())) {
            inFence = !inFence;
            continue;
        }
        if (!inFence)
            continue;
        const command = normalizeCommandLine(line);
        if (command)
            commands.push(command);
    }
    return commands;
}
function normalizeCommandLine(line) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#'))
        return null;
    if (!/^make\s+[A-Za-z0-9_.-]+$/.test(trimmed))
        return null;
    return trimmed;
}
function commandLineToCheck(root, commandLine) {
    const [command, target] = commandLine.split(/\s+/);
    if (!command || !target)
        return null;
    return {
        name: target,
        kind: inferEvidenceKind(target),
        command,
        args: [target],
        cwd: root,
        timeoutMs: defaultTimeoutMs(target),
    };
}
function inferCheckName(command, args) {
    if (command === 'make' && args[0])
        return args[0];
    return command.replace(/[^A-Za-z0-9_.-]+/g, '-').replace(/^-|-$/g, '') || 'check';
}
function inferEvidenceKind(name) {
    const normalized = name.toLowerCase();
    if (normalized.includes('lint'))
        return 'lint';
    if (normalized.includes('type') || normalized.includes('pyright') || normalized.includes('mypy'))
        return 'typecheck';
    if (normalized.includes('test') || normalized.includes('cov'))
        return 'test';
    if (normalized.includes('security') || normalized.includes('audit'))
        return 'security';
    return 'ci';
}
function defaultTimeoutMs(name) {
    const normalized = name.toLowerCase();
    if (normalized === 'test' || normalized.startsWith('test-'))
        return 300_000;
    if (normalized.includes('test') || normalized.includes('cov'))
        return 120_000;
    return 60_000;
}
function dedupe(values) {
    return [...new Set(values)];
}
function dedupeChecks(checks) {
    const seen = new Set();
    return checks.filter((check) => {
        const key = `${check.name ?? ''}:${check.command}:${(check.args ?? []).join(',')}`;
        if (seen.has(key))
            return false;
        seen.add(key);
        return true;
    });
}
//# sourceMappingURL=project-checks.js.map