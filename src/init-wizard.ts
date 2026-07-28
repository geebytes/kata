import { stdin as defaultInput, stdout as defaultOutput } from 'node:process';
import type { Readable } from 'node:stream';
import type { Writable } from 'node:stream';
import type { InstallOptions, InstallReport, InstallScope, Platform, PlatformInfo } from './adapters/manifest.js';
import { platformDefinitions } from './adapters/platforms.js';
import { checkbox, select } from './cli/prompt.js';

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
    const supported = candidates.filter((platform) => supportedPlatforms.includes(platform.platform));
    const fallback = candidates.filter((platform) => platform.platform === 'generic');
    const defaults = supported.length > 0 ? supported : fallback;

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
