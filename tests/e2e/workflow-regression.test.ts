import { describe, expect, it } from 'vitest';
import { createOpenFixture, advanceTo, runImplementFixture, runVerifyFixture } from '../../src/eval/fixtures.js';

describe('Workflow regression', () => {
  it('runs open -> plan -> implement -> hardVerify -> review -> judge on a single task', async () => {
    const fixture = await createOpenFixture('regression-flow');
    try {
      await advanceTo(fixture.root, fixture.taskId, 'judge');
      const { readFile } = await import('node:fs/promises');
      const { join } = await import('node:path');
      const state = JSON.parse(await readFile(join(fixture.root, `.kata/tasks/${fixture.taskId}/current-state.json`), 'utf8'));
      expect(state.phase).toBe('judge');
    } finally {
      await fixture.cleanup();
    }
  });

  it('runs implement fixture with successful evidence', async () => {
    const fixture = await runImplementFixture('regression-impl');
    try {
      expect(fixture.evidence).toHaveLength(1);
      expect(fixture.evidence[0].exitCode).toBe(0);
    } finally {
      await fixture.cleanup();
    }
  });

  it('runs verify fixture with judge PASS', async () => {
    const fixture = await runVerifyFixture('regression-verify');
    try {
      expect(fixture.judgeResult.result).toBe('PASS');
    } finally {
      await fixture.cleanup();
    }
  });
});
