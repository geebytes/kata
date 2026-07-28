import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import bundledCompatYaml from 'kata-asset:comet-compat.yaml';

// =============================================================================
// Public types
// =============================================================================

export interface FlagSpec {
    type: 'boolean' | 'enum' | 'string' | 'list';
    choices?: string[];             // for enum
    itemChoices?: string[];         // for list<enum>
    minSince?: string;
    maxRemovedIn?: string;
    conflictsWith?: string[];
    aliases?: string[];
    default?: string | string[] | boolean;
    scopeGuard?: 'project' | 'global';
    preview?: boolean;
    prompt?: { messageKey?: string; messageEn?: string; messageZh?: string };
}

export type CapabilityMap = Record<string, { minSince?: string } | true>;

export interface BreakingChange {
    version: string;
    field: string;
    before?: string;
    after?: string;
    mitigation?: { kataShouldPass?: string; note?: string };
}

export interface CometCompatibility {
    version: number;                 // compat schema version
    minVersion: string;
    maxVersion?: string;
    capabilities: CapabilityMap;
    flags?: Record<string, Record<string, FlagSpec>>;
    output?: Record<string, { fields?: string[]; stableFields?: string[]; schemaUrl?: string }>;
    breakingChanges?: BreakingChange[];
    unknownFieldsHandled?: boolean;  // true if upstream returned fields we don't model
    source: 'runtime' | 'comet-package' | 'kata-bundled' | 'fallback';
}

// =============================================================================
// Synchronous loader (backward-compatible with v1 callers)
// =============================================================================

export function loadCometCompatibility(manifestPath?: string): CometCompatibility {
    const raw = manifestPath ? readFileSync(manifestPath, 'utf8') : bundledCompatYaml;
    return parseCompatYaml(raw, 'kata-bundled');
}

// =============================================================================
// Async multi-layer loader
// =============================================================================

export async function loadCometCompatibilityAsync(
    options: { cometBinary?: string; cometPackageRoot?: string; timeoutMs?: number } = {},
): Promise<CometCompatibility> {
    // Layer 1: comet runtime probe — always freshest.
    const runtime = await probeRuntimeCompat(options.cometBinary, options.timeoutMs);
    if (runtime) return runtime;

    // Layer 2: @rpamis/comet package root yaml
    const pkgYaml = await readCometPackageYaml(options.cometPackageRoot);
    if (pkgYaml) return pkgYaml;

    // Layer 3: kata bundled fallback (synchronous read of the bundled asset).
    return parseCompatYaml(bundledCompatYaml, 'kata-bundled');
}

async function probeRuntimeCompat(
    binary?: string,
    timeoutMs = 2000,
): Promise<CometCompatibility | null> {
    const cmd = binary ?? 'comet';
    if (!isCommandAvailable(cmd)) return null;
    try {
        const stdout = execFileSync(cmd, ['compat', '--json'], {
            encoding: 'utf8',
            timeout: timeoutMs,
            stdio: ['ignore', 'pipe', 'ignore'],
        });
        return parseCompatYaml(stdout, 'runtime');
    } catch {
        // Older comet does not implement `comet compat` — fall through silently.
        return null;
    }
}

function isCommandAvailable(cmd: string): boolean {
    try {
        execFileSync('which', [cmd], { stdio: ['ignore', 'pipe', 'ignore'] });
        return true;
    } catch {
        return false;
    }
}

async function readCometPackageYaml(
    packageRootHint?: string,
): Promise<CometCompatibility | null> {
    // Try to locate @rpamis/comet via node module resolution.
    const candidates: string[] = [];
    if (packageRootHint) candidates.push(join(packageRootHint, 'comet-compat.yaml'));

    // Resolve via Node's require resolution if available.
    for (const candidate of [...candidates, ...resolveCometPackageCandidates()]) {
        if (candidate && existsSync(candidate)) {
            try {
                const raw = readFileSync(candidate, 'utf8');
                return parseCompatYaml(raw, 'comet-package');
            } catch {
                // ignore — try next candidate
            }
        }
    }
    return null;
}

