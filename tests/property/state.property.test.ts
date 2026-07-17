import { describe, expect, it } from 'vitest';
import { isLegalPhaseTransition, orderedPhases, type Phase } from '../../src/core/state.js';

describe('Kata state transition properties', () => {
  it('allows only adjacent forward transitions in the governed workflow', () => {
    for (const from of orderedPhases) {
      for (const to of orderedPhases) {
        const fromIndex = orderedPhases.indexOf(from);
        const toIndex = orderedPhases.indexOf(to);

        expect(isLegalPhaseTransition(from as Phase, to as Phase)).toBe(toIndex === fromIndex + 1);
      }
    }
  });
});
