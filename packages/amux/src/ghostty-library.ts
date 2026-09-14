import { Config, ConfigProvider, Effect, Option } from "effect";

const environment = (name: string, fallback: string): string =>
  Effect.runSync(
    Config.option(Config.string(name)).pipe(
      Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnv()),
      Effect.map(Option.getOrElse(() => fallback)),
    ),
  );

/** Vendor zig-out, relative to this package — not process.cwd(). */
const defaultLibDir = new URL("../../../vendor/libghostty-vt/zig-out/lib", import.meta.url)
  .pathname;

export const LIB_DIR = environment("GHOSTTY_VT_LIB_DIR", defaultLibDir);

export const LIB = environment("GHOSTTY_VT_LIB", `${LIB_DIR}/libghostty-vt.so.0.1.0`);