function resolveCometPackageCandidates(): string[] {
    const candidates: string[] = [];
    // From the global npm root.
    try {
        const npmRoot = execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim();
        candidates.push(join(npmRoot, '@rpamis', 'comet', 'comet-compat.yaml'));
    } catch { /* npm not available */ }

    // Relative to this module (when @rpamis/comet is symlinked/linked).
    try {
        const here = dirname(fileURLToPath(import.meta.url));
        candidates.push(resolve(here, '..', '..', '..', 'comet-compat.yaml'));
        candidates.push(resolve(here, '..', '..', '..', '@rpamis', 'comet', 'comet-compat.yaml'));
    } catch { /* import.meta.url resolution not available */ }
    return candidates;
}

// =============================================================================
// YAML parser (minimal, additive, supports v1 + v2 schema)
// =============================================================================

export function parseCompatYaml(raw: string, source: CometCompatibility['source']): CometCompatibility {
    const version = detectSchemaVersion(raw);

    if (version === 1) return upgradeV1ToV2(parseV1(raw), source);
    if (version === 2) return parseV2(raw, source);
    if (version > 2) {
        // Forward-compatible: parse as v2 and flag unknown fields tolerated.
        const parsed = parseV2(raw, source);
        parsed.unknownFieldsHandled = true;
        return parsed;
    }
    throw new Error(`Unsupported comet-compat schema version: ${version}`);
}

function detectSchemaVersion(raw: string): number {
    const match = /^version:\s*(\d+)/m.exec(raw);
    const v = match ? Number(match[1]) : 1;
    return Number.isFinite(v) ? v : 1;
}

// ---- v1 parsing (backward-compat) ----------------------------------------

interface V1Compat {
    minVersion: string;
    maxVersion?: string;
    capabilities: CapabilityMap;
}

function parseV1(raw: string): V1Compat {
    const cometBlock = readIndentedBlock(raw, 'comet');
    const minVersion = readScalar(cometBlock, 'minVersion');
    const maxVersion = readOptionalScalar(cometBlock, 'maxVersion');
    const capabilitiesBlock = readIndentedBlock(cometBlock, 'capabilities');
    const capabilities: CapabilityMap = {};

    for (const line of capabilitiesBlock.split('\n')) {
        const match = /^\s+([A-Za-z0-9_-]+):\s*(true|false)\s*$/.exec(line);
        if (match && match[2] === 'true') capabilities[match[1]] = true;
    }

    if (!minVersion) throw new Error('comet-compat.yaml must declare comet.minVersion');
    if (Object.keys(capabilities).length === 0) {
        throw new Error('comet-compat.yaml must declare at least one comet capability');
    }
    return { minVersion, ...(maxVersion ? { maxVersion } : {}), capabilities };
}

function upgradeV1ToV2(v1: V1Compat, source: CometCompatibility['source']): CometCompatibility {
    return {
        version: 2,
        minVersion: v1.minVersion,
        ...(v1.maxVersion ? { maxVersion: v1.maxVersion } : {}),
        capabilities: v1.capabilities,
        source,
    };
}

// ---- v2 parsing -----------------------------------------------------------

function parseV2(raw: string, source: CometCompatibility['source']): CometCompatibility {
    const cometBlock = readIndentedBlock(raw, 'comet');
    if (!cometBlock) throw new Error('comet-compat.yaml is missing comet block');

    const minVersion = readScalar(cometBlock, 'minVersion');
    const maxVersion = readOptionalScalar(cometBlock, 'maxVersion');
    const capabilities = parseCapabilities(readIndentedBlock(cometBlock, 'capabilities'));
    const flags = parseFlags(readIndentedBlock(cometBlock, 'flags'));
    const output = parseOutput(readIndentedBlock(cometBlock, 'output'));

    if (!minVersion) throw new Error('comet-compat.yaml must declare comet.minVersion');
    if (Object.keys(capabilities).length === 0) {
        throw new Error('comet-compat.yaml must declare at least one comet capability');
    }

    const breakingChanges = parseBreakingChanges(raw);

    return {
        version: 2,
        minVersion,
        ...(maxVersion ? { maxVersion } : {}),
        capabilities,
        ...(flags ? { flags } : {}),
        ...(output ? { output } : {}),
        ...(breakingChanges.length > 0 ? { breakingChanges } : {}),
        source,
    };
}

