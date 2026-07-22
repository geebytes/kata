import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
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

  it('does not pass the unsupported --yes flag to codegraph index', async () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
    const [cli, ownership] = await Promise.all([
      readFile(join(root, 'src/cli.ts'), 'utf8'),
      readFile(join(root, 'src/adapters/ownership.ts'), 'utf8'),
    ]);

    expect(cli).not.toContain("['index', '--yes']");
    expect(ownership).not.toContain("['index', '--yes']");
  });
});
