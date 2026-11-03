export const projectRoot: string;
export function availableEngines(root?: string): ("embedded" | "builtin")[];
export function vimAliases(root?: string): Record<string, string>;
export function prepareEngineSources(root?: string): Promise<void>;
