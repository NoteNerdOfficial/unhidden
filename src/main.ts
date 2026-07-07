import { Notice, Plugin } from "obsidian";
import { RevealEngine } from "./reveal-engine";
import { DEFAULT_SETTINGS, normalizeSettings, UnhiddenSettings } from "./settings";
import { UnhiddenSettingTab } from "./settings-tab";
import { FolderPickModal } from "./folder-pick-modal";
import { setVerboseLogging } from "./log";

export default class UnhiddenPlugin extends Plugin {
  settings: UnhiddenSettings = { ...DEFAULT_SETTINGS };
  engine!: RevealEngine;

  async onload(): Promise<void> {
    this.settings = normalizeSettings(await this.loadData());
    this.engine = new RevealEngine(this.app);
    this.pushFiltersToEngine();

    this.addSettingTab(new UnhiddenSettingTab(this.app, this));

    this.addCommand({
      id: "rescan",
      name: "Rescan revealed folders",
      callback: () => {
        new Notice("Unhidden: rebuilding the index of revealed folders…");
        void this.rebuildIndex();
      },
    });

    this.addCommand({
      id: "reveal-folder",
      name: "Reveal a hidden folder",
      callback: () => void this.pickFolderToReveal(),
    });

    this.addCommand({
      id: "hide-folder",
      name: "Hide a revealed folder",
      callback: () => this.pickFolderToHide(),
    });

    this.engine.watchForNewHiddenRootEntries((path) => {
      new Notice(
        `Unhidden: found a new hidden path "${path}" at the vault root. Open Settings → Unhidden to reveal it.`,
        8000,
      );
    });

    this.app.workspace.onLayoutReady(() => {
      void this.engine.sync(this.settings.revealedFolders);
    });
  }

  onunload(): void {
    this.engine.stopWatchingForNewHiddenRootEntries();
    void this.engine.teardown();
  }

  async setFolderRevealed(folder: string, revealed: boolean): Promise<void> {
    const folders = new Set(this.settings.revealedFolders);
    if (revealed) folders.add(folder);
    else folders.delete(folder);
    this.settings.revealedFolders = [...folders].sort();
    await this.saveData(this.settings);
    try {
      if (revealed) await this.engine.reveal(folder);
      else await this.engine.conceal(folder);
    } catch (error) {
      new Notice(
        `Unhidden: could not ${revealed ? "reveal" : "hide"} "${folder}". See the developer console for details.`,
      );
      throw error;
    }
  }

  /** Persists settings and applies filter changes to the live index. */
  async applyFilterChanges(): Promise<void> {
    await this.saveData(this.settings);
    this.pushFiltersToEngine();
    await this.rebuildIndex();
  }

  /** Persists settings without rebuilding (for changes that don't affect the index). */
  async persistSettings(): Promise<void> {
    await this.saveData(this.settings);
    this.pushFiltersToEngine();
  }

  async rebuildIndex(): Promise<void> {
    await this.engine.reconcileAll();
  }

  private pushFiltersToEngine(): void {
    setVerboseLogging(this.settings.debugLogging);
    this.engine.configureFilters({
      mode: this.settings.extensionMode,
      allowlist: this.settings.extensionAllowlist,
      excludedFolderNames: this.settings.excludedFolderNames,
    });
  }

  private async pickFolderToReveal(): Promise<void> {
    const hidden = await this.engine.listHiddenRootEntries();
    const candidates = hidden.filter((folder) => !this.settings.revealedFolders.includes(folder));
    if (candidates.length === 0) {
      new Notice("Unhidden: no hidden paths left to reveal.");
      return;
    }
    new FolderPickModal(this.app, candidates, "Reveal which path?", async (folder) => {
      try {
        await this.setFolderRevealed(folder, true);
        new Notice(`Unhidden: revealed "${folder}".`);
      } catch {
        // Failure notice already shown by setFolderRevealed.
      }
    }).open();
  }

  private pickFolderToHide(): void {
    if (this.settings.revealedFolders.length === 0) {
      new Notice("Unhidden: no folders are currently revealed.");
      return;
    }
    new FolderPickModal(this.app, [...this.settings.revealedFolders], "Hide which folder?", async (folder) => {
      try {
        await this.setFolderRevealed(folder, false);
        new Notice(`Unhidden: "${folder}" is hidden again.`);
      } catch {
        // Failure notice already shown by setFolderRevealed.
      }
    }).open();
  }
}
