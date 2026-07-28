import { stdin as defaultInput, stdout as defaultOutput } from 'node:process';
import type { Readable } from 'node:stream';
import type { Writable } from 'node:stream';
import type { InstallOptions, InstallReport, InstallScope, Platform, PlatformInfo } from './adapters/manifest.js';
import { platformDefinitions } from './adapters/platforms.js';
import { checkbox, select } from './cli/prompt.js';
import type { CometCompatibility, FlagSpec } from './comet/compat.js';

/**
 * User choices collected for forwarding to {@link buildCometProjectInitInvocation}.
 * Each entry corresponds to a flag in `compat.flags.init.*`.
 */
export type CometExtraOptions = Record<string, string | boolean | string[] | undefined>;

export interface InitPlan {
    scope: InstallScope;
    selected: PlatformInfo[];
    detected: PlatformInfo[];
    language: 'en' | 'zh';
}

export interface InitWizardIo {
    input?: Readable;
    output?: Writable;
    projectRoot?: string;
    home?: string;
}

const supportedPlatforms: Platform[] = platformDefinitions
    .map((platform) => platform.id)
    .filter((platform): platform is Platform => platform !== 'generic');

export function renderInitBanner(): string {
    return [
        '███████╗████████╗██████╗  █████╗ ████████╗ █████╗',
        '██╔════╝╚══██╔══╝██╔══██╗██╔══██╗╚══██╔══╝██╔══██╗',
        '███████╗   ██║   ██████╔╝███████║   ██║   ███████║',
        '╚════██║   ██║   ██╔══██╗██╔══██║   ██║   ██╔══██║',
        '███████║   ██║   ██║  ██║██║  ██║   ██║   ██║  ██║',
        '╚══════╝   ╚═╝   ╚═╝  ╚═╝╚═╝  ╚═╝   ╚═╝   ╚═╝  ╚═╝',
        '',
        'STRATA',
        'Knowledge and Rule Sedimentation for Agentic Coding',
    ].join('\n');
}

export function planDetectedInit(platforms: PlatformInfo[], settings: { scope?: InstallScope; language?: 'en' | 'zh' } = {}): InitPlan {
    const scope = settings.scope ?? 'project';
    const detected = platforms.filter((platform) => platform.scope === scope);
    const selected = detected.filter((platform) => supportedPlatforms.includes(platform.platform));
    return {
        scope,
        language: settings.language ?? 'zh',
        detected,
        selected: selected.length > 0 ? selected : detected.filter((platform) => platform.platform === 'generic'),
    };
}

export function mergeInstallReports(input: {
    command: 'init' | 'update';
    mode: 'auto' | 'interactive';
    scope: InstallScope;
    reports: InstallReport[];
}): Record<string, unknown> {
    return {
        command: input.command,
        mode: input.mode,
        scope: input.scope,
        selectedPlatforms: input.reports.map((report) => report.platform),
        reports: input.reports.map((report) => ({
            platform: report.platform,
            scope: report.scope,
            summary: {
                written: report.written.length,
                unchanged: report.unchanged.length,
                conflicts: report.conflicts.length,
                removed: report.removed.length,
                dryRun: report.dryRun,
            },
            wiki: report.wiki,
        })),
    };
}

