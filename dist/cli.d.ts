#!/usr/bin/env node
import { type CometCompatibility } from './comet/compat.js';
import type { Phase } from './core/state.js';
export declare function getRuntimeCompatibility(manifestPath?: string): CometCompatibility;
export declare function main(argv?: string[]): Promise<void>;
export declare function roleForPhase(phase: Phase | string): string;
//# sourceMappingURL=cli.d.ts.map