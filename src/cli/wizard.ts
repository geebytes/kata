import { discoverPlatforms, identifyPlatformInstallState, install } from '../adapters/discovery.js';
import type { PlatformInstallState } from '../adapters/manifest.js';
import { codeGraphInvocation } from '../codegraph/runtime.js';
import { getCometVersion, initCometProject, resolveCometPath } from '../comet/install.js';
import {
    loadCometCompatibility,
    loadCometCompatibilityAsync,
    type CometCompatibility,
} from '../comet/compat.js';
import { initializeGitFlowProject } from '../core/git-flow.js';
import { resolveWorkspaceRoot } from '../core/layout.js';
import {
    mergeInstallReports,
    optionsForWizardInstall,
    planDetectedInit,
    promptCometOptions,
    promptInitPlan,
    type CometExtraOptions,
} from '../init-wizard.js';
import { runProcessSync } from '../process/run.js';
import { parseInstallerArgs } from './installer.js';

/**
 * The init wizard: the interactive half of `kata-cli init`.
 *
 * `init` is the one installer command that asks the user questions — which platforms, which scope, which language, which
 * Comet options — and the only one whose failure mode is a *sequence* of prompts (a repeated Comet wizard, one per
 * platform). Keeping it beside the installer rather than inside it makes that difference visible: the family installs;
 * this module decides what to install.
 */

export function shouldUseInitWizard(argv: string[]): boolean {
    if (argv.includes('--platform') || argv.includes('--scope') || argv.includes('--home')) return false;
    if (argv.includes('--yes')) return true;
    return argv.length === 0 && process.stdin.isTTY;
}

export async function runInitWizardCommand(argv: string[], defaultRoot?: string): Promise<Record<string, unknown>> {
    const args = parseInstallerArgs(argv, { requirePlatform: false, allowWizard: true });
    const root = args.options.root ?? defaultRoot ?? resolveWorkspaceRoot();
    const useAuto = args.yes || !process.stdin.isTTY;
    let platforms = await discoverPlatforms({ ...args.options, root });
    // Discover the live comet manifest so the wizard can offer flags / detect
    // breaking-change mitigations appropriate to the installed comet version.
    const cometBinary = await resolveCometPath();
    const cometVersion = cometBinary ? await getCometVersion(cometBinary) : null;
    const cometCompat = await loadCometCompatibilityAsync({ cometBinary: cometBinary ?? undefined }).catch(() => loadCometCompatibility());
    const plan = useAuto
        ? await (async () => {
            platforms = await discoverPlatforms({ ...args.options, root });
            return planDetectedInit(platforms, { scope: 'project', language: 'zh' });
        })()
        : await promptInitPlan(platforms);
    // Forward applicable comet flags the user actually picked. Auto mode keeps
    // the manifest's declared defaults; interactive mode prompts per spec.
    const cometExtras: CometExtraOptions = useAuto
        ? collectAutoCometExtras(cometCompat)
        : await promptCometOptions({
            compat: cometCompat,
            scope: plan.scope,
            language: plan.language,
            cometVersion,
        }).catch(() => ({}));
    // Forward the wizard's platform selection to comet init. Comet 0.4.x only
    // accepts a single --platform per invocation and its interactive mode
    // blocks on stdin prompts, so looping a *spawn* would show the user a
    // sequence of full comet wizards ("repeated installs"). Running each
    // platform as a non-interactive capture (--yes) keeps the loop silent and
    // fast, and kata itself installs the kata skills env-dir aware.
    const selectedPlatformIds = plan.selected.map((platform) => platform.platform);
    const cometInit = useAuto
        ? {
            command: 'comet init',
            status: 'deferred' as const,
            path: null,
            root,
            scope: plan.scope,
            language: plan.language,
            nextCommand: `comet init ${root} --scope ${plan.scope} --language ${plan.language}${
                selectedPlatformIds.length > 0 ? ` --platform ${selectedPlatformIds.join(' --platform ')}` : ''
            }`,
        }
        : await initCometProject({
            root,
            scope: plan.scope,
            language: plan.language,
            // Interactive wizard: run comet headless so it never blocks the
            // terminal waiting for stdin prompts during the multi-platform loop.
            yes: true,
            platforms: selectedPlatformIds,
            extras: cometExtras,
            compat: cometCompat,
            cometVersion,
        });
    const gitFlowInit = args.options.dryRun
        ? { status: 'skipped' as const, reason: 'dry_run' }
        : await initializeGitFlowProject(root, { interactive: !useAuto && process.stdin.isTTY });
    const reports = [];
    const preStates: PlatformInstallState[] = [];
    for (const platform of plan.selected) {
        preStates.push(await identifyPlatformInstallState(platform, { ...args.options, root }));
    }
    for (const platform of plan.selected) {
        reports.push(
            await install(
                platform.platform,
                plan.scope,
                optionsForWizardInstall(args.options, plan.scope, platform.root, plan.language),
            ),
        );
    }

    const codegraphResult = useAuto
        ? { codegraph: { status: 'deferred', nextCommand: 'kata-cli codegraph install --yes' } }
        : (() => {
            const invocation = codeGraphInvocation(root);
            const index = runProcessSync(invocation.command, ['index'], { cwd: invocation.cwd, env: invocation.env, timeoutMs: 60_000 });
            return index.ok
                ? { codegraph: { status: 'initialized', ...(index.stdout.trim() ? { error: undefined } : {}) } }
                : { codegraph: { status: 'failed', error: index.stderr.trim() || `codegraph index exited ${index.exitCode}` } };
        })();

    const result = mergeInstallReports({
        command: 'init',
        mode: useAuto ? 'auto' : 'interactive',
        scope: plan.scope,
        reports,
    });
    return { ...result, cometInit, gitFlowInit, ...codegraphResult };
}

/**
 * Build a non-interactive comet extras payload from the compatibility manifest.
 *
 * In `--yes` mode the user is not asked per-flag, so we apply any manifest-
 * declared defaults (treated as "comet's recommended behaviour") and forward
 * them. Returning an empty object leaves comet to its own defaults — that's
 * exactly the historical behaviour, so this is purely additive.
 */
export function collectAutoCometExtras(compat: CometCompatibility | undefined): CometExtraOptions {
    const extras: CometExtraOptions = {};
    if (!compat?.flags?.init) return extras;
    for (const [flagName, spec] of Object.entries(compat.flags.init)) {
        if (spec.preview) continue;
        if (spec.default === undefined || spec.default === false) continue;
        extras[flagName] = spec.default;
    }
    return extras;
}
