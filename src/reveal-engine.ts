import { App, normalizePath, TFile } from "obsidian";
import { promises as fsp, watch } from "node:fs";
import type { Dirent, FSWatcher } from "node:fs";
import type { VaultInternals } from "./vault-internals";
import type { ExtensionMode } from "./settings";
import { logDebug, logError, logWarn } from "./log";

/** How many index operations to run before yielding back to the UI thread. */
const YIELD_EVERY = 200;

const yieldToUi = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

const isMissingOnDisk = (error: unknown): boolean =>
  typeof error === "object" && error !== null && (error as NodeJS.ErrnoException).code === "ENOENT";

type DiskKind = "file" | "folder" | "missing";

interface FilterConfig {
  mode: ExtensionMode;
  allowlist: string[];
  excludedFolderNames: string[];
}

interface PatchBackup {
  listRecursiveChild: VaultInternals["listRecursiveChild"];
  reconcileFile: VaultInternals["reconcileFile"];
}

/**
 * Brings hidden folders into (and out of) Obsidian's vault index.
 *
 * Revealing a folder does three things:
 *  1. Eagerly walks the directory tree on disk and registers every folder and
 *     matching file, so the whole subtree appears at once — no reliance on
 *     Obsidian's lazy traversal.
 *  2. Starts a recursive file watcher so later changes flow in live.
 *  3. Patches two adapter entry points (`listRecursiveChild`, `reconcileFile`)
 *     so Obsidian's own traversal and watcher callbacks accept the revealed
 *     paths instead of silently dropping them.
 *
 * Concealing reverses all of it and never touches anything on disk.
 */
export class RevealEngine {
  private readonly app: App;
  private readonly revealed = new Set<string>();
  private readonly pending = new Map<string, Promise<void>>();
  private allowlist = new Set<string>();
  private indexEverything = false;
  private excludedFolderNames: string[] = [];
  private backup: PatchBackup | null = null;
  private rootWatcher: FSWatcher | null = null;
  private knownHiddenRoots: Set<string> | null = null;

  constructor(app: App) {
    this.app = app;
  }

  configureFilters(config: FilterConfig): void {
    this.indexEverything = config.mode === "everything";
    this.allowlist = new Set(
      config.allowlist.map((ext) => ext.replace(/^\./, "").trim().toLowerCase()).filter(Boolean),
    );
    this.excludedFolderNames = config.excludedFolderNames.map((name) => name.trim()).filter(Boolean);
  }

  getRevealed(): string[] {
    return [...this.revealed].sort();
  }

  isPending(path: string): boolean {
    return this.pending.has(this.normalize(path));
  }

  /** Hidden folders and files at the vault root, excluding Obsidian's own config dir. */
  async listHiddenRootEntries(): Promise<string[]> {
    const listing = await this.internals().list("/");
    const configDir = normalizePath(this.app.vault.configDir);
    const isHiddenRootEntry = (entry: string): boolean => {
      const name = entry.replace(/^\/+/, "");
      return name.startsWith(".") && name !== configDir && name !== ".trash";
    };
    return [...listing.folders, ...listing.files]
      .filter(isHiddenRootEntry)
      .map((entry) => entry.replace(/^\/+/, ""))
      .sort();
  }

  /** True if a hidden folder or a single hidden file exists at this path. */
  async existsOnDisk(path: string): Promise<boolean> {
    return (await this.kindOnDisk(this.normalize(path))) !== "missing";
  }

  /** Reconciles the live index with the given folder list. */
  async sync(folders: string[]): Promise<void> {
    const wanted = new Set(folders.map((folder) => this.normalize(folder)).filter(Boolean));
    for (const current of this.getRevealed()) {
      if (!wanted.has(current)) await this.conceal(current);
    }
    for (const folder of wanted) {
      await this.reveal(folder);
    }
  }

