import { type CometCompatibility } from './compat.js';
interface CometStatus {
    phase: string;
    [key: string]: unknown;
}
interface CometNext {
    next: string;
    [key: string]: unknown;
}
type CommandRunner = (command: string, args: readonly string[]) => Promise<string>;
export interface InitOptions {
    language?: 'en' | 'zh';
}
export interface CometClientOptions {
    command?: string;
    compatibility?: CometCompatibility;
    run?: CommandRunner;
}
export declare class CometClient {
    private readonly command;
    private readonly compatibility;
    private readonly run;
    constructor(options: CometClientOptions);
    assertInstalledVersion(version: string): Promise<void>;
    init(change: string, options?: InitOptions): Promise<void>;
    status(change: string): Promise<CometStatus>;
    next(change: string): Promise<CometNext>;
    private parseJson;
}
export type { CometCompatibility } from './compat.js';
//# sourceMappingURL=client.d.ts.map