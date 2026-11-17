export interface KindTable { source: string; kinds: Record<string, number> }
export interface KindClash { kind: number; uses: Array<{ name: string; sources: string[] }> }
export function parseCodeKinds(src: string): Record<string, number> | undefined;
export function parseReserved(src: string): number[];
export function findClashes(tables: KindTable[]): KindClash[];
export function unreserved(mine: Record<string, number>, reserved: number[], others: KindTable[]): Array<{ kind: number; name: string; source: string }>;