function parseCapabilities(block: string): CapabilityMap {
    const capabilities: CapabilityMap = {};
    if (!block) return capabilities;
    for (const line of block.split('\n')) {
        const match = /^\s+([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
        if (!match) continue;
        const key = match[1]!;
        const value = match[2]!.trim();
        if (value === 'true') capabilities[key] = true;
        else if (value === 'false') continue;
        else if (value.startsWith('{')) {
            // Inline form: "init: { minSince: \"0.4.0\" }"
            const minSinceMatch = /minSince:\s*"?([^"}\s]+)"?/.exec(value);
            capabilities[key] = minSinceMatch ? { minSince: minSinceMatch[1] } : {};
        } else if (value === '') {
            // Multi-line form; read minSince on following indented lines
            const subBlock = extractSubBlock(block, key);
            const subMinSince = subBlock ? readOptionalScalar(subBlock, 'minSince') : undefined;
            capabilities[key] = subMinSince ? { minSince: subMinSince } : {};
        }
    }
    return capabilities;
}

function parseFlags(block: string): Record<string, Record<string, FlagSpec>> | undefined {
    if (!block) return undefined;
    const commands: Record<string, Record<string, FlagSpec>> = {};
    const commandNames = extractTopLevelKeys(block);
    for (const cmd of commandNames) {
        const cmdBlock = extractSubBlock(block, cmd);
        if (!cmdBlock) continue;
        const flagNames = extractTopLevelKeys(cmdBlock);
        const flagMap: Record<string, FlagSpec> = {};
        for (const flagName of flagNames) {
            const flagBlock = extractSubBlock(cmdBlock, flagName);
            if (flagBlock) {
                const spec = parseFlagSpec(flagBlock);
                if (spec) flagMap[flagName] = spec;
            }
        }
        if (Object.keys(flagMap).length > 0) commands[cmd] = flagMap;
    }
    return Object.keys(commands).length > 0 ? commands : undefined;
}

function parseFlagSpec(block: string): FlagSpec | null {
    const type = readOptionalScalar(block, 'type') as FlagSpec['type'] | undefined;
    if (!type) return null;
    const spec: FlagSpec = { type };

    const choices = readFlowList(block, 'choices');
    if (choices.length > 0) spec.choices = choices;

    const itemChoices = readFlowList(block, 'itemChoices');
    if (itemChoices.length > 0) spec.itemChoices = itemChoices;

    const minSince = readOptionalScalar(block, 'minSince');
    if (minSince) spec.minSince = minSince;

    const maxRemovedIn = readOptionalScalar(block, 'maxRemovedIn');
    if (maxRemovedIn) spec.maxRemovedIn = maxRemovedIn;

    const conflictsWith = readFlowList(block, 'conflictsWith');
    if (conflictsWith.length > 0) spec.conflictsWith = conflictsWith;

    const aliases = readFlowList(block, 'aliases');
    if (aliases.length > 0) spec.aliases = aliases;

    const def = readOptionalScalar(block, 'default');
    if (def !== undefined) {
        spec.default = def === 'true' ? true : def === 'false' ? false : def;
    }

    const scopeGuard = readOptionalScalar(block, 'scopeGuard');
    if (scopeGuard === 'project' || scopeGuard === 'global') spec.scopeGuard = scopeGuard;

    const preview = readOptionalScalar(block, 'preview');
    if (preview === 'true') spec.preview = true;

    const promptBlock = extractSubBlock(block, 'prompt');
    if (promptBlock) {
        const messageKey = readOptionalScalar(promptBlock, 'messageKey');
        const messageEn = readOptionalScalar(promptBlock, 'messageEn');
        const messageZh = readOptionalScalar(promptBlock, 'messageZh');
        const prompt: FlagSpec['prompt'] = {};
        if (messageKey) prompt.messageKey = messageKey;
        if (messageEn) prompt.messageEn = messageEn;
        if (messageZh) prompt.messageZh = messageZh;
        if (Object.keys(prompt).length > 0) spec.prompt = prompt;
    }
    return spec;
}

