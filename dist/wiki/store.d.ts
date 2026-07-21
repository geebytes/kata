import { type WikiRecord } from './record.js';
export declare function readWikiRecords(root: string): Promise<WikiRecord[]>;
export declare function writeWikiRecord(root: string, record: WikiRecord): Promise<void>;
export declare function updateWikiRecord(root: string, id: string, update: Partial<WikiRecord>): Promise<WikiRecord>;
export declare function deleteWikiRecord(root: string, id: string): Promise<void>;
export declare function findWikiRecord(root: string, id: string): Promise<WikiRecord | undefined>;
//# sourceMappingURL=store.d.ts.map