export async function promptInitPlan(platforms: PlatformInfo[], io: InitWizardIo = {}): Promise<InitPlan> {
    const input = io.input ?? defaultInput;
    const output = io.output ?? defaultOutput;
    output.write(`${renderInitBanner()}\n\n`);
    const language = await select<'en' | 'zh'>('Language for skills', [
        { value: 'en', label: 'English' },
        { value: 'zh', label: '中文' },
    ], { input, output });
    const scope = await select<InstallScope>('Install scope', [
        { value: 'project', label: 'Project' },
        { value: 'global', label: 'Global' },
    ], { input, output });

    // discoverPlatforms only returns platforms whose markers already exist on disk;
    // on first install (especially global scope) that list is empty, leaving the
    // user with no selectable targets. Synthesize installable candidates from the
    // platform definitions so the wizard always offers at least the supported set.
    const baseCandidates = platforms.filter((platform) => platform.scope === scope);
    const seenKeys = new Set(baseCandidates.map((p) => `${p.platform}:${p.root}`));
    const installDirectory = scope === 'project' ? (io.projectRoot ?? process.cwd()) : (io.home ?? process.env.HOME ?? process.cwd());
    const synthesized = supportedPlatforms
        .filter((platformId) => !seenKeys.has(`${platformId}:${installDirectory}`))
        .map((platformId) => {
            const definition = platformDefinitions.find((p) => p.id === platformId);
            const capabilities = definition?.capabilities ?? { skills: true, hooks: false, subAgents: false, modelSelection: false };
            return {
                platform: platformId,
                scope,
                detected: false,
                root: installDirectory,
                capabilities,
                unavailable: Object.entries(capabilities)
                    .filter(([, supported]) => !supported)
                    .map(([capability]) => capability),
            } satisfies PlatformInfo;
        });
    const candidates = [...baseCandidates, ...synthesized];
    // Default-checked platforms: only those actually detected on disk.
    // Synthesized candidates (detected === false) start unchecked so that the
    // wizard never silently installs platforms the user has not opted into.
    const defaults = candidates.filter((platform) => platform.detected && supportedPlatforms.includes(platform.platform));

    const selected = await checkbox<PlatformInfo>('Platforms to install', candidates.map((p) => ({
        value: p,
        label: `${p.platform} (${p.root})${p.detected ? '' : ' · not yet installed'}`,
        checked: defaults.includes(p),
    })), { input, output });

    return { scope, language, detected: candidates, selected };
}

export function optionsForWizardInstall(
    base: InstallOptions,
    scope: InstallScope,
    platformRoot: string,
    language?: 'en' | 'zh',
): InstallOptions {
    return {
        ...base,
        ...(language ? { language } : {}),
        ...(scope === 'project' ? { root: platformRoot } : { home: platformRoot }),
    };
}

/**
 * Collect user choices for the comet init flags declared in the compatibility
 * manifest. The wizard never hard-codes which flags to ask about — it walks
 * `compat.flags.init` and synthesises a prompt for every supported (non-preview)
 * flag whose `minSince` is satisfied by the running comet version.
 *
 * Always returns a deterministic object; flags the user did not pick are
 * omitted entirely so {@link buildCometProjectInitInvocation} can apply its
 * own "drop unknown" logic.
 */
export async function promptCometOptions(input: {
    compat: CometCompatibility | undefined;
    scope: InstallScope;
    language: 'en' | 'zh';
    cometVersion?: string | null;
    io?: InitWizardIo;
}): Promise<CometExtraOptions> {
    const io = input.io ?? {};
    const ii = { input: io.input, output: io.output };
    const result: CometExtraOptions = {};
    if (!input.compat?.flags?.init) return result;

    const flags = input.compat.flags.init;
    for (const [flagName, spec] of Object.entries(flags)) {
        if (!shouldPromptForFlag(flagName, spec, input.scope, input.cometVersion ?? null)) continue;
        const value = await promptSingleFlag(flagName, spec, input.language, ii);
        if (value === undefined) continue;

        // The overwrite flow emits a sentinel 'skip' string to mean "skip all
        // existing"; translate it into the sibling skipExisting flag key so
        // the extras map mirrors comet's own flag surface.
        if (flagName === 'overwrite' && value === ('skip' as unknown as boolean)) {
            result.skipExisting = true;
            continue;
        }
        result[flagName] = value;
    }
    return result;
}

