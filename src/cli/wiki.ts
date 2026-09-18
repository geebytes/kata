import { readWikiRecords } from '../wiki/store.js';
import { revalidateStaleRecords, revalidateWikiRecord, verifySources } from '../wiki/drift.js';
import { auditWiki, createRefreshPacket, relevantWiki } from '../wiki/lifecycle.js';
import {
    buildLlmWikiTask,
    ingestLlmWiki,
    initLlmWiki,
    lintLlmWiki,
    orientLlmWiki,
    queryLlmWiki,
    rebuildLlmWiki,
    registerWikiPages,
} from '../wiki/llmwiki.js';
import { promote, rejectCandidate, retireWikiRecord } from '../wiki/promotion.js';
import { evaluateWikiClosure, readWikiClosure, wikiClosureRemedy, writeWikiClosure } from '../wiki/closure.js';
import { resolveWorkspaceRoot } from '../core/layout.js';
import { argValue } from './invocation.js';
import { confirmDestructive } from './prompt.js';

/**
 * The Wiki family: the governed knowledge store's command surface.
 *
 * `wiki` is the one command whose subcommands span four modules (the LLM Wiki, the record store, drift/revalidation and
 * promotion) because it is the operator's entry point to all of them. Nothing here imports the entry point.
 */

export async function runWikiCommand(argv: string[]): Promise<Record<string, unknown>> {
    const [subcommand, ...rest] = argv;
    if (!subcommand || subcommand === '--help' || subcommand === '-h') {
        return {
            command: 'wiki help',
            commands: ['init --from <path>', 'orient', 'ingest --from <path>', 'query --q <question>', 'lint', 'verify', 'task --kind enrich', 'register', 'candidate', 'closure --task <task-id> --decision <captured|not_applicable|deferred> --reason <text>', 'audit', 'lifecycle', 'refresh --task <task-id>', 'relevance --task <task-id>', 'promote <wiki-id> --by <actor> --role <role>', 'reject <wiki-id> --by <actor> --role <role> --reason <reason>', 'retire <wiki-id> --by <actor> --role <role> --reason <reason>'],
            aliases: { propose: 'task --kind enrich' },
            examples: ['kata-cli wiki task --kind enrich --from docs', 'kata-cli wiki propose --task <task-id> --from docs', 'kata-cli wiki candidate'],
        };
    }
    const args = subcommand === 'promote' || subcommand === 'reject' || subcommand === 'retire' ? parseWikiArgs(rest.slice(1)) : parseWikiArgs(rest);
    if (subcommand === 'init') {
        if (!args.from) throw new Error('Usage: kata-cli wiki init --from <path> [--wiki <path>] [--root <path>]');
        const result = await initLlmWiki({ root: args.root, wikiPath: args.wikiPath, from: args.from });
        return {
            command: 'wiki init',
            wikiPath: result.wikiPath,
            importedCount: result.importedSources.length,
            importedSources: result.importedSources,
        };
    }
    if (subcommand === 'orient') {
        const result = await orientLlmWiki({ root: args.root, wikiPath: args.wikiPath });
        return {
            command: 'wiki orient',
            wikiPath: result.wikiPath,
            schemaBytes: result.schema.length,
            indexBytes: result.index.length,
            recentLog: result.recentLog,
        };
    }
    if (subcommand === 'ingest') {
        if (!args.from) throw new Error('Usage: kata-cli wiki ingest --from <path> [--wiki <path>] [--root <path>]');
        const result = await ingestLlmWiki({ root: args.root, wikiPath: args.wikiPath, from: args.from });
        return {
            command: 'wiki ingest',
            wikiPath: result.wikiPath,
            importedCount: result.importedSources.length,
            importedSources: result.importedSources,
            pagesWritten: result.pagesWritten,
            governedRecords: result.governedRecords,
        };
    }
    if (subcommand === 'query') {
        if (!args.query) throw new Error('Usage: kata-cli wiki query --q <question> [--file] [--wiki <path>] [--root <path>]');
        const result = await queryLlmWiki({ root: args.root, wikiPath: args.wikiPath, query: args.query, file: args.file });
        return {
            command: 'wiki query',
            wikiPath: result.wikiPath,
            answer: result.answer,
            citations: result.citations,
            ...(result.filedPath ? { filedPath: result.filedPath } : {}),
        };
    }
    if (subcommand === 'revalidate') {
        // The transition out of `stale`: without it a record for an edited page stayed stale forever, so the closure
        // gate could keep reading a record whose sources no longer matched (see `wiki/drift.ts`).
        const record = argValue(rest, '--record');
        if (record) {
            const result = await revalidateWikiRecord(args.root ?? resolveWorkspaceRoot(), record);
            return { command: 'wiki revalidate', ...result };
        }
        if (!rest.includes('--all')) {
            throw new Error('Usage: kata-cli wiki revalidate --record <wiki-id> | --all [--root <path>]');
        }
        const { report, revalidated } = await revalidateStaleRecords(args.root ?? resolveWorkspaceRoot());
        return {
            command: 'wiki revalidate',
            stale: report.stale.length,
            revalidated: revalidated.map((entry) => ({ id: entry.id, refreshed: entry.refreshed })),
        };
    }

    if (subcommand === 'lint') {
        const result = await lintLlmWiki({ root: args.root, wikiPath: args.wikiPath });
        return {
            command: 'wiki lint',
            wikiPath: result.wikiPath,
            ok: result.ok,
            issues: result.issues,
        };
    }
    if (subcommand === 'task') {
        if (args.kind !== 'bootstrap' && args.kind !== 'enrich' && args.kind !== 'distill') {
            throw new Error('Usage: kata-cli wiki task --kind <bootstrap|enrich|distill> [--from <path>] [--wiki <path>] [--root <path>]');
        }
        return { ...(await buildLlmWikiTask({ root: args.root, wikiPath: args.wikiPath, kind: args.kind, from: args.from })) };
    }
    if (subcommand === 'propose') {
        const packet = await buildLlmWikiTask({ root: args.root, wikiPath: args.wikiPath, kind: 'enrich', from: args.from });
        return { ...packet, ...(args.task ? { sourceTask: args.task } : {}), alias: 'wiki propose' };
    }
    if (subcommand === 'candidate') {
        const root = args.root ?? resolveWorkspaceRoot();
        const candidates = (await readWikiRecords(root)).filter((record) => record.status === 'candidate');
        return { command: 'wiki candidate', candidates };
    }
    if (subcommand === 'closure') {
        if (!args.task || !args.decision || !args.reason || !['captured', 'not_applicable', 'deferred'].includes(args.decision)) {
            throw new Error('Usage: kata-cli wiki closure --task <task-id> --decision <captured|not_applicable|deferred> --reason <text> [--candidate <wiki-id>]');
        }
        const root = args.root ?? resolveWorkspaceRoot();
        const closure = await writeWikiClosure(root, args.task, { decision: args.decision as 'captured' | 'not_applicable' | 'deferred', reason: args.reason, candidateIds: args.candidates });
        const evaluation = await evaluateWikiClosure(root, args.task);
        const lint = closure.decision === 'captured' ? await lintLlmWiki({ root, wikiPath: args.wikiPath }) : null;
        const sources = closure.decision === 'captured' ? await verifySources(root) : null;
        return { command: 'wiki closure', closure, evaluation, ...(lint ? { lint } : {}), ...(sources ? { sources } : {}) };
    }
    if (subcommand === 'audit') return { command: 'wiki audit', ...(await auditWiki(args.root ?? resolveWorkspaceRoot())) };
    if (subcommand === 'lifecycle') return { command: 'wiki lifecycle', ...(await auditWiki(args.root ?? resolveWorkspaceRoot())) };
    if (subcommand === 'refresh') {
        if (!args.task) throw new Error('Usage: kata-cli wiki refresh --task <task-id> [--root <path>]');
        return { command: 'wiki refresh', ...(await createRefreshPacket(args.root ?? resolveWorkspaceRoot(), args.task)) };
    }
    if (subcommand === 'relevance') {
        if (!args.task) throw new Error('Usage: kata-cli wiki relevance --task <task-id> [--root <path>]');
        return { command: 'wiki relevance', taskId: args.task, records: await relevantWiki(args.root ?? resolveWorkspaceRoot(), args.task) };
    }
    if (subcommand === 'verify') {
        const root = args.root ?? resolveWorkspaceRoot();
        const result = await verifySources(root);
        return {
            command: 'wiki verify',
            checked: result.checked,
            intact: result.intact,
            stale: result.stale,
            missing: result.missing,
        };
    }
    if (subcommand === 'register') {
        const result = await registerWikiPages({ root: args.root, wikiPath: args.wikiPath });
        return result as unknown as Record<string, unknown>;
    }
    if (subcommand === 'rebuild') {
        const confirmed = args.force ?? await confirmDestructive(
            'This will remove all existing wiki pages and governed records, then regenerate the enrich task-packet.',
            ['Concepts, entities, comparisons, and queries will be deleted.', 'Governed candidate records in .kata/wiki/ will be deleted.'],
        );
        if (!confirmed) {
            return { command: 'wiki rebuild', aborted: true };
        }
        const result = await rebuildLlmWiki({ root: args.root, wikiPath: args.wikiPath });
        return result as unknown as Record<string, unknown>;
    }
    if (subcommand === 'promote') {
        const id = rest[0];
        if (!id || id.startsWith('--') || !args.by || !args.role) {
            throw new Error('Usage: kata-cli wiki promote <wiki-id> --by <actor> --role <role> [--root <path>]');
        }
        const approvedAt = new Date().toISOString();
        const record = await promote(args.root ?? resolveWorkspaceRoot(), id, { approvedBy: args.by, role: args.role, approvedAt });
        return {
            command: 'wiki promote',
            id: record.id,
            status: record.status,
            approvedBy: args.by,
            role: args.role,
            approvedAt,
        };
    }
    if (subcommand === 'reject') {
        const id = rest[0];
        if (!id || id.startsWith('--') || !args.by || !args.role || !args.reason) {
            throw new Error('Usage: kata-cli wiki reject <wiki-id> --by <actor> --role <role> --reason <reason> [--root <path>]');
        }
        const rejectedAt = new Date().toISOString();
        const record = await rejectCandidate(args.root ?? resolveWorkspaceRoot(), id, {
            rejectedBy: args.by,
            role: args.role,
            rejectedAt,
            reason: args.reason,
        });
        return {
            command: 'wiki reject',
            id: record.id,
            status: record.status,
            rejectedBy: args.by,
            role: args.role,
            rejectedAt,
            reason: args.reason,
        };
    }
    if (subcommand === 'retire') {
        const id = rest[0];
        if (!id || id.startsWith('--') || !args.by || !args.role || !args.reason) {
            throw new Error('Usage: kata-cli wiki retire <wiki-id> --by <actor> --role <role> --reason <reason> [--root <path>]');
        }
        const rejectedAt = new Date().toISOString();
        const record = await retireWikiRecord(args.root ?? resolveWorkspaceRoot(), id, {
            rejectedBy: args.by,
            role: args.role,
            rejectedAt,
            reason: args.reason,
        });
        return {
            command: 'wiki retire',
            id: record.id,
            status: record.status,
            rejectedBy: args.by,
            role: args.role,
            rejectedAt,
            reason: record.rejectionEvent?.reason ?? args.reason,
        };
    }
    throw new Error(`Unknown wiki command: ${subcommand ?? ''}`);
}

