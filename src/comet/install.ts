import { execFile, spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { loadCometCompatibility, assertCometVersion } from './compat.js';

const execFileAsync = promisify(execFile);

export type CometInstallResult = {
  command: string;
  previousVersion: string | null;
  installedVersion: string;
  method: 'npm' | 'detected';
  path: string;
  compatUpdated: boolean;
};

export type CometVersionResult = {
  version: string | null;
  path: string | null;
  compatible: boolean;
};

export type CometPathResult = {
  path: string | null;
  method: 'npm-global' | 'path' | 'not-found';
};

export type CometVerifyResult = {
  exists: boolean;
  executable: boolean;
  version: string | null;
  compatible: boolean;
  path: string | null;
};

export type CometProjectInitResult = {
  command: 'comet init';
  status: 'initialized' | 'skipped' | 'failed';
  path: string | null;
  root: string;
  scope: 'project' | 'global';
  language?: 'en' | 'zh';
  stdout?: string;
  reason?: string;
};

function npmPackageName(): string {
  return '@rpamis/comet';
}

async function resolveCommandPath(command: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('which', [command], { encoding: 'utf8' });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

export async function resolveCometPath(): Promise<string | null> {
  return resolveCommandPath('comet');
}

async function runNpm(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('npm', args, { encoding: 'utf8' });
  return stdout.trim();
}

export function buildCometInstallInvocation(version?: string): { command: string; args: string[] } {
  const targetVersion = version ?? 'latest';
  const spec = targetVersion === 'latest' ? npmPackageName() : `${npmPackageName()}@${targetVersion}`;
  return { command: 'npm', args: ['install', '-g', spec] };
}

export function buildCometProjectInitInvocation(input: {
  root: string;
  scope: 'project' | 'global';
  language?: 'en' | 'zh';
  yes?: boolean;
}): { command: string; args: string[] } {
  return {
    command: 'comet',
    args: [
      'init',
      input.root,
      '--scope',
      input.scope,
      ...(input.language ? ['--language', input.language] : []),
      ...(input.yes ? ['--yes', '--json'] : []),
    ],
  };
}

export async function initCometProject(input: {
  root: string;
  scope: 'project' | 'global';
  language?: 'en' | 'zh';
  yes?: boolean;
}): Promise<CometProjectInitResult> {
  let binaryPath = await resolveCometPath();

  // Auto-install comet binary if not found
  if (!binaryPath) {
    try {
      await installComet();
      binaryPath = await resolveCometPath();
    } catch {
      return {
        command: 'comet init',
        status: 'skipped',
        path: null,
        root: input.root,
        scope: input.scope,
        ...(input.language ? { language: input.language } : {}),
        reason: 'comet_binary_install_failed',
      };
    }
  }

  if (!binaryPath) {
    return {
      command: 'comet init',
      status: 'skipped',
      path: null,
      root: input.root,
      scope: input.scope,
      ...(input.language ? { language: input.language } : {}),
      reason: 'comet_binary_not_found',
    };
  }

  const invocation = buildCometProjectInitInvocation(input);

  if (input.yes) {
    // Non-interactive: capture output
    try {
      const { stdout } = await execFileAsync(binaryPath, invocation.args, { encoding: 'utf8' });
      return {
        command: 'comet init',
        status: 'initialized',
        path: binaryPath,
        root: input.root,
        scope: input.scope,
        ...(input.language ? { language: input.language } : {}),
        stdout: stdout.trim(),
      };
    } catch (error) {
      return {
        command: 'comet init',
        status: 'failed',
        path: binaryPath,
        root: input.root,
        scope: input.scope,
        ...(input.language ? { language: input.language } : {}),
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }

  // Interactive: passthrough stdio so user sees comet prompts
  try {
    await new Promise<void>((resolvePromise, reject) => {
      const child = spawn(binaryPath!, invocation.args, {
        stdio: 'inherit',
        env: { ...process.env },
      });
      child.on('exit', (code) => {
        if (code === 0) resolvePromise();
        else reject(new Error(`comet init exited with code ${code}`));
      });
      child.on('error', reject);
    });
    return {
      command: 'comet init',
      status: 'initialized',
      path: binaryPath,
      root: input.root,
      scope: input.scope,
      ...(input.language ? { language: input.language } : {}),
    };
  } catch (error) {
    return {
      command: 'comet init',
      status: 'failed',
      path: binaryPath,
      root: input.root,
      scope: input.scope,
      ...(input.language ? { language: input.language } : {}),
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function getCometVersion(binaryPath?: string): Promise<string | null> {
  try {
    const cmd = binaryPath ?? 'comet';
    const { stdout } = await execFileAsync(cmd, ['--version'], { encoding: 'utf8' });
    const match = stdout.trim().match(/(\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.]+)?)/);
    return (match?.[1] ?? stdout.trim()) || null;
  } catch {
    return null;
  }
}

export async function fetchLatestNpmVersion(): Promise<string | null> {
  try {
    const output = await runNpm(['view', npmPackageName(), 'version']);
    return output || null;
  } catch {
    return null;
  }
}

export async function installComet(version?: string): Promise<CometInstallResult> {
  const previousVersion = await getCometVersion();
  const invocation = buildCometInstallInvocation(version);

  await runNpm(invocation.args);

  const installedVersion = await getCometVersion();
  if (!installedVersion) {
    throw new Error('Comet installation failed: binary not found after npm install');
  }

  const binaryPath = await resolveCometPath();
  const compatibility = loadCometCompatibility();
  let compatUpdated = false;

  try {
    assertCometVersion(installedVersion, compatibility);
  } catch {
    updateCometCompatibility(installedVersion);
    compatUpdated = true;
  }

  return {
    command: 'install',
    previousVersion,
    installedVersion,
    method: 'npm',
    path: binaryPath ?? 'comet',
    compatUpdated,
  };
}

export async function updateComet(): Promise<CometInstallResult> {
  const latest = await fetchLatestNpmVersion();
  if (!latest) {
    throw new Error('Could not fetch latest Comet version from npm');
  }

  const current = await getCometVersion();
  if (current === latest) {
    return {
      command: 'update',
      previousVersion: current,
      installedVersion: current,
      method: 'detected',
      path: (await resolveCometPath()) ?? 'comet',
      compatUpdated: false,
    };
  }

  return installComet(latest);
}

export async function verifyComet(): Promise<CometVerifyResult> {
  const binaryPath = await resolveCometPath();
  const exists = binaryPath !== null;
  const executable = exists
    ? (() => {
        try {
          const stats = existsSync(binaryPath!);
          return stats;
        } catch {
          return false;
        }
      })()
    : false;

  const version = exists ? await getCometVersion(binaryPath!) : null;

  let compatible = false;
  if (version) {
    try {
      const compatibility = loadCometCompatibility();
      assertCometVersion(version, compatibility);
      compatible = true;
    } catch {
      compatible = false;
    }
  }

  return {
    exists,
    executable,
    version,
    compatible,
    path: binaryPath,
  };
}

export function cometVersion(): CometVersionResult {
  try {
    const compatibility = loadCometCompatibility();
    return {
      version: compatibility.minVersion,
      path: null,
      compatible: true,
    };
  } catch {
    return { version: null, path: null, compatible: false };
  }
}

export function readCometCompatibility(): { minVersion: string; maxVersion?: string } {
  const compat = loadCometCompatibility();
  return {
    minVersion: compat.minVersion,
    ...(compat.maxVersion ? { maxVersion: compat.maxVersion } : {}),
  };
}

function updateCometCompatibility(version: string): void {
  const manifestPath = new URL('../../comet-compat.yaml', import.meta.url);
  const content = readFileSync(manifestPath, 'utf8');

  const lines = content.split('\n');
  let minUpdated = false;
  let maxUpdated = false;
  const updated = lines.map((line) => {
    const minMatch = /^(\s*minVersion:\s*).+/.exec(line);
    if (minMatch) {
      minUpdated = true;
      return `${minMatch[1]}${version}`;
    }
    const maxMatch = /^(\s*maxVersion:\s*).+/.exec(line);
    if (maxMatch) {
      maxUpdated = true;
      return `${maxMatch[1]}${version}`;
    }
    return line;
  });

  if (!minUpdated) {
    throw new Error('Could not find minVersion in comet-compat.yaml');
  }

  const newContent = updated.join('\n');
  writeFileSync(manifestPath, newContent, 'utf8');
}
