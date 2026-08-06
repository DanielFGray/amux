import type { PluginKV } from "./types.ts";

export function createPluginKV(): PluginKV {
  const store = new Map<string, unknown>();
  return {
    get<T>(key: string, defaultValue?: T): T | undefined {
      if (store.has(key)) return store.get(key) as T;
      return defaultValue;
    },
    set(key: string, value: unknown): void {
      store.set(key, value);
    },
    get ready() {
      return true;
    },
  };
}
