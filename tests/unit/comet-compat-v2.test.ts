import { describe, expect, it } from 'vitest';
import {
    parseCompatYaml,
    isFlagSupported,
    flagSpecFor,
} from '../../src/comet/compat.js';
import { buildCometProjectInitInvocation } from '../../src/comet/install.js';

// A representative v2 manifest used by most of the tests below. Mirrors the
// shape of the bundled comet-compat.yaml but is inlined so the suite is
// robust against kata-side edits to that file.
const V2_MANIFEST = `
version: 2
comet:
  minVersion: 0.4.0
  maxVersion: 2.0.0
  capabilities:
    init:
      minSince: "0.4.0"
    status:
      minSince: "0.4.0"
    next:
      minSince: "0.4.0"
  flags:
    init:
      workflow:
        type: enum
        choices: [native, classic, both]
        default: native
        minSince: "0.4.0-beta.7"
        prompt:
          messageKey: cometWorkflow
          messageEn: "Comet workflow"
          messageZh: "选择要初始化的 Comet 模式"
      overwrite:
        type: boolean
        minSince: "0.4.0"
        conflictsWith: [skipExisting]
        prompt:
          messageKey: cometOverwrite
          messageEn: "Overwrite existing components"
          messageZh: "覆盖所有已有组件"
      skipExisting:
        type: boolean
        minSince: "0.4.0"
        conflictsWith: [overwrite]
      root:
        type: string
        minSince: "0.4.0-beta.7"
        scopeGuard: project
      platform:
        type: enum
        choices: [codex, claude-code, opencode]
        minSince: "0.4.0"
      platforms:
        type: list
        itemType: enum
        itemChoices: [codex, claude-code, opencode]
        minSince: "0.5.0"
        preview: true
  output:
    init.json:
      fields: [projectPath, scope, status, results]
      stableFields: [projectPath, scope, status]
breakingChanges:
  - version: "0.5.0"
    field: "selectPlatforms(--yes) default"
    before: "only detected"
    after: "all platforms"
    mitigation:
      kataShouldPass: "platforms=<detected>"
      note: "kata should pass detected list to avoid surprise installs"
boundary:
  invocation: public-cli
  jsonOutput: true
`;

const V1_MANIFEST = `
version: 1
comet:
  minVersion: 1.2.0
  maxVersion: 2.0.0
  capabilities:
    init: true
    status: true
    next: true
boundary:
  invocation: public-cli
  jsonOutput: true
`;

describe('comet compatibility v2 schema', () => {
    it('parses v1 manifests and upgrades them to v2 internally', () => {
        const compat = parseCompatYaml(V1_MANIFEST, 'kata-bundled');
        expect(compat.version).toBe(2);
        expect(compat.minVersion).toBe('1.2.0');
        expect(compat.maxVersion).toBe('2.0.0');
        expect(compat.capabilities).toEqual({ init: true, status: true, next: true });
        expect(compat.flags).toBeUndefined();
        expect(compat.source).toBe('kata-bundled');
    });

    it('parses v2 capabilities with minSince metadata', () => {
        const compat = parseCompatYaml(V2_MANIFEST, 'comet-package');
        expect(compat.version).toBe(2);
        expect(compat.capabilities.init).toEqual({ minSince: '0.4.0' });
        expect(compat.capabilities.status).toEqual({ minSince: '0.4.0' });
    });

    it('parses all declared init flags including enum choices and prompt i18n strings', () => {
        const compat = parseCompatYaml(V2_MANIFEST, 'comet-package');
        const workflow = flagSpecFor(compat, 'init', 'workflow');
        expect(workflow?.type).toBe('enum');
        expect(workflow?.choices).toEqual(['native', 'classic', 'both']);
        expect(workflow?.default).toBe('native');
        expect(workflow?.minSince).toBe('0.4.0-beta.7');
        expect(workflow?.prompt?.messageZh).toBe('选择要初始化的 Comet 模式');
    });

    it('records conflict pairs, scope guards, and preview reservations', () => {
        const compat = parseCompatYaml(V2_MANIFEST, 'comet-package');
        expect(flagSpecFor(compat, 'init', 'overwrite')?.conflictsWith).toEqual(['skipExisting']);
        expect(flagSpecFor(compat, 'init', 'root')?.scopeGuard).toBe('project');
        expect(flagSpecFor(compat, 'init', 'platforms')?.preview).toBe(true);
        expect(flagSpecFor(compat, 'init', 'platforms')?.itemChoices).toEqual([
            'codex',
            'claude-code',
            'opencode',
        ]);
    });



});


