import { createHash, randomUUID } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { spawn } from 'node:child_process';
const maxLogLength = 20_000;
export async function collectEvidence(taskId, commands, options = {}) {
    const evidence = [];
    const cwd = commands[0]?.cwd ?? process.cwd();
    if (commands.some((check) => (check.cwd ?? process.cwd()) !== cwd)) {
        throw new Error('All evidence checks in one collection must use the same cwd');
    }
    for (const check of commands) {
        if (options.signal?.aborted)
            break;
        const checkName = check.name ?? check.command;
        const timeoutMs = check.timeoutMs ?? 120_000;
        options.onProgress?.({ type: 'quality_check_progress', check: checkName, state: 'started', timeoutMs });
        const startedAt = new Date().toISOString();
        const redactions = collectRedactions(check);
        const command = redact(renderCommand(check.command, check.args ?? []), redactions);
        const result = check.importResult ?? (await runBoundedCommand(check, { onProgress: options.onProgress, signal: options.signal }));
        const finishedAt = new Date().toISOString();
        const finalState = options.signal?.aborted
            ? 'cancelled'
            : result.exitCode === 0
                ? 'passed'
                : result.exitCode === 124
                    ? 'timed_out'
                    : 'failed';
        options.onProgress?.({ type: 'quality_check_progress', check: checkName, state: finalState, timeoutMs, exitCode: result.exitCode });
        evidence.push({
            id: `evidence-${randomUUID()}`,
            taskId,
            ...(check.name ? { name: check.name } : {}),
            kind: check.kind,
            command,
            environment: redact(result.environment ?? environmentSummary(cwd), redactions),
            exitCode: result.exitCode,
            startedAt,
            finishedAt,
            diffHash: '',
            ...(result.log ? { log: redact(truncate(result.log), redactions) } : {}),
        });
    }
    if (evidence.length === 0)
        return evidence;
    const finalDiffHash = await computeDiffHash(cwd);
    const scopePaths = options.revision?.ownedPaths ?? options.scopePaths;
    const scope = options.revision
        ? { paths: options.revision.ownedPaths, hash: options.revision.manifestHash }
        : scopePaths?.length
            ? { paths: [...new Set(scopePaths.map((path) => normalizeScopePath(cwd, path)))].sort(), hash: await computeScopeHash(cwd, scopePaths) }
            : undefined;
    return evidence.map((item) => ({
        ...item,
        diffHash: finalDiffHash,
        ...(options.revision ? { revisionId: options.revision.id } : {}),
        ...(scope ? { scope } : {}),
    }));
}
export function checkFreshness(evidence, diffHash, scopeHash) {
    if (evidence.scope) {
        if (scopeHash === evidence.scope.hash)
            return { fresh: true };
        return {
            fresh: false,
            reason: 'scope_hash_mismatch',
            expectedScopeHash: scopeHash ?? '',
            evidenceScopeHash: evidence.scope.hash,
        };
    }
    if (evidence.diffHash === diffHash)
        return { fresh: true };
    return {
        fresh: false,
        reason: 'diff_hash_mismatch',
        expectedDiffHash: diffHash,
        evidenceDiffHash: evidence.diffHash,
    };
}
export async function computeScopeHash(root, paths) {
    const normalizedPaths = [...new Set(paths.map((path) => normalizeScopePath(root, path)))].sort();
    const hash = createHash('sha256');
    for (const path of normalizedPaths) {
        hash.update(path);
        hash.update('\0');
        const fullPath = join(root, path);
        try {
            const entryStat = await stat(fullPath);
            if (entryStat.isDirectory()) {
                await hashDirectoryRecursive(fullPath, root, hash);
            }
            else {
                hash.update(await readFile(fullPath));
            }
        }
        catch {
            hash.update('[missing]');
        }
        hash.update('\0');
    }
    return hash.digest('hex');
}
async function hashDirectoryRecursive(dirPath, root, hash) {
    let entries;
    try {
        entries = await readdir(dirPath, { withFileTypes: true });
    }
    catch {
        return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (shouldIgnore(entry.name))
            continue;
        const absolutePath = join(dirPath, entry.name);
        const relativePath = relative(root, absolutePath).replaceAll('\\', '/');
        if (shouldIgnorePath(relativePath))
            continue;
        if (entry.isDirectory()) {
            await hashDirectoryRecursive(absolutePath, root, hash);
            continue;
        }
        if (!entry.isFile())
            continue;
        hash.update(relativePath);
        hash.update('\0');
        try {
            hash.update(await readFile(absolutePath));
        }
        catch {
            hash.update('[missing]');
        }
        hash.update('\0');
    }
}
function normalizeScopePath(root, path) {
    const absolute = resolve(root, path);
    const normalized = relative(root, absolute).replaceAll('\\', '/');
    if (!normalized || normalized === '..' || normalized.startsWith('../')) {
        throw new Error(`Evidence scope path must be inside the repository: ${path}`);
    }
    return normalized;
}
export async function computeDiffHash(root = process.cwd()) {
    const entries = await collectFileSnapshot(root);
    const hash = createHash('sha256');
    for (const entry of entries) {
        hash.update(entry.path);
        hash.update('\0');
        hash.update(entry.content);
        hash.update('\0');
    }
    return hash.digest('hex');
}
const graceMs = 5_000;
async function runBoundedCommand(check, options) {
    const cwd = check.cwd ?? process.cwd();
    const timeoutMs = check.timeoutMs ?? 120_000;
    const checkName = check.name ?? check.command;
    const child = spawn(check.command, check.args ?? [], {
        cwd,
        env: { ...process.env, ...(check.env ?? {}) },
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false,
        detached: true,
    });
    const exitPromise = new Promise((exitResolve) => {
        child.on('close', (code) => exitResolve(code));
    });
    return new Promise((resolve, reject) => {
        let settled = false;
        let output = '';
        let terminating = false;
        async function terminateAndWait(exitCode, logNote) {
            const pid = child.pid;
            if (pid === undefined)
                return;
            terminating = true;
            try {
                process.kill(-pid, 'SIGTERM');
            }
            catch { /* already gone */ }
            const grace = setTimeout(() => {
                try {
                    process.kill(-pid, 'SIGKILL');
                }
                catch { /* already gone */ }
            }, graceMs);
            await exitPromise;
            clearTimeout(grace);
            if (!settled) {
                settled = true;
                resolve({
                    exitCode,
                    log: `${truncate(output)}\n[${logNote}]`,
                    environment: environmentSummary(cwd),
                });
            }
        }
        const timer = setTimeout(() => {
            terminateAndWait(124, `TIMEOUT after ${timeoutMs}ms`);
        }, timeoutMs);
        function onAbort() {
            clearTimeout(timer);
            terminateAndWait(1, 'CANCELLED');
        }
        const abortSignal = options?.signal;
        if (abortSignal?.aborted) {
            onAbort();
            return;
        }
        abortSignal?.addEventListener('abort', onAbort, { once: true });
        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', (chunk) => {
            output = truncate(output + chunk);
        });
        child.stderr.on('data', (chunk) => {
            output = truncate(output + chunk);
        });
        child.on('error', (error) => {
            clearTimeout(timer);
            abortSignal?.removeEventListener('abort', onAbort);
            if (!settled) {
                settled = true;
                reject(error);
            }
        });
        exitPromise.then((code) => {
            clearTimeout(timer);
            abortSignal?.removeEventListener('abort', onAbort);
            if (!terminating && !settled) {
                settled = true;
                resolve({
                    exitCode: code ?? 1,
                    log: output,
                    environment: environmentSummary(cwd),
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
        }
        catch {
            return;
        }
        for (const entry of entries) {
            if (shouldIgnore(entry.name))
                continue;
            const absolutePath = join(directory, entry.name);
            const relativePath = relative(root, absolutePath).replaceAll('\\', '/');
            if (shouldIgnorePath(relativePath))
                continue;
            if (entry.isDirectory()) {
                await visit(absolutePath);
                continue;
            }
            if (!entry.isFile())
                continue;
            const info = await stat(absolutePath);
            if (info.size > 2_000_000)
                continue;
            files.push({ path: relativePath, content: await readFile(absolutePath) });
        }
    }
    await visit(root);
    return files.sort((left, right) => left.path.localeCompare(right.path));
}
function shouldIgnore(name) {
    return name === '.git'
        || name === '.kata'
        || name === '.llmwiki'
        || name === '.pytest_cache'
        || name === '.mypy_cache'
        || name === '.ruff_cache'
        || name === '.coverage'
        || name === '__pycache__'
        || name === 'node_modules'
        || name === 'dist'
        || name === '.codex'
        || name === '.claude'
        || name === '.opencode';
}
function shouldIgnorePath(path) {
    return path === '.github/hooks'
        || path.startsWith('.github/hooks/')
        || path === '.github/skills'
        || path.startsWith('.github/skills/')
        || path === '.github/instructions'
        || path.startsWith('.github/instructions/');
}
function collectRedactions(check) {
    return [
        ...(check.redact ?? []),
        ...sensitiveEnvironmentValues(process.env),
        ...Object.entries(check.env ?? {})
            .filter(([key]) => /secret|token|password|key/i.test(key))
            .map(([, value]) => value),
    ].filter((value) => value.length > 0);
}
function sensitiveEnvironmentValues(env) {
    return Object.entries(env)
        .filter(([key]) => /secret|token|password|key/i.test(key))
        .map(([, value]) => value ?? '')
        .filter((value) => value.length > 0);
}
function environmentSummary(cwd) {
    return `node=${process.version} platform=${process.platform} cwd=${cwd}`;
}
function renderCommand(command, args) {
    return [command, ...args].join(' ');
}
function redact(value, secrets) {
    let redacted = value;
    for (const secret of secrets) {
        redacted = redacted.split(secret).join('[REDACTED]');
    }
    return redacted;
}
function truncate(value) {
    if (value.length <= maxLogLength)
        return value;
    return value.slice(0, maxLogLength);
}
//# sourceMappingURL=evidence.js.map