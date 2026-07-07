export type ExtensionMode = "allowlist" | "everything";

export interface UnhiddenSettings {
  /** Vault-relative folder paths currently brought into the index. */
  revealedFolders: string[];
  /** Whether to index every file type or only allowlisted extensions. */
  extensionMode: ExtensionMode;
  /** Extensions (no leading dot) indexed when extensionMode is "allowlist". */
  extensionAllowlist: string[];
  /** Folder names skipped entirely wherever they appear (e.g. node_modules). */
  excludedFolderNames: string[];
  /** Verbose console logging for troubleshooting. */
  debugLogging: boolean;
}

export const DEFAULT_ALLOWLIST: readonly string[] = [
  // Obsidian-native formats
  "md", "canvas", "base", "pdf",
  // Images
  "avif", "bmp", "gif", "jpeg", "jpg", "png", "svg", "webp",
  // Audio / video
  "3gp", "flac", "m4a", "mkv", "mov", "mp3", "mp4", "ogg", "ogv", "wav", "webm",
  // Code and config
  "astro", "c", "cjs", "cpp", "cs", "css", "go", "html", "java", "js", "json",
  "jsx", "lua", "mjs", "php", "py", "rs", "sh", "toml", "ts", "tsx", "txt",
  "xml", "yaml", "yml",
];

export const DEFAULT_EXCLUDED_FOLDER_NAMES: readonly string[] = ["node_modules"];

export const DEFAULT_SETTINGS: UnhiddenSettings = {
  revealedFolders: [],
  extensionMode: "allowlist",
  extensionAllowlist: [...DEFAULT_ALLOWLIST],
  excludedFolderNames: [...DEFAULT_EXCLUDED_FOLDER_NAMES],
  debugLogging: false,
};

const stringArray = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

/**
 * Turns whatever is on disk into a valid settings object. Understands the
 * legacy data.json shape (enabledFolders / allowedExtensions) so an existing
 * install migrates transparently.
 */
export function normalizeSettings(raw: unknown): UnhiddenSettings {
  const data = (raw ?? {}) as Record<string, unknown>;
  const folders = stringArray(data.revealedFolders ?? data.enabledFolders);
  const allowlist = stringArray(data.extensionAllowlist ?? data.allowedExtensions);
  return {
    revealedFolders: [...new Set(folders)].sort(),
    extensionMode: data.extensionMode === "everything" ? "everything" : "allowlist",
    extensionAllowlist: allowlist.length > 0 ? parseExtensionList(allowlist.join(",")) : [...DEFAULT_ALLOWLIST],
    excludedFolderNames:
      data.excludedFolderNames !== undefined
        ? stringArray(data.excludedFolderNames)
        : [...DEFAULT_EXCLUDED_FOLDER_NAMES],
    debugLogging: data.debugLogging === true,
  };
}

/** Parses user input like ".md, ts  png" into a clean, sorted extension list. */
export function parseExtensionList(input: string): string[] {
  const cleaned = input
    .split(/[\s,]+/)
    .map((ext) => ext.replace(/^\./, "").trim().toLowerCase())
    .filter(Boolean);
  return [...new Set(cleaned)].sort();
}

/** Parses user input like "node_modules, dist" into a clean list of folder names. */
export function parseFolderNameList(input: string): string[] {
  const cleaned = input
    .split(/[\s,]+/)
    .map((name) => name.trim())
    .filter(Boolean);
  return [...new Set(cleaned)];
}
