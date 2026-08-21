import { expect, test } from "bun:test";
import { readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

const REPO = dirname(import.meta.dir);
const SESSION = "e2e-interrupt";
const root = join(tmpdir(), `amux-e2e-${Bun.hash(REPO).toString(36)}-${SESSION}`);
const leasePath = join(root, "state", "amux", "sessions", SESSION, "lease.json");

async function waitForFile(path: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await Bun.file(path).exists()) return;
    await Bun.sleep(100);
  }
  throw new Error(`timed out waiting for ${path}`);
}

async function processIsAlive(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("SIGTERM exits the runner and kills its daemon", async () => {
  const readyPath = join(tmpdir(), `amux-e2e-ready-${crypto.randomUUID()}`);
  await rm(root, { recursive: true, force: true });
  const child = Bun.spawn(
    [
      process.execPath,
      "-e",
      `import { launch } from ${JSON.stringify(new URL("./app.ts", import.meta.url).href)};
const app = await launch(${JSON.stringify(SESSION)});
await Bun.write(process.env.READY_PATH, "ready");
await new Promise(() => {});`,
    ],
    {
      cwd: REPO,
      env: { ...process.env, READY_PATH: readyPath },
      stdout: "ignore",
      stderr: "pipe",
    },
  );

  try {
    await waitForFile(readyPath);
    const lease = JSON.parse(await readFile(leasePath, "utf8")) as { pid: number };
    process.kill(child.pid, "SIGTERM");

    const exit = await Promise.race([
      child.exited,
      Bun.sleep(10_000).then(() => {
        throw new Error("the interrupted e2e runner did not exit");
      }),
    ]);
    expect(exit).not.toBe(0);

    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && (await processIsAlive(lease.pid))) {
      await Bun.sleep(100);
    }
    expect(await processIsAlive(lease.pid)).toBe(false);
  } finally {
    child.kill("SIGKILL");
    await rm(readyPath, { force: true });
    await rm(root, { recursive: true, force: true });
    await new Response(child.stderr).text();
  }
}, 60_000);