  /**
   * Re-applies current filters (extension allowlist, exclusions) and disk
   * state to every already-revealed path, without concealing and re-revealing
   * them first. Unlike a full teardown/rebuild, entries that are still valid
   * are left untouched — so a file open in an editor tab doesn't get removed
   * from the index and re-added just because a filter changed elsewhere.
   */
  async reconcileAll(): Promise<void> {
    for (const target of this.getRevealed()) {
      await this.enqueue(target, () => this.runReconcile(target));
    }
  }

  private async runReconcile(target: string): Promise<void> {
    const kind = await this.kindOnDisk(target);
    if (kind === "missing") {
      await this.runConceal(target);
      return;
    }
    const adapter = this.internals();
    if (kind === "file") {
      // Extension allowlist never applies to an explicitly revealed root (see admit()).
      adapter.trigger("raw", target);
      try {
        await adapter.reconcileFileInternal(target, target);
      } catch (error) {
        logWarn(`Could not reconcile "${target}"`, error);
      }
      return;
    }
    await this.pruneStale(target);
    await this.indexTree(target);
    logDebug(`Reconciled "${target}"`);
  }

  /**
   * Removes loaded entries under `folder` that no longer belong: gone from
   * disk, newly excluded, or (for files) no longer an allowed extension.
   * Entries that still pass are left alone so open tabs aren't disturbed.
   */
  private async pruneStale(folder: string): Promise<void> {
    const adapter = this.internals();
    const loaded = this.app.vault
      .getAllLoadedFiles()
      .filter((entry) => this.isWithin(entry.path, folder) && entry.path !== folder)
      .sort((a, b) => b.path.length - a.path.length);
    let ops = 0;
    for (const entry of loaded) {
      const kind = await this.kindOnDisk(entry.path);
      const stale =
        kind === "missing" ||
        this.isExcluded(entry.path) ||
        (entry instanceof TFile && !this.extensionAllowed(entry.path));
      if (stale) {
        try {
          adapter.trigger("raw", entry.path);
          await adapter.reconcileDeletion(entry.path, entry.path, true);
        } catch (error) {
          logWarn(`Could not remove "${entry.path}" from the vault index`, error);
        }
      }
      if (++ops % YIELD_EVERY === 0) await yieldToUi();
    }
  }

  /**
   * Watches the vault root for hidden folders/files that appear after
   * startup and invokes `onDiscovered` once per new, not-yet-revealed entry.
   * The first scan only establishes a baseline so pre-existing hidden paths
   * don't all fire at once.
   */
  watchForNewHiddenRootEntries(onDiscovered: (path: string) => void): void {
    if (this.rootWatcher) return;
    let debounce: ReturnType<typeof setTimeout> | null = null;
    const check = async (): Promise<void> => {
      let current: string[];
      try {
        current = await this.listHiddenRootEntries();
      } catch (error) {
        logWarn("Could not scan the vault root for hidden entries", error);
        return;
      }
      if (this.knownHiddenRoots !== null) {
        for (const entry of current) {
          if (!this.knownHiddenRoots.has(entry) && !this.revealed.has(entry)) onDiscovered(entry);
        }
      }
      this.knownHiddenRoots = new Set(current);
    };
    void check();
    try {
      this.rootWatcher = watch(this.internals().getFullRealPath(""), { persistent: false }, () => {
        if (debounce) clearTimeout(debounce);
        debounce = setTimeout(() => void check(), 500);
      });
    } catch (error) {
      logWarn("Could not watch the vault root for new hidden entries", error);
    }
  }

  stopWatchingForNewHiddenRootEntries(): void {
    this.rootWatcher?.close();
    this.rootWatcher = null;
    this.knownHiddenRoots = null;
  }

  async reveal(path: string): Promise<void> {
    const folder = this.normalize(path);
    if (!folder || this.revealed.has(folder)) return;
    return this.enqueue(folder, () => this.runReveal(folder));
  }

  async conceal(path: string): Promise<void> {
    const folder = this.normalize(path);
    if (!this.revealed.has(folder)) return;
    return this.enqueue(folder, () => this.runConceal(folder));
  }

