const TAG = "[Unhidden]";

let verbose = false;

export function setVerboseLogging(enabled: boolean): void {
  verbose = enabled;
}

export function logDebug(message: string): void {
  if (verbose) console.debug(`${TAG} ${message}`);
}

export function logWarn(message: string, error?: unknown): void {
  if (error !== undefined) console.warn(`${TAG} ${message}`, error);
  else console.warn(`${TAG} ${message}`);
}

export function logError(message: string, error?: unknown): void {
  if (error !== undefined) console.error(`${TAG} ${message}`, error);
  else console.error(`${TAG} ${message}`);
}
