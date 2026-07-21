export interface LlmWikiInput {
    root?: string;
    wikiPath?: string;
}
export interface InitLlmWikiInput extends LlmWikiInput {
    from: string;
}
export interface LlmWikiInitResult {
    wikiPath: string;
    importedSources: string[];
    schemaPath: string;
    indexPath: string;
    logPath: string;
}
export interface LlmWikiOrientation {
    wikiPath: string;
    schema: string;
    index: string;
    recentLog: string;
}
export interface LlmWikiLintIssue {
    severity: 'critical' | 'high' | 'medium' | 'low';
    code: string;
    path: string;
    message: string;
}
export interface LlmWikiLintReport {
    wikiPath: string;
    ok: boolean;
    issues: LlmWikiLintIssue[];
}
export interface IngestLlmWikiInput extends LlmWikiInput {
    from: string;
}
export interface LlmWikiIngestResult {
    wikiPath: string;
    importedSources: string[];
    pagesWritten: string[];
    governedRecords: string[];
}
export interface QueryLlmWikiInput extends LlmWikiInput {
    query: string;
    file?: boolean;
}
export interface LlmWikiQueryResult {
    wikiPath: string;
    query: string;
    answer: string;
    citations: string[];
    filedPath?: string;
}
export interface LlmWikiTaskInput extends LlmWikiInput {
    kind: 'bootstrap' | 'enrich' | 'distill';
    from?: string;
}
export interface LlmWikiTaskPacket {
    command: 'wiki task';
    kind: LlmWikiTaskInput['kind'];
    wikiPath: string;
    requiredReads: string[];
    writeTargets: string[];
    instructions: string[];
    followupCommands: string[];
}
export interface LlmWikiRegisterResult {
    command: 'wiki register';
    wikiPath: string;
    registered: number;
    skipped: number;
    pages: string[];
}
export interface LlmWikiRebuildResult {
    command: 'wiki rebuild';
    wikiPath: string;
    cleaned: {
        pages: number;
        records: number;
    };
    taskPacketPath: string;
}
export declare function initLlmWiki(input: InitLlmWikiInput): Promise<LlmWikiInitResult>;
export declare function orientLlmWiki(input?: LlmWikiInput): Promise<LlmWikiOrientation>;
export declare function ingestLlmWiki(input: IngestLlmWikiInput): Promise<LlmWikiIngestResult>;
export declare function queryLlmWiki(input: QueryLlmWikiInput): Promise<LlmWikiQueryResult>;
export declare function buildLlmWikiTask(input: LlmWikiTaskInput): Promise<LlmWikiTaskPacket>;
export declare function registerWikiPages(input?: LlmWikiInput): Promise<LlmWikiRegisterResult>;
export declare function rebuildLlmWiki(input?: LlmWikiInput): Promise<LlmWikiRebuildResult>;
export declare function lintLlmWiki(input?: LlmWikiInput): Promise<LlmWikiLintReport>;
//# sourceMappingURL=llmwiki.d.ts.map