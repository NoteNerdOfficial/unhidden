import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type UnhiddenPlugin from "./main";
import { DEFAULT_ALLOWLIST, parseExtensionList, parseFolderNameList } from "./settings";

export class UnhiddenSettingTab extends PluginSettingTab {
  private readonly plugin: UnhiddenPlugin;

  constructor(app: App, plugin: UnhiddenPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl).setName("Hidden folders").setHeading();
    containerEl.createEl("p", {
      cls: "unhidden-hint",
      text:
        "Toggle a folder or file to bring it into Obsidian's index: file explorer, search, " +
        "metadata cache, and Bases. Toggling it off removes it from the index again; " +
        "nothing on disk is ever touched.",
    });

    const listEl = containerEl.createDiv({ cls: "unhidden-folder-list" });
    listEl.createEl("p", { cls: "unhidden-hint", text: "Scanning vault root…" });
    void this.renderFolderList(listEl);

    this.renderCustomPathSetting(containerEl);
    this.renderFileTypeSettings(containerEl);
    this.renderAdvancedSettings(containerEl);
  }

  private async renderFolderList(listEl: HTMLElement): Promise<void> {
    const detected = await this.plugin.engine.listHiddenRootEntries();
    const revealed = this.plugin.settings.revealedFolders;
    const folders = [...new Set([...detected, ...revealed])].sort();

    listEl.empty();
    if (folders.length === 0) {
      listEl.createEl("p", {
        cls: "unhidden-hint",
        text: "No hidden folders or files found at the vault root.",
      });
      return;
    }

    const missing = new Set<string>();
    for (const folder of folders) {
      if (!detected.includes(folder) && !(await this.plugin.engine.existsOnDisk(folder))) {
        missing.add(folder);
      }
    }

    for (const folder of folders) {
      const row = new Setting(listEl).setName(folder);
      if (missing.has(folder)) row.setDesc("Not found on disk");
      row.addToggle((toggle) =>
        toggle.setValue(revealed.includes(folder)).onChange(async (value) => {
          try {
            await this.plugin.setFolderRevealed(folder, value);
          } catch {
            toggle.setValue(!value);
          }
        }),
      );
    }

    new Setting(listEl)
      .setClass("unhidden-bulk-actions")
      .addButton((button) =>
        button.setButtonText("Reveal all").onClick(async () => {
          for (const folder of folders) {
            if (missing.has(folder)) continue;
            try {
              await this.plugin.setFolderRevealed(folder, true);
            } catch {
              // Failure notice already shown by setFolderRevealed; keep going.
            }
          }
          this.display();
        }),
      )
      .addButton((button) =>
        button.setButtonText("Hide all").onClick(async () => {
          for (const folder of [...this.plugin.settings.revealedFolders]) {
            try {
              await this.plugin.setFolderRevealed(folder, false);
            } catch {
              // Failure notice already shown by setFolderRevealed; keep going.
            }
          }
          this.display();
        }),
      )
      .addButton((button) => button.setButtonText("Refresh list").onClick(() => this.display()));
  }

  private renderCustomPathSetting(containerEl: HTMLElement): void {
    let draft = "";
    new Setting(containerEl)
      .setName("Reveal another path")
      .setDesc("A hidden folder or file that isn't at the vault root, e.g. projects/.notes or .env.")
      .addText((text) => {
        text.setPlaceholder("path/to/.folder").onChange((value) => (draft = value));
      })
      .addButton((button) =>
        button
          .setButtonText("Reveal")
          .setCta()
          .onClick(async () => {
            const path = draft.trim().replace(/^\/+|\/+$/g, "");
            if (!path) return;
            if (!(await this.plugin.engine.existsOnDisk(path))) {
              new Notice(`Unhidden: "${path}" was not found in this vault.`);
              return;
            }
            try {
              await this.plugin.setFolderRevealed(path, true);
              new Notice(`Unhidden: revealed "${path}".`);
              this.display();
            } catch {
              // Failure notice already shown by setFolderRevealed.
            }
          }),
      );
  }

  private renderFileTypeSettings(containerEl: HTMLElement): void {
    new Setting(containerEl).setName("File types").setHeading();

    new Setting(containerEl)
      .setName("Which files to index")
      .setDesc(
        "Indexing every file type can pull large or binary files into the index; " +
          "the allowlist keeps things fast and predictable.",
      )
      .addDropdown((dropdown) =>
        dropdown
          .addOption("allowlist", "Only allowlisted extensions")
          .addOption("everything", "Every file type")
          .setValue(this.plugin.settings.extensionMode)
          .onChange(async (value) => {
            this.plugin.settings.extensionMode = value === "everything" ? "everything" : "allowlist";
            await this.plugin.applyFilterChanges();
            new Notice("Unhidden: file type mode changed. Rebuilding index…");
            this.display();
          }),
      );

    if (this.plugin.settings.extensionMode !== "allowlist") return;

    let draft = this.plugin.settings.extensionAllowlist.join(", ");
    new Setting(containerEl)
      .setName("Extension allowlist")
      .setDesc("Comma or space separated, without the leading dot.")
      .setClass("unhidden-allowlist")
      .addTextArea((area) => {
        area.setValue(draft).onChange((value) => (draft = value));
      });

    new Setting(containerEl)
      .setClass("unhidden-bulk-actions")
      .addButton((button) =>
        button
          .setButtonText("Apply")
          .setCta()
          .onClick(async () => {
            this.plugin.settings.extensionAllowlist = parseExtensionList(draft);
            await this.plugin.applyFilterChanges();
            new Notice("Unhidden: allowlist applied. Rebuilding index…");
            this.display();
          }),
      )
      .addButton((button) =>
        button.setButtonText("Reset to defaults").onClick(async () => {
          this.plugin.settings.extensionAllowlist = [...DEFAULT_ALLOWLIST];
          await this.plugin.applyFilterChanges();
          new Notice("Unhidden: allowlist reset. Rebuilding index…");
          this.display();
        }),
      );
  }

  private renderAdvancedSettings(containerEl: HTMLElement): void {
    new Setting(containerEl).setName("Advanced").setHeading();

    let draft = this.plugin.settings.excludedFolderNames.join(", ");
    new Setting(containerEl)
      .setName("Skip folder names")
      .setDesc(
        "Folders with these names are skipped entirely wherever they appear " +
          "(comma separated). Keeps things like node_modules out of the index.",
      )
      .addText((text) => {
        text.setValue(draft).onChange((value) => (draft = value));
      })
      .addButton((button) =>
        button.setButtonText("Apply").onClick(async () => {
          this.plugin.settings.excludedFolderNames = parseFolderNameList(draft);
          await this.plugin.applyFilterChanges();
          new Notice("Unhidden: exclusions applied. Rebuilding index…");
        }),
      );

    new Setting(containerEl)
      .setName("Debug logging")
      .setDesc("Log what the plugin does to the developer console.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.debugLogging).onChange(async (value) => {
          this.plugin.settings.debugLogging = value;
          await this.plugin.persistSettings();
        }),
      );
  }
}
