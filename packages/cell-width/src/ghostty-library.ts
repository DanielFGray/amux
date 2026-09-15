/** Vendor zig-out, relative to this package — not process.cwd(). */
const defaultLibDir = new URL("../../../vendor/libghostty-vt/zig-out/lib", import.meta.url)
  .pathname;

export const LIB_DIR = Bun.env.GHOSTTY_VT_LIB_DIR ?? defaultLibDir;

export const LIB = Bun.env.GHOSTTY_VT_LIB ?? `${LIB_DIR}/libghostty-vt.so.0.1.0`;
