import type { DataAdapter } from "obsidian";

/**
 * Undocumented methods on Obsidian's desktop FileSystemAdapter.
 *
 * Obsidian has no public API for indexing hidden paths, so the only way to
 * surface them is to call — and in two cases patch — these internals. They
 * are stable across recent releases but could change; every call site is
 * wrapped so a breakage degrades to a console warning rather than a crash.
 */
export interface VaultInternals extends DataAdapter {
  /** Registers a folder node in the vault index. */
  reconcileFolderCreation(vaultPath: string, realPath: string): Promise<void>;
  /** Registers a file node in the vault index. Throws ENOENT if missing on disk. */
  reconcileFileInternal(vaultPath: string, realPath: string): Promise<void>;
  /** Removes a node from the vault index. */
  reconcileDeletion(vaultPath: string, realPath: string, skipRaw?: boolean): Promise<void>;
  /** Watcher entry point for file changes — patched to admit revealed paths. */
  reconcileFile(vaultPath: string, realPath: string, deleted?: boolean): Promise<void>;
  /** Tree-traversal entry point — patched to admit revealed paths. */
  listRecursiveChild(parentPath: string, childName: string): Promise<void>;
  /** Starts a recursive file watcher on a (possibly hidden) path. */
  watchHiddenRecursive(vaultPath: string): Promise<void>;
  stopWatchPath?(vaultPath: string): void;
  watchers?: Record<string, unknown>;
  /** Resolves a vault-relative path to an absolute filesystem path. */
  getFullRealPath(vaultPath: string): string;
  trigger(name: "raw", path: string): void;
}
