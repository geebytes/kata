import { readFileSync } from 'node:fs';
import bundledCompatYaml from 'kata-asset:comet-compat.yaml';

export interface CometCompatibility {
  minVersion: string;
  maxVersion?: string;
  capabilities: Record<string, boolean>;
}

export function loadCometCompatibility(manifestPath?: string): CometCompatibility {
  const manifest = manifestPath ? readFileSync(manifestPath, 'utf8') : bundledCompatYaml;
  const cometBlock = readIndentedBlock(manifest, 'comet');
  const capabilitiesBlock = readIndentedBlock(manifest, 'capabilities');
  const minVersion = readScalar(cometBlock, 'minVersion');
  const maxVersion = readOptionalScalar(cometBlock, 'maxVersion');
  const capabilities: Record<string, boolean> = {};

  for (const line of capabilitiesBlock.split('\n')) {
    const match = /^\s{4}([A-Za-z0-9_-]+):\s*(true|false)\s*$/.exec(line);
    if (match) capabilities[match[1]] = match[2] === 'true';
  }

  if (!minVersion) throw new Error('comet-compat.yaml must declare comet.minVersion');
  if (Object.keys(capabilities).length === 0) {
    throw new Error('comet-compat.yaml must declare at least one comet capability');
  }

  return {
    minVersion,
    ...(maxVersion ? { maxVersion } : {}),
    capabilities,
  };
}

function parseVersion(version: string): [number, number, number] {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version.trim());
  if (!match) throw new Error(`Invalid Comet version: ${version}`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compare(a: [number, number, number], b: [number, number, number]): number {
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

export function assertCometVersion(version: string, compatibility: CometCompatibility): void {
  const actual = parseVersion(version);
  const min = parseVersion(compatibility.minVersion);
  const max = compatibility.maxVersion ? parseVersion(compatibility.maxVersion) : undefined;
  if (compare(actual, min) < 0 || (max && compare(actual, max) > 0)) {
    const range = max ? `${compatibility.minVersion}–${compatibility.maxVersion}` : `>=${compatibility.minVersion}`;
    throw new Error(`Comet version ${version} is outside compatibility range ${range}`);
  }
}

export function assertCapability(compatibility: CometCompatibility, capability: string): void {
  if (!compatibility.capabilities[capability]) {
    throw new Error(`Comet capability is not available: ${capability}`);
  }
}

function readIndentedBlock(manifest: string, key: string): string {
  const lines = manifest.split('\n');
  const start = lines.findIndex((line) => line === `${key}:` || line.trim() === `${key}:`);
  if (start === -1) throw new Error(`comet-compat.yaml is missing ${key} block`);
  const parentIndent = lines[start].match(/^ */)?.[0].length ?? 0;
  const block: string[] = [];

  for (const line of lines.slice(start + 1)) {
    if (!line.trim()) {
      block.push(line);
      continue;
    }
    const indent = line.match(/^ */)?.[0].length ?? 0;
    if (indent <= parentIndent) break;
    block.push(line);
  }

  return block.join('\n');
}

function readScalar(block: string, key: string): string {
  const value = readOptionalScalar(block, key);
  if (!value) throw new Error(`comet-compat.yaml is missing ${key}`);
  return value;
}

function readOptionalScalar(block: string, key: string): string | undefined {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`^\\s+${escapedKey}:\\s*([^#\\n]+?)\\s*$`, 'm').exec(block);
  return match?.[1]?.replace(/^['"]|['"]$/g, '');
}