describe('buildCometProjectInitInvocation flag filtering', () => {
    const compat = parseCompatYaml(V2_MANIFEST, 'runtime');

    it('drops unknown flags entirely so comet never sees an unsupported argument', () => {
        const { args } = buildCometProjectInitInvocation({
            root: '/proj',
            scope: 'project',
            extras: { bogus: true },
            compat,
        });
        expect(args.filter((a) => a.startsWith('--bogus'))).toEqual([]);
    });

    it('drops preview flags even when explicitly requested by the caller', () => {
        const { args } = buildCometProjectInitInvocation({
            root: '/proj',
            scope: 'project',
            extras: { platforms: ['codex'] },
            compat,
        });
        expect(args).not.toContain('--platforms');
    });

    it('forwards the single-value platform flag since comet 0.4.0 accepts --platform', () => {
        const { args } = buildCometProjectInitInvocation({
            root: '/proj',
            scope: 'project',
            extras: { platform: 'codex' },
            compat,
            cometVersion: '0.4.0',
        });
        expect(args).toContain('--platform');
        expect(args).toContain('codex');
    });

    it('drops platform values outside the declared choices', () => {
        const { args } = buildCometProjectInitInvocation({
            root: '/proj',
            scope: 'project',
            extras: { platform: 'martian' },
            compat,
            cometVersion: '0.4.0',
        });
        expect(args).not.toContain('--platform');
        expect(args).not.toContain('martian');
    });

    it('does not forward --platform when the comet version predates 0.4.0', () => {
        const { args } = buildCometProjectInitInvocation({
            root: '/proj',
            scope: 'project',
            extras: { platform: 'codex' },
            compat,
            cometVersion: '0.3.9',
        });
        expect(args).not.toContain('--platform');
    });

    it('drops scope-guarded flags when their scope guard does not match', () => {
        // root has scopeGuard: project; passing scope=global must drop it.
        const { args } = buildCometProjectInitInvocation({
            root: '/home',
            scope: 'global',
            extras: { root: 'comet-artifacts' },
            compat,
            cometVersion: '0.4.0',
        });
        expect(args).not.toContain('--root');
    });

    it('passes enum flags through once the value is in the declared choices', () => {
        const { args } = buildCometProjectInitInvocation({
            root: '/proj',
            scope: 'project',
            extras: { workflow: 'classic' },
            compat,
            cometVersion: '0.4.0',
        });
        expect(args).toContain('--workflow');
        expect(args).toContain('classic');
    });

    it('rejects enum values outside the declared choices list', () => {
        const { args } = buildCometProjectInitInvocation({
            root: '/proj',
            scope: 'project',
            extras: { workflow: 'martian' },
            compat,
            cometVersion: '0.4.0',
        });
        expect(args).not.toContain('--workflow');
        expect(args).not.toContain('martian');
    });

    it('emits a bare flag (no value) for boolean options', () => {
        const { args } = buildCometProjectInitInvocation({
            root: '/proj',
            scope: 'project',
            extras: { overwrite: true },
            compat,
            cometVersion: '0.4.0',
        });
        expect(args).toContain('--overwrite');
        // The next slot must NOT be the boolean value — comet expects --overwrite alone.
        const idx = args.indexOf('--overwrite');
        expect(args[idx + 1]).not.toBe('true');
    });

    it('resolves mutually-exclusive conflicts by keeping the first declared flag', () => {
        const { args } = buildCometProjectInitInvocation({
            root: '/proj',
            scope: 'project',
            extras: { overwrite: true, skipExisting: true },
            compat,
            cometVersion: '0.4.0',
        });
        expect(args).toContain('--overwrite');
        expect(args).not.toContain('--skip-existing');
    });

    it('falls back to pass-through when no compat manifest is supplied', () => {
        const { args } = buildCometProjectInitInvocation({
            root: '/proj',
            scope: 'project',
            extras: { workflow: 'classic' },
        });
        expect(args).toContain('--workflow');
        expect(args).toContain('classic');
    });

    it('appends --yes --json after the user-supplied extras', () => {
        const { args } = buildCometProjectInitInvocation({
            root: '/proj',
            scope: 'project',
            extras: { workflow: 'both' },
            compat,
            cometVersion: '0.4.0',
            yes: true,
        });
        const yesIdx = args.indexOf('--yes');
        const jsonIdx = args.indexOf('--json');
        const workflowIdx = args.indexOf('--workflow');
        expect(workflowIdx).toBeGreaterThan(-1);
        expect(yesIdx).toBeGreaterThan(workflowIdx);
        expect(jsonIdx).toBeGreaterThan(yesIdx);
    });
});
