import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initLayout } from '../../src/core/layout.js';
import { runCommand } from '../../src/workflow/orchestrator.js';
import { readWikiClosure } from '../../src/wiki/closure.js';
import { verifySources } from '../../src/wiki/drift.js';
import { readWikiRecords } from '../../src/wiki/store.js';

describe('Archive Wiki distillation', () => {
  const roots: string[] = [];

  async function tempRoot(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'kata-wiki-distill-'));
    roots.push(root);
    await initLayout(root);
    return root;
  }

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it('automatically captures reusable knowledge for a Judge-PASS workflow task during archive', async () => {
    const root = await tempRoot();
    await writeFile(join(root, 'workflow.ts'), 'export const mode = \"automatic\";\n', 'utf8');
    const taskId = 'auto-distill-workflow';
    await runCommand('open', taskId, root, {
      title: 'Automate archive workflow distillation',
      acceptance: [{ id: 'AC-1', statement: 'Archive automatically captures reusable workflow knowledge.' }],
      ownedPaths: ['workflow.ts'],
    });
    await writeFile(
      join(root, `.kata/tasks/${taskId}/design.md`),
      '# Design\n\nArchive replaces manual Wiki classification with automatic deterministic capture.\n',
      'utf8',
    );
    await runCommand('design', taskId, root);
    await runCommand('build', taskId, root, {
      checks: [{ kind: 'test', command: process.execPath, args: ['-e', 'process.exit(0)'], cwd: root }],
    });
    await runCommand('verify', taskId, root);
    await runCommand('review', taskId, root);
    await runCommand('review', taskId, root, { approve: true });
    await runCommand('judge', taskId, root);

    const result = await runCommand('archive', taskId, root);

    expect(result).toMatchObject({ success: true, phase: 'archive' });
    const closure = await readWikiClosure(root, taskId);
    expect(closure).toMatchObject({
      decision: 'captured',
      candidateIds: [`wiki-${taskId}`],
    });
    const records = await readWikiRecords(root);
    expect(records).toEqual([
      expect.objectContaining({
        id: `wiki-${taskId}`,
        validationTaskId: taskId,
        status: 'candidate',
        evidenceIds: expect.arrayContaining([expect.any(String)]),
        sourceHashes: expect.objectContaining({
          'workflow.ts': expect.stringMatching(/^[a-f0-9]{64}$/),
        }),
      }),
    ]);
    expect(records[0]?.sourceRefs).toEqual(expect.arrayContaining([
      `.kata/tasks/${taskId}/task.json`,
      `.kata/tasks/${taskId}/design.md`,
      `.kata/tasks/${taskId}/judge.json`,
      'workflow.ts',
    ]));
    expect(records[0]?.sourceRefs).not.toContain(`.kata/tasks/${taskId}/current-state.json`);
    const drift = await verifySources(root);
    expect(drift.stale).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: `wiki-${taskId}` }),
    ]));
  });
});
