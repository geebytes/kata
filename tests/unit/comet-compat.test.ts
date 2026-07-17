import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { assertCometVersion, loadCometCompatibility, type CometCompatibility } from '../../src/comet/compat.js';
import { CometClient } from '../../src/comet/client.js';
import { getRuntimeCompatibility } from '../../src/cli.js';

describe('Comet compatibility boundary', () => {
  const roots: string[] = [];
  const compatibility: CometCompatibility = {
    minVersion: '1.2.0',
    maxVersion: '2.0.0',
    capabilities: { init: true, status: true, next: true },
  };

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it('invokes only the public comet command with argument arrays and parses JSON', async () => {
    const calls: Array<{ command: string; args: readonly string[] }> = [];
    const client = new CometClient({
      command: 'comet',
      compatibility,
      run: async (command: string, args: readonly string[]) => {
        calls.push({ command, args });
        if (args[0] === 'status') return JSON.stringify({ phase: 'open', status: 'ok' });
        if (args[0] === 'next') return JSON.stringify({ next: 'design' });
        return '';
      },
    });

    await client.init('demo-change');
    await expect(client.status('demo-change')).resolves.toEqual({ phase: 'open', status: 'ok' });
    await expect(client.next('demo-change')).resolves.toEqual({ next: 'design' });

    expect(calls).toEqual([
      { command: 'comet', args: ['init', 'demo-change', '--json', '--yes'] },
      { command: 'comet', args: ['status', 'demo-change', '--json'] },
      { command: 'comet', args: ['next', 'demo-change', '--json'] },
    ]);
  });

  it('rejects a Comet version outside the declared compatibility range', () => {
    expect(() => assertCometVersion('1.1.9', compatibility)).toThrow(/outside compatibility range/);
    expect(() => assertCometVersion('2.0.1', compatibility)).toThrow(/outside compatibility range/);
    expect(() => assertCometVersion('1.5.0', compatibility)).not.toThrow();
  });

  it('loads runtime compatibility from comet-compat.yaml as the single source of truth', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kata-comet-compat-'));
    roots.push(root);
    const manifestPath = join(root, 'comet-compat.yaml');
    await writeFile(
      manifestPath,
      [
        'version: 1',
        'comet:',
        '  minVersion: 3.4.5',
        '  maxVersion: 3.5.0',
        '  capabilities:',
        '    init: true',
        '    status: false',
        '    next: true',
        'boundary:',
        '  invocation: public-cli',
        '  jsonOutput: true',
        '',
      ].join('\n'),
      'utf8',
    );

    expect(loadCometCompatibility(manifestPath)).toEqual({
      minVersion: '3.4.5',
      maxVersion: '3.5.0',
      capabilities: { init: true, status: false, next: true },
    });
    expect(getRuntimeCompatibility(manifestPath)).toEqual(loadCometCompatibility(manifestPath));

    const client = new CometClient({
      command: 'comet',
      compatibility: loadCometCompatibility(manifestPath),
      run: async () => JSON.stringify({ phase: 'unused' }),
    });
    await expect(client.status('demo-change')).rejects.toThrow(/status/);
  });

  it('rejects mocked installed Comet versions using the manifest-loaded client check path', async () => {
    const client = new CometClient({
      command: 'comet',
      compatibility: loadCometCompatibility(),
      run: async () => '',
    });

    await expect(client.assertInstalledVersion('1.1.9')).rejects.toThrow(/outside compatibility range/);
    await expect(client.assertInstalledVersion('2.0.1')).rejects.toThrow(/outside compatibility range/);
    await expect(client.assertInstalledVersion('1.5.0')).resolves.toBeUndefined();
  });

  it('keeps the compatibility boundary free of private or internal import paths', async () => {
    const modules = await Promise.all([
      import('../../src/comet/compat.js'),
      import('../../src/comet/client.js'),
      import('../../src/comet/guard.js'),
    ]);
    expect(JSON.stringify(modules)).not.toMatch(/(?:private|internal)/i);
  });

  it('builds Comet global install commands with npm instead of project lockfile package managers', async () => {
    const install = await import('../../src/comet/install.js') as {
      buildCometInstallInvocation?: (version?: string) => { command: string; args: string[] };
      buildCometProjectInitInvocation?: (input: { root: string; scope: 'project' | 'global'; language?: 'en' | 'zh'; yes?: boolean }) => { command: string; args: string[] };
    };

    expect(install.buildCometInstallInvocation?.()).toEqual({
      command: 'npm',
      args: ['install', '-g', '@rpamis/comet'],
    });
    expect(install.buildCometInstallInvocation?.('0.4.0-beta.3')).toEqual({
      command: 'npm',
      args: ['install', '-g', '@rpamis/comet@0.4.0-beta.3'],
    });
    expect(install.buildCometProjectInitInvocation?.({ root: '/app', scope: 'project', language: 'zh', yes: true })).toEqual({
      command: 'comet',
      args: ['init', '/app', '--scope', 'project', '--language', 'zh', '--yes', '--json'],
    });
    expect(install.buildCometProjectInitInvocation?.({ root: '/app', scope: 'project', language: 'zh', yes: false })).toEqual({
      command: 'comet',
      args: ['init', '/app', '--scope', 'project', '--language', 'zh'],
    });
  });
});