function parseOutput(block: string): CometCompatibility['output'] | undefined {
    if (!block) return undefined;
    const outputs: NonNullable<CometCompatibility['output']> = {};
    const outputNames = extractTopLevelKeys(block);
    for (const name of outputNames) {
        const outBlock = extractSubBlock(block, name);
        if (!outBlock) continue;
        const fields = readFlowList(outBlock, 'fields');
        const stableFields = readFlowList(outBlock, 'stableFields');
        const schemaUrl = readOptionalScalar(outBlock, 'schemaUrl');
        const entry: NonNullable<CometCompatibility['output']>[string] = {};
        if (fields.length > 0) entry.fields = fields;
        if (stableFields.length > 0) entry.stableFields = stableFields;
        if (schemaUrl) entry.schemaUrl = schemaUrl;
        if (Object.keys(entry).length > 0) outputs[name] = entry;
    }
    return Object.keys(outputs).length > 0 ? outputs : undefined;
}

function parseBreakingChanges(raw: string): BreakingChange[] {
    // Walk the raw YAML looking for the top-level `breakingChanges:` block.
    const lines = raw.split('\n');
    const startIdx = lines.findIndex((line) => /^breakingChanges:\s*$/.test(line));
    if (startIdx === -1) return [];
    const blockLines: string[] = [];
    for (const line of lines.slice(startIdx + 1)) {
        if (line.trim() === '') { blockLines.push(line); continue; }
        if (!/^[\s-]/.test(line) && line.length > 0) break;
        blockLines.push(line);
    }
    if (blockLines.length === 0) return [];

    // Each item begins with "  - " at the same indent; group lines per item.
    const items: string[] = [];
    let buffer: string[] = [];
    let inItem = false;
    for (const line of blockLines) {
        if (/^\s*-\s+/.test(line)) {
            if (inItem && buffer.length > 0) items.push(buffer.join('\n'));
            buffer = [line.replace(/^\s*-\s+/, '')];
            inItem = true;
        } else if (inItem && line.trim()) {
            buffer.push(line);
        }
    }
    if (inItem && buffer.length > 0) items.push(buffer.join('\n'));

    const changes: BreakingChange[] = [];
    for (const item of items) {
        const version = readOptionalScalar(item, 'version');
        const field = readOptionalScalar(item, 'field');
        if (!version || !field) continue;
        const before = readOptionalScalar(item, 'before');
        const after = readOptionalScalar(item, 'after');
        const mitigationBlock = extractSubBlock(item, 'mitigation');
        const mitigation: BreakingChange['mitigation'] = {};
        if (mitigationBlock) {
            const kataShouldPass = readOptionalScalar(mitigationBlock, 'kataShouldPass');
            const note = readOptionalScalar(mitigationBlock, 'note');
            if (kataShouldPass) mitigation.kataShouldPass = kataShouldPass;
            if (note) mitigation.note = note;
        }
        changes.push({
            version,
            field,
            ...(before ? { before } : {}),
            ...(after ? { after } : {}),
            ...(Object.keys(mitigation).length > 0 ? { mitigation } : {}),
        });
    }
    return changes;
}

// ---- YAML helpers ---------------------------------------------------------

