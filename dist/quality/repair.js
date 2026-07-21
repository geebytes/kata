export function enforceRepairScope(finding, diff) {
    if (diff.budget && (diff.filesChanged > diff.budget.maxFiles || diff.linesChanged > diff.budget.maxLines)) {
        return { allowed: false, reason: 'diff_budget_exceeded', nextPhase: 'hardVerify' };
    }
    const relatedPaths = new Set(finding.relatedPaths.map(normalizePath));
    const unrelatedPaths = diff.changedPaths.map(normalizePath).filter((path) => !relatedPaths.has(path));
    if (unrelatedPaths.length > 0) {
        return {
            allowed: false,
            reason: 'unrelated_repair_path',
            unrelatedPaths,
            nextPhase: 'hardVerify',
        };
    }
    return { allowed: true, nextPhase: 'hardVerify' };
}
function normalizePath(path) {
    return path.replaceAll('\\', '/').replace(/^\.\/+/, '');
}
//# sourceMappingURL=repair.js.map