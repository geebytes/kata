export type LayoutResult = {
    created: string[];
    existing: string[];
    conflicts: string[];
};
export declare function resolveWorkspaceRoot(from?: string): string;
export declare function initLayout(root: string): Promise<LayoutResult>;
//# sourceMappingURL=layout.d.ts.map