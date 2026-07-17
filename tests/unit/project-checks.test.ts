import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { resolveBuildChecks } from '../../src/quality/project-checks.js';

describe('project quality check discovery', () => {
  const roots: string[] = [];

  async function tempRoot(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'kata-project-checks-'));
    roots.push(root);
    return root;
  }

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it('gives discovered make test enough time for a Python full suite', async () => {
    const root = await tempRoot();
    await writeFile(
      join(root, 'AGENTS.md'),
      ['# Project', '', '## Acceptance Gate', '', '```bash', 'make test', '```', ''].join('\n'),
      'utf8',
    );

    const checks = await resolveBuildChecks(root, {});

    expect(checks).toContainEqual(expect.objectContaining({
      name: 'test',
      command: 'make',
      args: ['test'],
      timeoutMs: 300_000,
    }));
  });
});
