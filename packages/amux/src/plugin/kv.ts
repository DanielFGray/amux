import { Option, Schema as S } from "effect";
import type { PluginKV, PluginKVKey } from "./types.ts";

export const key = <A, E = A>(name: string, schema: S.Codec<A, E>): PluginKVKey<A, E> => ({
  key: name,
  schema,
});

export function createPluginKV(): PluginKV {
  // Heterogeneous encoded forms; each get decodes with that key's codec.
  const store = new Map<string, unknown>();
  return {
    get<A, E>(key: PluginKVKey<A, E>, defaultValue?: A): A | undefined {
      const encoded = store.get(key.key);
      if (encoded === undefined) return defaultValue;
      return Option.getOrElse(S.decodeUnknownOption(key.schema)(encoded), () => defaultValue);
    },
    set<A, E>(key: PluginKVKey<A, E>, value: A): void {
      Option.match(S.encodeOption(key.schema)(value), {
        onNone: () => undefined,
        onSome: (encoded) => {
          store.set(key.key, encoded);
        },
      });
    },
    get ready() {
      return true;
    },
  };
}
