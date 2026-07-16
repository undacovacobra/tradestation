export function createRetryableModuleLoader<T>(
  importer: () => Promise<T>,
): () => Promise<T | null> {
  let loaded: T | undefined;

  return async () => {
    if (loaded !== undefined) return loaded;
    try {
      loaded = await importer();
      return loaded;
    } catch {
      // Do not cache failures. The dependency may be installed or recover
      // while ATLAS is still running, so the next request must try again.
      return null;
    }
  };
}