  async teardown(): Promise<void> {
    for (const folder of this.getRevealed()) {
      await this.conceal(folder);
    }
    this.removePatches();
  }

  private async enqueue(folder: string, run: () => Promise<void>): Promise<void> {
    const inFlight = this.pending.get(folder);
    if (inFlight) return inFlight;
    const job = run();
    this.pending.set(folder, job);
    try {
      await job;
    } finally {
      this.pending.delete(folder);
    }
  }

  private async runReveal(target: string): Promise<void> {
    const adapter = this.internals();
    const kind = await this.kindOnDisk(target);
    if (kind === "missing") {
      logDebug(`"${target}" was not found on disk — skipping`);
      return;
    }
    this.revealed.add(target);
    this.installPatches();
    if (kind === "file") {
      // A single hidden file: index it directly. The extension allowlist
      // never applies to an explicitly revealed root (see admit()).
      adapter.trigger("raw", target);
      try {
        await adapter.reconcileFileInternal(target, target);
      } catch (error) {
        this.revealed.delete(target);
        logError(`Could not register "${target}" in the vault index`, error);
        throw error;
      }
      logDebug(`Revealed "${target}"`);
      return;
    }
    try {
      await adapter.reconcileFolderCreation(target, target);
    } catch (error) {
      this.revealed.delete(target);
      logError(`Could not register "${target}" in the vault index`, error);
      throw error;
    }
    await this.indexTree(target);
    try {
      await adapter.watchHiddenRecursive(target);
    } catch (error) {
      logWarn(`Could not watch "${target}" for changes — its contents will not live-update`, error);
    }
    logDebug(`Revealed "${target}"`);
  }

  /**
   * Eagerly registers every folder and matching file under `root`, breadth
   * first, yielding to the UI periodically so large trees don't freeze the app.
   */
  private async indexTree(root: string): Promise<void> {
    const adapter = this.internals();
    const queue: string[] = [root];
    let ops = 0;
    while (queue.length > 0) {
      const dir = queue.shift() as string;
      let entries: Dirent[];
      try {
        entries = await fsp.readdir(adapter.getFullRealPath(dir), { withFileTypes: true });
      } catch (error) {
        logWarn(`Could not read "${dir}"`, error);
        continue;
      }
      for (const entry of entries) {
        const path = `${dir}/${entry.name}`;
        if (this.isExcluded(path)) continue;
        try {
          if (entry.isDirectory()) {
            await adapter.reconcileFolderCreation(path, path);
            queue.push(path);
          } else if (entry.isFile() && this.extensionAllowed(path)) {
            adapter.trigger("raw", path);
            await adapter.reconcileFileInternal(path, path);
          }
        } catch (error) {
          if (isMissingOnDisk(error)) {
            await adapter.reconcileDeletion(path, path, true).catch(() => undefined);
          } else {
            logWarn(`Could not index "${path}"`, error);
          }
        }
        if (++ops % YIELD_EVERY === 0) await yieldToUi();
      }
    }
  }

  private async runConceal(folder: string): Promise<void> {
    const adapter = this.internals();
    for (const watched of Object.keys(adapter.watchers ?? {})) {
      if (!this.isWithin(watched, folder)) continue;
      try {
        adapter.stopWatchPath?.call(adapter, watched);
      } catch (error) {
        logWarn(`Could not stop the watcher for "${watched}"`, error);
      }
    }
    // Deepest paths first so children are gone before their parent folder.
    const loaded = this.app.vault
      .getAllLoadedFiles()
      .filter((entry) => this.isWithin(entry.path, folder))
      .sort((a, b) => b.path.length - a.path.length);
    let ops = 0;
    for (const entry of loaded) {
      try {
        adapter.trigger("raw", entry.path);
        await adapter.reconcileDeletion(entry.path, entry.path, true);
      } catch (error) {
        logWarn(`Could not remove "${entry.path}" from the vault index`, error);
      }
      if (++ops % YIELD_EVERY === 0) await yieldToUi();
    }
    this.revealed.delete(folder);
    if (this.revealed.size === 0) this.removePatches();
    logDebug(`Concealed "${folder}"`);
  }

