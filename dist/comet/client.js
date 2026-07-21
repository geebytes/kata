import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { assertCapability, assertCometVersion, loadCometCompatibility } from './compat.js';
const execFileAsync = promisify(execFile);
async function runPublicCommand(command, args) {
    const result = await execFileAsync(command, [...args], { encoding: 'utf8' });
    return result.stdout;
}
export class CometClient {
    command;
    compatibility;
    run;
    constructor(options) {
        this.command = options.command ?? 'comet';
        this.compatibility = options.compatibility ?? loadCometCompatibility();
        this.run = options.run ?? runPublicCommand;
    }
    async assertInstalledVersion(version) {
        assertCometVersion(version, this.compatibility);
    }
    async init(change, options) {
        assertCapability(this.compatibility, 'init');
        const args = ['init', change, '--json'];
        if (options?.language)
            args.push('--language', options.language);
        args.push('--yes');
        await this.run(this.command, args);
    }
    async status(change) {
        assertCapability(this.compatibility, 'status');
        return this.parseJson(await this.run(this.command, ['status', change, '--json']), 'status');
    }
    async next(change) {
        assertCapability(this.compatibility, 'next');
        return this.parseJson(await this.run(this.command, ['next', change, '--json']), 'next');
    }
    parseJson(output, operation) {
        try {
            return JSON.parse(output);
        }
        catch {
            throw new Error(`Comet ${operation} returned invalid JSON`);
        }
    }
}
//# sourceMappingURL=client.js.map