export function parseWikiArgs(argv: string[]): { from?: string; root?: string; wikiPath?: string; query?: string; file?: boolean; by?: string; role?: string; reason?: string; kind?: string; task?: string; decision?: string; candidates?: string[]; force?: boolean } {
    const args: { from?: string; root?: string; wikiPath?: string; query?: string; file?: boolean; by?: string; role?: string; reason?: string; kind?: string; task?: string; decision?: string; candidates?: string[]; force?: boolean } = {};
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        const value = argv[index + 1];
        if (arg === '--from' && value !== undefined) {
            args.from = value;
            index += 1;
        } else if (arg === '--root' && value !== undefined) {
            args.root = value;
            index += 1;
        } else if (arg === '--wiki' && value !== undefined) {
            args.wikiPath = value;
            index += 1;
        } else if ((arg === '--q' || arg === '--query') && value !== undefined) {
            args.query = value;
            index += 1;
        } else if (arg === '--file') {
            args.file = true;
        } else if (arg === '--by' && value !== undefined) {
            args.by = value;
            index += 1;
        } else if (arg === '--role' && value !== undefined) {
            args.role = value;
            index += 1;
        } else if (arg === '--reason' && value !== undefined) {
            args.reason = value;
            index += 1;
        } else if (arg === '--kind' && value !== undefined) {
            args.kind = value;
            index += 1;
        } else if (arg === '--task' && value !== undefined) {
            args.task = value;
            index += 1;
        } else if (arg === '--decision' && value !== undefined) {
            args.decision = value;
            index += 1;
        } else if (arg === '--candidate' && value !== undefined) {
            args.candidates = [...(args.candidates ?? []), value];
            index += 1;
        } else if (arg === '--force') {
            args.force = true;
        } else {
            throw new Error(`Unknown wiki option: ${arg}`);
        }
    }
    return args;
}
