/**
 * The write policy, as one dependency-free pair of functions.
 *
 * Two callers evaluate this module. The in-process check (`validateWrite`) calls the functions directly, and the
 * platform hook script Kata installs embeds their source verbatim (`Function.prototype.toString`) so the guard a
 * developer actually runs and the policy the CLI reasons about cannot drift apart.
 *
 * Keep both functions self-contained: no imports, no references to module scope other than their own parameters.
 * Anything they close over would be missing from the embedded copy.
 */

export interface PolicyActor {
    role: string;
}

export interface PolicyTask {
    id?: string;
    phase?: string;
}

/** The slice of `node:path` the normalizer needs, injected so the function stays self-contained. */
export interface PathApi {
    resolve(...parts: string[]): string;
    relative(from: string, to: string): string;
}

/**
 * Normalizes a path a caller supplied into a repository-relative path, or `null` when the path cannot be trusted:
 * empty, containing a NUL byte, Windows drive-absolute, containing a traversal segment, or resolving outside the
 * project root. Traversal is refused outright rather than resolved, because the hook receives paths from a host
 * platform and a path that walks upwards is never a legitimate project write.
 */
export function normalizeHookPath(projectRoot: string, targetPath: string, pathApi: PathApi): string | null {
    const raw = String(targetPath).replaceAll('\\', '/');
    if (!raw || raw.includes('\u0000')) return null;
    if (/^[A-Za-z]:\//.test(raw)) return null;
    if (raw.split('/').includes('..')) return null;
    const absolute = raw.startsWith('/') ? pathApi.resolve(raw) : pathApi.resolve(projectRoot, raw);
    const relativePath = pathApi.relative(projectRoot, absolute).replaceAll('\\', '/');
    if (!relativePath || relativePath.startsWith('..') || relativePath.startsWith('/')) return null;
    if (relativePath.split('/').includes('..')) return null;
    return relativePath;
}

/** The rule: a denial reason, or `null` when the write is allowed. */
export function evaluateHookWrite(actor: PolicyActor, normalizedPath: string | null, task: PolicyTask): string | null {
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

/** Renders the pair as script source, for the emitted hook guard. */
export function renderPolicySource(): string {
    return [
        `const normalizeHookPath = ${normalizeHookPath.toString()};`,
        `const evaluateHookWrite = ${evaluateHookWrite.toString()};`,
    ].join('\n');
}
