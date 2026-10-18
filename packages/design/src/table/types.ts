import type { ReactNode } from "react";
import type { PaginationProps } from "../display/pagination.js";
import type { MenuItem } from "../overlays/menus.js";

export type Column<T> = {
  key: string;
  header: string;
  cell(row: T): ReactNode;
  align?: "left" | "right";
  tone?: "ink" | "muted";
  sortable?: boolean;
  width?: number;
};

export type SortDir = "asc" | "desc";

export type DataTableProps<T> = {
  columns: Column<T>[];
  rows: T[];
  rowKey(row: T): string;
  label: string;
  state?: "ready" | "loading" | "error";
  error?: { code: string; requestId?: string; onRetry(): void };
  empty?: { title: string; hint?: string; action?: ReactNode };
  noResults?: { description: string; onClear(): void };
  toolbar?: ReactNode;
  selection?: { selected: ReadonlySet<string>; onChange(next: Set<string>): void };
  bulkActions?(selected: ReadonlySet<string>): ReactNode;
  activeKey?: string;
  onOpen?(row: T): void;
  rowMenu?(row: T): MenuItem[];
  expand?(row: T): ReactNode | null;
  isDisabled?(row: T): boolean;
  sort?: { key: string; dir: SortDir; onChange(key: string, dir: SortDir): void };
  pagination?: PaginationProps;
  density?: "default" | "compact" | "media";
};
