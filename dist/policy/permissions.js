export function validateWrite(actor, path, task) {
    const normalizedPath = normalizePath(path);
    if (!normalizedPath)
        return deny('invalid_path');
    if (isProtectedRulesOrVerifiedWiki(normalizedPath)) {
        return actor.role === 'approver' ? { allowed: true } : deny('protected_rules_or_verified_wiki');
    }
    if (actor.role === 'implementer') {
        if (isTaskCodeOrTestPath(normalizedPath) || isTaskOwnedKataPath(normalizedPath, task))
            return { allowed: true };
        return deny('role_scope_violation');
    }
    if (actor.role === 'reviewer') {
        return normalizedPath === `.kata/tasks/${task.id}/review.json` ? { allowed: true } : deny('role_scope_violation');
    }
    if (actor.role === 'judge') {
        return normalizedPath === `.kata/tasks/${task.id}/judge.json` ? { allowed: true } : deny('role_scope_violation');
    }
    if (actor.role === 'distiller') {
        return normalizedPath.startsWith('.kata/wiki/candidates/') || normalizedPath === `.kata/tasks/${task.id}/wiki-candidate.json`
            ? { allowed: true }
            : deny('role_scope_violation');
    }
    if (actor.role === 'approver')
        return { allowed: true };
    return deny('unknown_role');
}
function normalizePath(path) {
    const normalizedPath = path.replaceAll('\\', '/').replace(/^\.\/+/, '');
    if (normalizedPath.startsWith('/') || /^[A-Za-z]:\//.test(normalizedPath))
        return null;
    if (normalizedPath.split('/').includes('..'))
        return null;
    return normalizedPath;
}
function isProtectedRulesOrVerifiedWiki(path) {
    return path.startsWith('docs/superpowers/rules/') || path.startsWith('.kata/wiki/verified/');
}
function isTaskCodeOrTestPath(path) {
    return path.startsWith('src/') || path.startsWith('tests/');
}
function isTaskOwnedKataPath(path, task) {
    return path.startsWith(`.kata/tasks/${task.id}/`);
}
function deny(reason) {
    return { allowed: false, reason };
}
//# sourceMappingURL=permissions.js.map