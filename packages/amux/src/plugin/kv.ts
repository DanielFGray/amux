import { Schema as S } from "effect";
import type { PluginKV, PluginKVKey } from "./types.ts";
import type { JsonValue } from "../layout.ts";

export const key = <T extends JsonValue>(name: string, schema: S.Codec<T>): PluginKVKey<T> => ({
  key: name,
  schema,
});

export function createPluginKV(): PluginKV {
  const store = new Map<string, JsonValue>();
  return {
    get<T extends JsonValue>(key: PluginKVKey<T>, defaultValue?: T): T | undefined {
      const value = store.get(key.key);
      if (value !== undefined && S.is(key.schema)(value)) return value;
      return defaultValue;
    },
    set<T extends JsonValue>(key: PluginKVKey<T>, value: T): void {
      store.set(key.key, value);
    },
    get ready() {
      return true;
    },
  };
}
