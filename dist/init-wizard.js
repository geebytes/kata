import { stdin as defaultInput, stdout as defaultOutput } from 'node:process';
import { platformDefinitions } from './adapters/platforms.js';
import { checkbox, select } from './cli/prompt.js';
const supportedPlatforms = platformDefinitions
    .map((platform) => platform.id)
    .filter((platform) => platform !== 'generic');
export function renderInitBanner() {
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
export function planDetectedInit(platforms, settings = {}) {
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
export function mergeInstallReports(input) {
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
export async function promptInitPlan(platforms, io = {}) {
    const input = io.input ?? defaultInput;
    const output = io.output ?? defaultOutput;
    output.write(`${renderInitBanner()}\n\n`);
    const language = await select('Language for skills', [
        { value: 'en', label: 'English' },
        { value: 'zh', label: '中文' },
    ], { input, output });
    const scope = await select('Install scope', [
        { value: 'project', label: 'Project' },
        { value: 'global', label: 'Global' },
    ], { input, output });
    const candidates = platforms.filter((platform) => platform.scope === scope);
    const supported = candidates.filter((platform) => supportedPlatforms.includes(platform.platform));
    const fallback = candidates.filter((platform) => platform.platform === 'generic');
    const defaults = supported.length > 0 ? supported : fallback;
    const selected = await checkbox('Platforms to install', candidates.map((p) => ({
        value: p,
        label: `${p.platform} (${p.root})`,
        checked: defaults.includes(p),
    })), { input, output });
    return { scope, language, detected: candidates, selected };
}
export function optionsForWizardInstall(base, scope, platformRoot, language) {
    return {
        ...base,
        ...(language ? { language } : {}),
        ...(scope === 'project' ? { root: platformRoot } : { home: platformRoot }),
    };
}
//# sourceMappingURL=init-wizard.js.map