# opentui-herdr

TypeScript terminal multiplexer prototype using OpenTUI and libghostty-vt.

To install dependencies:

```bash
bun install
```

To run:

```bash
bun run start
```

Set `GHOSTTY_VT_LIB_DIR` when libghostty-vt is not at the development default
path, or set `GHOSTTY_VT_LIB` to the full shared-library path.

This project was created using `bun init` in bun v1.3.14. [Bun](https://bun.com) is a fast all-in-one JavaScript runtime.
