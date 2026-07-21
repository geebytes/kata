import { execFileSync } from 'node:child_process';
export function currentGitBranch(root) {
    try {
        const branch = execFileSync('git', ['-C', root, 'branch', '--show-current'], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
        return branch || null;
    }
    catch {
        return null;
    }
}
//# sourceMappingURL=git.js.map