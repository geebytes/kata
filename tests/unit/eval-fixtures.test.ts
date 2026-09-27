import { describe, expect, it } from 'vitest';
import { createOpenFixture, advanceTo, runImplementFixture, runRepairFixture } from '../helpers/eval-fixtures.js';

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

  it('creates a repair fixture whose evidence does not pass, which is what a repair is about now', async () => {
    // The fixture used to inject a blocking finding through the round-shaped route's producer. That table reaches no
    // verdict any more — a claim's evidence does — so the scenario is the one the route actually produces: a recorded
    // failing check, which is what sends a change to repair.
    const fixture = await runRepairFixture('eval-repair-test');
    try {
      expect(fixture.evidence.length).toBeGreaterThan(0);
      expect(fixture.evidence.some((envelope) => envelope.exitCode !== 0)).toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });
});
