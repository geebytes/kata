import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { assertCapability, assertCometVersion, loadCometCompatibility, type CometCompatibility } from './compat.js';

const execFileAsync = promisify(execFile);

interface CometStatus {
  phase: string;
  [key: string]: unknown;
}

interface CometNext {
  next: string;
  [key: string]: unknown;
}

type CommandRunner = (command: string, args: readonly string[]) => Promise<string>;

export interface InitOptions {
  language?: 'en' | 'zh';
}

export interface CometClientOptions {
  command?: string;
  compatibility?: CometCompatibility;
  run?: CommandRunner;
}

async function runPublicCommand(command: string, args: readonly string[]): Promise<string> {
  const result = await execFileAsync(command, [...args], { encoding: 'utf8' });
  return result.stdout;
}

export class CometClient {
  private readonly command: string;
  private readonly compatibility: CometCompatibility;
  private readonly run: CommandRunner;

  constructor(options: CometClientOptions) {
    this.command = options.command ?? 'comet';
    this.compatibility = options.compatibility ?? loadCometCompatibility();
    this.run = options.run ?? runPublicCommand;
  }

  async assertInstalledVersion(version: string): Promise<void> {
    assertCometVersion(version, this.compatibility);
  }

  async init(change: string, options?: InitOptions): Promise<void> {
    assertCapability(this.compatibility, 'init');
    const args: string[] = ['init', change, '--json'];
    if (options?.language) args.push('--language', options.language);
    args.push('--yes');
    await this.run(this.command, args);
  }

  async status(change: string): Promise<CometStatus> {
    assertCapability(this.compatibility, 'status');
    return this.parseJson<CometStatus>(await this.run(this.command, ['status', change, '--json']), 'status');
  }

  async next(change: string): Promise<CometNext> {
    assertCapability(this.compatibility, 'next');
    return this.parseJson<CometNext>(await this.run(this.command, ['next', change, '--json']), 'next');
  }

  private parseJson<T>(output: string, operation: string): T {
    try {
      return JSON.parse(output) as T;
    } catch {
      throw new Error(`Comet ${operation} returned invalid JSON`);
    }
  }
}

export type { CometCompatibility } from './compat.js';
