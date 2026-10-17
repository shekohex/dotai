export type Cell = string | number | boolean | null | undefined;

const text = (cell: Cell) => (cell === null || cell === undefined ? "" : String(cell));

/** Numbers sort by value, everything else by locale-aware text. */
export function compareCells(a: Cell, b: Cell): number {
  const [x, y] = [text(a), text(b)];
  const numeric = x !== "" && y !== "" && !Number.isNaN(Number(x)) && !Number.isNaN(Number(y));
  return numeric ? Number(x) - Number(y) : x.localeCompare(y, undefined, { numeric: true, sensitivity: "base" });
}

export function sortRows(rows: Cell[][], column: number | null, direction: "asc" | "desc"): Cell[][] {
  if (column === null) return rows;
  const sign = direction === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => sign * compareCells(a[column], b[column]));
}

/** Rows where any cell contains the query, ignoring case. */
export function searchRows(rows: Cell[][], query: string): Cell[][] {
  const needle = query.trim().toLowerCase();
  if (!needle) return rows;
  return rows.filter((row) => row.some((cell) => text(cell).toLowerCase().includes(needle)));
}

export function pageCount(total: number, pageSize: number): number {
  return Math.max(1, Math.ceil(total / Math.max(1, pageSize)));
}

export function pageRows<T>(rows: T[], page: number, pageSize: number): T[] {
  const size = Math.max(1, pageSize);
  const last = pageCount(rows.length, size) - 1;
  const start = Math.min(Math.max(0, page), last) * size;
  return rows.slice(start, start + size);
}

/** The options whose text contains the query, ignoring case. */
export function matchOptions(options: string[], query: string): string[] {
  const needle = query.trim().toLowerCase();
  return needle ? options.filter((option) => option.toLowerCase().includes(needle)) : options;
}

export function toggleOption(chosen: string[], option: string): string[] {
  return chosen.includes(option) ? chosen.filter((item) => item !== option) : [...chosen, option];
}
