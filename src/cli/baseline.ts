import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { renderSkill, skillCommands, type Platform } from '../adapters/manifest.js';
import { resolveWorkspaceRoot, skillsIndexRelativePath } from '../core/layout.js';

/**
 * What one rendered payload costs.
 *
 * `bytes` is exact; `estimatedTokens` is an estimate and is labelled as one everywhere it is reported. The point of
 * the baseline is not the absolute token count — it is the *comparison* between two revisions of the same text, which
 * an estimate supports and a hand-waved claim does not.
 */
export interface PayloadMeasurement {
    target: string;
    bytes: number;
    estimatedTokens: number;
    lines: number;
}

export interface RequiredReadMeasurement {
    path: string;
    bytes: number;
    present: boolean;
}

export interface BaselineReport {
    command: 'baseline';
    platform: Platform;
    language: 'en' | 'zh';
    skills: PayloadMeasurement[];
    skillsTotalBytes: number;
    skillsTotalEstimatedTokens: number;
    requiredReads: RequiredReadMeasurement[];
    requiredReadsTotalBytes: number;
    estimate: { charactersPerToken: number; note: string };
}

/** Characters per token. One number, stated in the report, so a reader can redo the arithmetic. */
const charactersPerToken = 4;

export function summarizePayload(target: string, text: string): PayloadMeasurement {
    return {
        target,
        bytes: Buffer.byteLength(text, 'utf8'),
        estimatedTokens: Math.ceil(text.length / charactersPerToken),
        lines: text.split('\n').length,
    };
}

export async function measureRequiredReads(root: string, paths: string[]): Promise<RequiredReadMeasurement[]> {
    const measurements: RequiredReadMeasurement[] = [];
    for (const path of paths) {
        try {
            measurements.push({ path, bytes: (await stat(join(root, path))).size, present: true });
        } catch {
            // A read that does not exist yet still costs the agent a failed lookup, so it is listed rather than dropped.
            measurements.push({ path, bytes: 0, present: false });
        }
    }
    return measurements;
}

/**
 * The authoritative reads a packet requires, in the order `readTaskContext` names them.
 *
 * The first five exist independently of a task; the last two are task-scoped, so they are measured only when a change
 * id was given. That distinction is why the report states which paths were measured at all.
 */
export function baselineReadPaths(change?: string): string[] {
    return [
        'AGENTS.md',
        skillsIndexRelativePath,
        '.llmwiki/SCHEMA.md',
        '.llmwiki/index.md',
        '.llmwiki/log.md',
        ...(change ? [`.kata/tasks/${change}/task.json`, `.kata/tasks/${change}/current-state.json`] : []),
    ];
}

export async function runBaselineCommand(argv: string[]): Promise<BaselineReport> {
    const valueAfter = (flag: string): string | undefined => {
        const index = argv.indexOf(flag);
        return index >= 0 ? argv[index + 1] : undefined;
    };
    const platform = (valueAfter('--platform') ?? 'pi') as Platform;
    const language = valueAfter('--language') === 'en' ? 'en' : 'zh';
    const change = valueAfter('--change');
    const root = valueAfter('--root') ?? resolveWorkspaceRoot();

    const skills = skillCommands.map((command) => summarizePayload(command.id, renderSkill(command, platform, { language })));
    const requiredReads = await measureRequiredReads(root, baselineReadPaths(change));

    return {
        command: 'baseline',
        platform,
        language,
        skills,
        skillsTotalBytes: skills.reduce((total, skill) => total + skill.bytes, 0),
        skillsTotalEstimatedTokens: skills.reduce((total, skill) => total + skill.estimatedTokens, 0),
        requiredReads,
        requiredReadsTotalBytes: requiredReads.reduce((total, read) => total + read.bytes, 0),
        estimate: {
            charactersPerToken,
            note: 'Byte counts are exact. Token counts are characters / charactersPerToken and are an estimate; compare two baselines taken the same way rather than treating the number as an API bill.',
        },
    };
}
