import { afterEach, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initialContext, instructionFiles } from "./context.ts";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

async function fixture() {
  const root = await mkdtemp();
  const workspace = join(root, "project");
  const config = join(root, "config");
  await mkdir(join(workspace, "src"), { recursive: true });
  await mkdir(config, { recursive: true });
  return { workspace, config };
}

async function mkdtemp() {
  const directory = join(tmpdir(), `amux-context-${crypto.randomUUID()}`);
  directories.push(directory);
  await mkdir(directory);
  return directory;
}

test("initial context includes stable environment facts", async () => {
  const { workspace, config } = await fixture();
  const context = await initialContext({
    workspace,
    configDirectory: config,
    platform: "linux",
    now: new Date("2026-08-12T13:00:00Z"),
  });
  expect(context).toContain("Workspace: " + workspace);
  expect(context).toContain("Platform: linux");
  expect(context).toContain("Date: 2026-08-12");
});

test("global instructions precede project instructions and empty files are ignored", async () => {
  const { workspace, config } = await fixture();
  await writeFile(join(config, "AGENTS.md"), "global rules\n");
  await writeFile(join(workspace, "AGENTS.md"), "project rules\n");
  await writeFile(join(workspace, "CLAUDE.md"), "\n");
  expect(await instructionFiles({ workspace, configDirectory: config })).toEqual([
    `Instructions from: ${join(config, "AGENTS.md")}\nglobal rules`,
    `Instructions from: ${join(workspace, "AGENTS.md")}\nproject rules`,
  ]);
});

test("ancestor instructions precede files nearer the active directory", async () => {
  const { workspace, config } = await fixture();
  const nested = join(workspace, "src");
  await writeFile(join(workspace, "AGENTS.md"), "root rules\n");
  await writeFile(join(nested, "CLAUDE.md"), "nested rules\n");
  expect(await instructionFiles({ workspace: nested, configDirectory: config })).toEqual(
    expect.arrayContaining([
      `Instructions from: ${join(workspace, "AGENTS.md")}\nroot rules`,
      `Instructions from: ${join(nested, "CLAUDE.md")}\nnested rules`,
    ]),
  );
});
