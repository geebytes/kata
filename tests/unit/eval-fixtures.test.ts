import { describe, expect, it } from 'vitest';
import { createOpenFixture, advanceTo, runImplementFixture, runRepairFixture } from '../../src/eval/fixtures.js';

describe('Evaluation fixtures', () => {
  it('creates open fixture with task in intake', async () => {
    const fixture = await createOpenFixture('eval-open-test');
    try {
      const { readFile } = await import('node:fs/promises');
      const { join } = await import('node:path');
      const state = JSON.parse(await readFile(join(fixture.root, '.kata/tasks/eval-open-test/current-state.json'), 'utf8'));
      expect(state.phase).toBe('intake');
    } finally {
      await fixture.cleanup();
    }
  });

  it('creates implement fixture with collected evidence', async () => {
    const fixture = await runImplementFixture('eval-impl-test');
    try {
      expect(fixture.evidence).toHaveLength(1);
      expect(fixture.evidence[0].exitCode).toBe(0);
    } finally {
      await fixture.cleanup();
    }
  });

  it('creates repair fixture with blocking finding', async () => {
    const fixture = await runRepairFixture('eval-repair-test');
    try {
      const { readFile } = await import('node:fs/promises');
      const { join } = await import('node:path');
      const review = JSON.parse(await readFile(join(fixture.root, '.kata/tasks/eval-repair-test/review.json'), 'utf8'));
      expect(review.findings).toHaveLength(1);
      expect(review.findings[0].severity).toBe('blocking');
    } finally {
      await fixture.cleanup();
    }
  });
});