function shouldPromptForFlag(
    _flagName: string,
    spec: FlagSpec,
    scope: InstallScope,
    cometVersion: string | null,
): boolean {
    if (spec.preview) return false;
    if (spec.scopeGuard && spec.scopeGuard !== scope) return false;
    if (cometVersion && spec.minSince && compareVersionsLoose(cometVersion, spec.minSince) < 0) return false;
    if (cometVersion && spec.maxRemovedIn && compareVersionsLoose(cometVersion, spec.maxRemovedIn) >= 0) return false;
    return true;
}

async function promptSingleFlag(
    flagName: string,
    spec: FlagSpec,
    language: 'en' | 'zh',
    io: { input?: Readable; output?: Writable },
): Promise<string | boolean | string[] | undefined> {
    // Boolean flags (e.g. overwrite / skip-existing) are mutually exclusive;
    // present a single choice list so the user picks one strategy.
    if (spec.type === 'boolean') {
        if (flagName === 'overwrite' || flagName === 'skipExisting') {
            // These two are typically offered together; we only prompt once via
            // the `overwrite` spec to avoid double prompts. The companion is
            // suppressed by the caller's iteration order dependency.
            if (flagName !== 'overwrite') return undefined;
            const choice = await select<'overwrite' | 'skip' | 'ask'>(
                spec.prompt?.[`message${language === 'zh' ? 'Zh' : 'En'}`] ?? 'Overwrite strategy',
                [
                    { label: language === 'zh' ? '冲突时询问' : 'Ask on conflict', value: 'ask' },
                    { label: language === 'zh' ? '全部覆盖' : 'Overwrite all', value: 'overwrite' },
                    { label: language === 'zh' ? '全部跳过' : 'Skip existing', value: 'skip' },
                ],
                io,
            );
            // Caller consumes the result as a single-key record; we encode the
            // decision as { overwrite: true } / { skipExisting: true } via the
            // "extras" map after returning. To stay within the return type we
            // emit just the boolean toggle here and rely on the caller's loop
            // to set the appropriate key.
            if (choice === 'overwrite') return true;
            if (choice === 'skip') return 'skip' as unknown as boolean; // sentinel
            return undefined;
        }
        // Generic boolean flag: yes/no.
        const answer = await select<'yes' | 'no'>(
            spec.prompt?.[`message${language === 'zh' ? 'Zh' : 'En'}`] ?? flagName,
            [
                { label: language === 'zh' ? '是' : 'Yes', value: 'yes' },
                { label: language === 'zh' ? '否' : 'No', value: 'no' },
            ],
            io,
        );
        return answer === 'yes';
    }

    if (spec.type === 'enum' && spec.choices) {
        const value = await select<string>(
            spec.prompt?.[`message${language === 'zh' ? 'Zh' : 'En'}`] ?? flagName,
            spec.choices.map((c) => ({ label: c, value: c })),
            io,
        );
        return value;
    }

    if (spec.type === 'list' && spec.itemChoices) {
        const selected = await checkbox<string>(
            spec.prompt?.[`message${language === 'zh' ? 'Zh' : 'En'}`] ?? flagName,
            spec.itemChoices.map((c) => ({ label: c, value: c, checked: false })),
            io,
        );
        return selected;
    }

    // string flag: defer to comet's own prompt in --yes mode unless a default
    // is declared in the manifest; otherwise return undefined (skip).
    if (spec.default !== undefined && typeof spec.default === 'string') return spec.default;
    return undefined;
}

function compareVersionsLoose(actual: string, threshold: string): number {
    const a = parseLooseVersion(actual);
    const t = parseLooseVersion(threshold);
    for (let i = 0; i < 3; i += 1) {
        if (a[i] !== t[i]) return a[i]! - t[i]!;
    }
    return 0;
}

function parseLooseVersion(v: string): [number, number, number] {
    const match = /^(\d+)\.(\d+)\.(\d+)/.exec(v.trim());
    if (!match) return [0, 0, 0];
    return [Number(match[1]), Number(match[2]), Number(match[3])];
}