function readIndentedBlock(manifest: string, key: string): string {
    const lines = manifest.split('\n');
    const start = lines.findIndex((line) => line === `${key}:` || line.trim() === `${key}:`);
    if (start === -1) return '';
    const parentIndent = lines[start]!.match(/^ */)?.[0].length ?? 0;
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

function extractSubBlock(parent: string, key: string): string | null {
    const lines = parent.split('\n');
    const start = lines.findIndex((line) => line.trim() === `${key}:` || line.trim().startsWith(`${key}:`));
    if (start === -1) return null;
    const parentIndent = lines[start]!.match(/^ */)?.[0].length ?? 0;
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
    return block.length > 0 ? block.join('\n') : null;
}

function extractTopLevelKeys(block: string): string[] {
    if (!block) return [];
    const keys: string[] = [];
    const minIndent = Math.min(
        ...block.split('\n')
            .filter((l) => l.trim())
            .map((l) => l.match(/^ */)?.[0].length ?? 0),
    );
    for (const line of block.split('\n')) {
        if (!line.trim() || line.trim().startsWith('-')) continue;
        const indent = line.match(/^ */)?.[0].length ?? 0;
        if (indent === minIndent) {
            const match = /^ *([A-Za-z0-9_.-]+):/.exec(line);
            if (match) keys.push(match[1]!);
        }
    }
    return keys;
}

function readScalar(block: string, key: string): string {
    const value = readOptionalScalar(block, key);
    if (!value) throw new Error(`comet-compat.yaml is missing ${key}`);
    return value;
}

function readOptionalScalar(block: string, key: string): string | undefined {
    const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = new RegExp(`^[ \\t]*${escapedKey}:\\s*([^#\\n]+?)\\s*$`, 'm').exec(block);
    return match?.[1]?.replace(/^['"]|['"]$/g, '');
}

function readFlowList(block: string, key: string): string[] {
    const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Flow form:  key: [a, b, c]
    const flowMatch = new RegExp(`^\\s+${escapedKey}:\\s*\\[([^\\]]*)\\]`, 'm').exec(block);
    if (flowMatch) {
        return flowMatch[1]!
            .split(',')
            .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
            .filter(Boolean);
    }
    // Block form: key:\n      - a\n      - b
    const blockStart = new RegExp(`^(\\s+)${escapedKey}:\\s*$`, 'm').exec(block);
    if (blockStart) {
        const itemIndent = blockStart[1]!.length + 2;
        const items: string[] = [];
        const lines = block.split('\n');
        const startIdx = lines.findIndex((l) => new RegExp(`^\\s+${escapedKey}:\\s*$`).test(l));
        if (startIdx === -1) return [];
        for (const line of lines.slice(startIdx + 1)) {
            if (!line.trim()) continue;
            const indent = line.match(/^ */)?.[0].length ?? 0;
            if (indent < itemIndent) break;
            const m = /^\s+-\s+(.+?)\s*$/.exec(line);
            if (m) items.push(m[1]!.replace(/^['"]|['"]$/g, ''));
        }
        return items;
    }
    return [];
}

// =============================================================================
// Version / capability checks
// =============================================================================

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

// =============================================================================
// Flag-level helpers (data-driven passthrough support)
// =============================================================================

export function flagSpecFor(
    compatibility: CometCompatibility,
    command: string,
    flagName: string,
): FlagSpec | undefined {
    return compatibility.flags?.[command]?.[flagName];
}

export function isFlagSupported(
    compatibility: CometCompatibility,
    command: string,
    flagName: string,
    cometVersion?: string,
): boolean {
    const spec = flagSpecFor(compatibility, command, flagName);
    if (!spec) return false;
    if (spec.preview) return false;  // preview flags require explicit confirmation
    if (cometVersion && spec.minSince && compare(parseVersion(cometVersion), parseVersion(spec.minSince)) < 0) {
        return false;
    }
    if (cometVersion && spec.maxRemovedIn && compare(parseVersion(cometVersion), parseVersion(spec.maxRemovedIn)) >= 0) {
        return false;
    }
    return true;
}

export function isBreakingChangeApplicable(
    compatibility: CometCompatibility,
    version: string,
): BreakingChange[] {
    if (!compatibility.breakingChanges) return [];
    const actual = parseVersion(version);
    return compatibility.breakingChanges.filter((change) => compare(actual, parseVersion(change.version)) >= 0);
}

// =============================================================================
// Version primitives
// =============================================================================

function parseVersion(version: string): [number, number, number] {
    const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version.trim());
    if (!match) throw new Error(`Invalid Comet version: ${version}`);
    return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compare(a: [number, number, number], b: [number, number, number]): number {
    for (let i = 0; i < 3; i += 1) {
        if (a[i] !== b[i]) return a[i]! - b[i]!;
    }
    return 0;
}
