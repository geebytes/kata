import { describe, expect, it } from 'vitest';
import { codeGraphExecutionEnv } from '../../src/codegraph/runtime.js';

describe('CodeGraph runtime environment', () => {
  it('prepends the active Node runtime directory while retaining the inherited PATH', () => {
    const env = codeGraphExecutionEnv({ PATH: '/inherited/bin' }, '/runtime/bin/node');

    expect(env.PATH).toBe('/runtime/bin:/inherited/bin');
  });

  it('does not replace an explicit CodeGraph binary override', () => {
    const env = codeGraphExecutionEnv({ PATH: '/inherited/bin', STRATA_CODEGRAPH_BIN: '/custom/codegraph' }, '/runtime/bin/node');

    expect(env.STRATA_CODEGRAPH_BIN).toBe('/custom/codegraph');
  });
});
