import { execFile, spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { loadCometCompatibility, assertCometVersion, flagSpecFor, isFlagSupported, type CometCompatibility } from './compat.js';

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
    platforms?: string[];
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
    /**
     * User-supplied extra options to forward to comet. Each entry is validated
     * against the running comet's compatibility manifest — unsupported / unknown
     * flags are silently dropped so kata never emits an argv comet rejects.
     */
    extras?: Record<string, string | boolean | string[] | undefined>;
    /** Compatibility manifest (v2). Used to filter unsupported flags. */
    compat?: CometCompatibility;
    /** Currently installed comet version, used to filter flags by minSince/maxRemovedIn. */
    cometVersion?: string | null;
}): { command: string; args: string[] } {
    const args: string[] = [
        'init',
        input.root,
        '--scope',
        input.scope,
        ...(input.language ? ['--language', input.language] : []),
    ];

    const extras = filterSupportedFlags(
        input.extras ?? {},
        input.compat,
        input.scope,
        input.cometVersion ?? undefined,
    );
    for (const [flagName, value] of Object.entries(extras)) {
        args.push(...serializeFlag(flagName, value));
    }

    if (input.yes) args.push('--yes', '--json');
    return { command: 'comet', args };
}

/**
 * Drop flags that this comet version does not accept (unknown / preview /
 * scope-gated / conflicting / not-yet-available / removed-in). Remaining
 * flags are sorted into a stable order to make the resulting argv
 * deterministic and easy to assert against in tests.
 */
function filterSupportedFlags(
    extras: Record<string, string | boolean | string[] | undefined>,
    compat: CometCompatibility | undefined,
    scope: 'project' | 'global',
    cometVersion: string | undefined,
): Record<string, string | boolean | string[]> {
    if (!compat) {
        // Without a compat manifest we cannot validate; pass through as-is
        // to preserve the previously hard-coded behaviour.
        return stripUndefined(extras);
    }
    const filtered: Record<string, string | boolean | string[]> = {};

    for (const [flagName, value] of Object.entries(extras)) {
        if (value === undefined || value === false) continue;
        const spec = flagSpecFor(compat, 'init', flagName);
        if (!spec) continue;                                  // unknown flag
        if (spec.preview) continue;                            // reserved for future
        if (spec.scopeGuard && spec.scopeGuard !== scope) continue;
        if (cometVersion && !isFlagSupported(compat, 'init', flagName, cometVersion)) {
            continue;
        }
        // Resolve conflicts: if another already-passed flag conflicts, drop this one.
        if (spec.conflictsWith?.some((c) => filtered[c] !== undefined)) continue;
        if (spec.choices && typeof value === 'string' && !spec.choices.includes(value)) continue;
        if (spec.itemChoices && Array.isArray(value) && value.some((v) => !spec.itemChoices!.includes(v))) {
            continue;
        }
        // After filtering, value cannot be false / undefined here.
        filtered[flagName] = value as string | boolean | string[];
    }
    return filtered;
}

function stripUndefined(
    extras: Record<string, string | boolean | string[] | undefined>,
): Record<string, string | boolean | string[]> {
    const out: Record<string, string | boolean | string[]> = {};
    for (const [k, v] of Object.entries(extras)) {
        if (v === undefined || v === false) continue;
        out[k] = v as string | boolean | string[];
    }
    return out;
}

function serializeFlag(flagName: string, value: string | boolean | string[]): string[] {
    const cliFlag = `--${flagName.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)}`;
    if (value === true) return [cliFlag];
    if (Array.isArray(value)) return [cliFlag, value.join(',')];
    if (typeof value === 'string') return [cliFlag, value];
    // value === false is filtered upstream; defensively emit bare flag.
    return [cliFlag];
}

export async function initCometProject(input: {
    root: string;
    scope: 'project' | 'global';
    language?: 'en' | 'zh';
    yes?: boolean;
    /**
     * Explicit platform targets picked in the STRATA wizard. Comet's CLI only
     * accepts a single `--platform <id>`, so each platform gets its own
     * `comet init` invocation and the results are merged. When omitted, a
     * single invocation runs without `--platform` (comet decides itself).
     */
    platforms?: string[];
    extras?: Record<string, string | boolean | string[] | undefined>;
    compat?: CometCompatibility;
    cometVersion?: string | null;
}): Promise<CometProjectInitResult> {
    const binaryPath = await resolveCometPath();

    // Auto-install comet binary if not found
    if (!binaryPath) {
        try {
            await installComet();
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

    const resolvedBinary = await resolveCometPath();
    if (!resolvedBinary) {
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

    // Comet 0.4.x only accepts one --platform per invocation. The wizard may
    // have picked several, so run one init per platform and merge the reports.
    const targets = input.platforms && input.platforms.length > 0 ? input.platforms : [undefined];
    const results: CometProjectInitResult[] = [];
    for (const platform of targets) {
        const perPlatform = await runCometInitOnce(resolvedBinary, {
            ...input,
            extras: platform ? { ...(input.extras ?? {}), platform } : input.extras,
        });
        results.push(perPlatform);
        if (perPlatform.status === 'failed') break;
    }
    const merged = mergeCometInitResults(results, input.root, input.scope, input.language);
    return targets.some((t) => t !== undefined) ? { ...merged, platforms: targets.filter((t): t is string => t !== undefined) } : merged;
}

async function runCometInitOnce(
    binaryPath: string,
    input: {
        root: string;
        scope: 'project' | 'global';
        language?: 'en' | 'zh';
        yes?: boolean;
        extras?: Record<string, string | boolean | string[] | undefined>;
        compat?: CometCompatibility;
        cometVersion?: string | null;
    },
): Promise<CometProjectInitResult> {
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
            const child = spawn(binaryPath, invocation.args, {
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

function mergeCometInitResults(
    results: CometProjectInitResult[],
    root: string,
    scope: 'project' | 'global',
    language?: 'en' | 'zh',
): CometProjectInitResult {
    const failed = results.find((result) => result.status === 'failed');
    const skipped = results.find((result) => result.status === 'skipped');
    const status = failed?.status ?? skipped?.status ?? 'initialized';
    return {
        command: 'comet init',
        status,
        path: results.find((result) => result.path !== null)?.path ?? null,
        root,
        scope,
        ...(language ? { language } : {}),
        ...(results.find((result) => result.stdout)?.stdout ? { stdout: results.map((r) => r.stdout ?? '').filter(Boolean).join('\n') } : {}),
        ...(failed?.reason ? { reason: failed.reason } : skipped?.reason ? { reason: skipped.reason } : {}),
    };
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
