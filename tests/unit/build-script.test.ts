import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('build script', () => {
  it('marks the CLI bundle executable for npm bin links', async () => {
    await execFileAsync(process.execPath, ['scripts/build.mjs'], { cwd: root });

    const mode = (await stat(join(root, 'dist/cli.js'))).mode;
    expect(mode & 0o111).not.toBe(0);
  });
});
