import { expect, test } from "bun:test";
import { LIB, LIB_DIR } from "./ghostty-library.ts";

const expectedLibDir = new URL(
  "../../../vendor/libghostty-vt/zig-out/lib",
  import.meta.url,
).pathname;

function envWithoutGhostty(overrides: { GHOSTTY_VT_LIB_DIR?: string } = {}) {
  const { GHOSTTY_VT_LIB_DIR: _dir, GHOSTTY_VT_LIB: _lib, ...rest } = process.env;
  return { ...rest, ...overrides };
}

function importLibrary(env: NodeJS.ProcessEnv, cwd: string) {
  const moduleUrl = new URL("./ghostty-library.ts", import.meta.url).href;
  const proc = Bun.spawnSync({
    cmd: [
      process.execPath,
      "-e",
      `import { LIB, LIB_DIR } from ${JSON.stringify(moduleUrl)};
       console.log(JSON.stringify({ LIB, LIB_DIR }));`,
    ],
    cwd,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stderr = proc.stderr.toString();
  expect(stderr).toBe("");
  expect(proc.exitCode).toBe(0);
  return JSON.parse(proc.stdout.toString().trim()) as { LIB: string; LIB_DIR: string };
}

test("LIB_DIR defaults to vendor under the repo, not process.cwd()", () => {
  expect(LIB_DIR).toBe(expectedLibDir);
  expect(LIB).toBe(`${LIB_DIR}/libghostty-vt.so.0.1.0`);
  expect(Bun.file(LIB).size).toBeGreaterThan(0);
});

test("default LIB resolves when process cwd is outside the repo", () => {
  const printed = importLibrary(envWithoutGhostty(), "/tmp");
  expect(printed.LIB_DIR).toBe(LIB_DIR);
  expect(printed.LIB).toBe(LIB);
  expect(Bun.file(printed.LIB).size).toBeGreaterThan(0);
});

test("GHOSTTY_VT_LIB_DIR env override wins", () => {
  const override = "/tmp/ghostty-override-lib-dir";
  const printed = importLibrary(envWithoutGhostty({ GHOSTTY_VT_LIB_DIR: override }), "/tmp");
  expect(printed.LIB_DIR).toBe(override);
  expect(printed.LIB).toBe(`${override}/libghostty-vt.so.0.1.0`);
});
