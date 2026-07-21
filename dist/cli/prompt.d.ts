import type { Readable } from 'node:stream';
import type { Writable } from 'node:stream';
export interface SelectOption<T> {
    value: T;
    label: string;
}
export interface CheckOption<T> {
    value: T;
    label: string;
    checked?: boolean;
}
export declare function select<T>(question: string, options: SelectOption<T>[], io?: {
    input?: Readable;
    output?: Writable;
}): Promise<T>;
export declare function checkbox<T>(question: string, options: CheckOption<T>[], io?: {
    input?: Readable;
    output?: Writable;
}): Promise<T[]>;
export declare function confirmDestructive(message: string, details?: string[]): Promise<boolean>;
//# sourceMappingURL=prompt.d.ts.map