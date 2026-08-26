export const LIB_DIR =
  process.env.GHOSTTY_VT_LIB_DIR ?? "/home/dan/build/amux/vendor/libghostty-vt/zig-out/lib";

export const LIB = process.env.GHOSTTY_VT_LIB ?? `${LIB_DIR}/libghostty-vt.so.0.1.0`;
