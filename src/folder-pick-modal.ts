import { App, FuzzySuggestModal } from "obsidian";

/** Fuzzy picker over a fixed list of folder paths. */
export class FolderPickModal extends FuzzySuggestModal<string> {
  private readonly folders: string[];
  private readonly onPick: (folder: string) => void | Promise<void>;

  constructor(
    app: App,
    folders: string[],
    placeholder: string,
    onPick: (folder: string) => void | Promise<void>,
  ) {
    super(app);
    this.folders = folders;
    this.onPick = onPick;
    this.setPlaceholder(placeholder);
  }

  getItems(): string[] {
    return this.folders;
  }

  getItemText(folder: string): string {
    return folder;
  }

  onChooseItem(folder: string): void {
    void this.onPick(folder);
  }
}