  private installPatches(): void {
    if (this.backup !== null) return;
    const adapter = this.internals();
    const originalListChild = adapter.listRecursiveChild.bind(adapter);
    const originalReconcileFile = adapter.reconcileFile.bind(adapter);

    adapter.listRecursiveChild = async (parentPath: string, childName: string) => {
      const path = this.normalize(parentPath === "" ? childName : `${parentPath}/${childName}`);
      if (!this.isCovered(path)) return originalListChild(parentPath, childName);
      if (this.isExcluded(path)) return;
      await this.admit(path, path, true);
    };

    adapter.reconcileFile = async (vaultPath: string, realPath: string, deleted?: boolean) => {
      if (!this.isCovered(realPath)) return originalReconcileFile(vaultPath, realPath, deleted);
      if (this.isExcluded(realPath)) return;
      await this.admit(vaultPath, realPath, deleted ?? true);
    };

    this.backup = { listRecursiveChild: originalListChild, reconcileFile: originalReconcileFile };
    logDebug("Adapter patches installed");
  }

  /**
   * Routes one revealed path into the index: folders are registered as folder
   * nodes, allowed files as file nodes, and paths gone from disk are removed.
   */
  private async admit(vaultPath: string, realPath: string, removeIfMissing: boolean): Promise<void> {
    const adapter = this.internals();
    const kind = await this.kindOnDisk(realPath);
    if (kind === "folder") {
      try {
        await adapter.reconcileFolderCreation(vaultPath, realPath);
      } catch (error) {
        logWarn(`Could not register folder "${realPath}"`, error);
      }
      return;
    }
    if (kind === "file" && !this.revealed.has(realPath) && !this.extensionAllowed(realPath)) return;
    adapter.trigger("raw", realPath);
    try {
      await adapter.reconcileFileInternal(vaultPath, realPath);
    } catch (error) {
      if (isMissingOnDisk(error)) {
        await adapter.reconcileDeletion(vaultPath, realPath, removeIfMissing).catch(() => undefined);
      } else {
        logWarn(`Could not index "${realPath}"`, error);
      }
    }
  }

  private removePatches(): void {
    if (this.backup === null) return;
    const adapter = this.internals();
    adapter.listRecursiveChild = this.backup.listRecursiveChild;
    adapter.reconcileFile = this.backup.reconcileFile;
    this.backup = null;
    logDebug("Adapter patches removed");
  }

  private isCovered(path: string): boolean {
    for (const folder of this.revealed) {
      if (this.isWithin(path, folder)) return true;
    }
    return false;
  }

  private isWithin(path: string, prefix: string): boolean {
    return path === prefix || path.startsWith(`${prefix}/`);
  }

  private isExcluded(path: string): boolean {
    if (this.excludedFolderNames.length === 0) return false;
    const segments = path.split("/");
    return this.excludedFolderNames.some((name) => segments.includes(name));
  }

  private extensionAllowed(path: string): boolean {
    if (this.indexEverything) return true;
    const name = path.slice(path.lastIndexOf("/") + 1);
    const dot = name.lastIndexOf(".");
    if (dot <= 0) return false;
    return this.allowlist.has(name.slice(dot + 1).toLowerCase());
  }

  private async kindOnDisk(path: string): Promise<DiskKind> {
    let absolute: string;
    try {
      absolute = this.internals().getFullRealPath(path);
    } catch {
      return "missing";
    }
    try {
      const stat = await fsp.stat(absolute);
      if (stat.isDirectory()) return "folder";
      if (stat.isFile()) return "file";
      return "missing";
    } catch {
      return "missing";
    }
  }

  private normalize(path: string): string {
    return normalizePath(path).replace(/^\/+|\/+$/g, "");
  }

  private internals(): VaultInternals {
    return this.app.vault.adapter as VaultInternals;
  }
}
