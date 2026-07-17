import { execFileSync } from 'node:child_process';

export function currentGitBranch(root: string): string | null {
  try {
    const branch = execFileSync('git', ['-C', root, 'branch', '--show-current'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return branch || null;
  } catch {
    return null;
  }
}
