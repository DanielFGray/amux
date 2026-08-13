import { test, expect } from "bun:test";
import { Effect, Either, Schema } from "effect";
import {
  COMMAND_DEFS,
  COMMAND_META,
  Command,
  CommandError,
  agentToolDefinitions,
  command,
  decodeCommand,
  makeCommands,
  runDetached,
  type CommandHandlers,
  type CommandTag,
} from "./commands.ts";

/** Handlers that record what they were called with, so a test can watch a
 *  command arrive at exactly one of them with its arguments intact. */
function recording(): { seen: Command[]; handlers: CommandHandlers } {
  const seen: Command[] = [];
  const handlers = Object.fromEntries(
    COMMAND_DEFS.map((def) => [
      def.tag,
      (args: Command) => Effect.sync(() => void seen.push(args)),
    ]),
  ) as unknown as CommandHandlers;
  return { seen, handlers };
}

test("a command reaches its own handler with its arguments", () => {
  const { seen, handlers } = recording();
  const commands = makeCommands(handlers);

  Effect.runSync(commands.run(command("window.select", { number: 3 })));
  Effect.runSync(commands.run(command("pane.split", { axis: "column" })));

  expect(seen).toEqual([
    { _tag: "window.select", number: 3 },
    { _tag: "pane.split", axis: "column" },
  ]);
});

/**
 * The reason `run` suspends.
 *
 * A binding builds its effect once, when the table is built — so if `run` called
 * the handler eagerly, every command would read the workspace at startup and act
 * on whatever it saw then. Nothing may happen until the effect is executed.
 */
test("building a command's effect runs nothing until it is executed", () => {
  const { seen, handlers } = recording();
  const commands = makeCommands(handlers);

  const effect = commands.run(command("pane.zoom"));
  expect(seen).toEqual([]);

  Effect.runSync(effect);
  expect(seen).toEqual([{ _tag: "pane.zoom" }]);
});

/**
 * A rejection is a value on the error channel, not a throw.
 *
 * The send-keys prompt is what needs this: it stays open with the reason in it,
 * which it can only do by reading the failure back out.
 */
test("a command can fail with a message the caller can read", () => {
  const { handlers } = recording();
  const commands = makeCommands({
    ...handlers,
    "pane.send-keys": () => Effect.fail(new CommandError({ message: "unterminated quote" })),
  });

  const result = Effect.runSync(
    Effect.either(commands.run(command("pane.send-keys", { keys: "'" }))),
  );

  expect(Either.isLeft(result) && result.left.message).toBe("unterminated quote");
});

test("the wire decodes into a command, and rejects one it cannot type", () => {
  expect(Effect.runSync(decodeCommand({ _tag: "window.select", number: 2 }))).toEqual(
    command("window.select", { number: 2 }),
  );
  // Optional targets stay optional over the wire.
  expect(Effect.runSync(decodeCommand({ _tag: "session.kill" }))).toEqual(command("session.kill"));
  expect(Effect.runSync(decodeCommand({ _tag: "pane.resize", direction: "left" }))).toEqual(
    command("pane.resize", { direction: "left" }),
  );

  const rejects = (input: unknown) =>
    Either.isLeft(Effect.runSync(Effect.either(decodeCommand(input))));
  expect(rejects({ _tag: "window.select", number: "two" })).toBe(true);
  expect(rejects({ _tag: "pane.split", axis: "diagonal" })).toBe(true);
  expect(rejects({ _tag: "pane.resize", direction: "diagonal" })).toBe(true);
  expect(rejects({ _tag: "no.such.command" })).toBe(true);
  // A verb that takes an argument cannot be invoked without it.
  expect(rejects({ _tag: "window.rename" })).toBe(true);
});

test("the buffer verbs carry their stack arguments over the wire", () => {
  const rejects = (input: unknown) =>
    Either.isLeft(Effect.runSync(Effect.either(decodeCommand(input))));
  expect(Effect.runSync(decodeCommand({ _tag: "buffer.set", data: "x" }))).toEqual(
    command("buffer.set", { data: "x" }),
  );
  expect(Effect.runSync(decodeCommand({ _tag: "buffer.paste", name: "clip" }))).toEqual(
    command("buffer.paste", { name: "clip" }),
  );
  expect(Effect.runSync(decodeCommand({ _tag: "buffer.choose" }))).toEqual(
    command("buffer.choose"),
  );
  // A buffer verb's name is optional, exactly like a tmux -b flag.
  expect(Effect.runSync(decodeCommand({ _tag: "buffer.delete" }))).toEqual(
    command("buffer.delete"),
  );
  expect(rejects({ _tag: "buffer.set" })).toBe(true);
});

test("notify carries its title, body, and optional session over the wire", () => {
  expect(
    Effect.runSync(
      decodeCommand({
        _tag: "notify",
        title: "Build",
        body: "Finished",
        session: "work",
      }),
    ),
  ).toEqual(command("notify", { title: "Build", body: "Finished", session: "work" }));
});

/**
 * Target is what determines whether a command can be invoked remotely and
 * whether it mutates the daemon-owned workspace. Exposure controls whether
 * an agent sees the command.
 */
test("target derivation: workspace commands are in the workspace, view commands are not", () => {
  const commands = makeCommands(recording().handlers);

  expect(COMMAND_DEFS.length).toBeGreaterThan(0);
  for (const def of COMMAND_DEFS) {
    expect(commands.isWorkspaceCommand(def.tag)).toBe(def.target === "workspace");
    expect(commands.isRemoteCommand(def.tag)).toBe(def.target !== "view");
  }
});

test("filtering by target and exposure produces the expected subsets", () => {
  const commands = makeCommands(recording().handlers);

  const allNames = commands.list().map((c) => c.name);
  expect(allNames).toEqual(COMMAND_DEFS.map((def) => def.tag));

  const workspaceNames = commands.list({ target: "workspace" }).map((c) => c.name);
  expect(workspaceNames.length).toBeGreaterThan(0);
  for (const name of workspaceNames) {
    expect(commands.isWorkspaceCommand(name)).toBe(true);
  }

  const viewOnly: CommandTag[] = [
    "app.settings",
    "app.command-palette",
    "app.help",
    "app.quit",
    "app.send-prefix",
    "buffer.choose",
    "buffer.paste",
    "config.adjust",
    "config.reset",
    "config.set",
    "config.toggle",
    "pane.copy-mode",
  ];
  const remote = commands
    .list({ target: "workspace" })
    .map((c) => c.name)
    .concat(commands.list({ target: "buffers" }).map((c) => c.name))
    .concat(commands.list({ target: "session" }).map((c) => c.name))
    .concat(commands.list({ target: "server" }).map((c) => c.name));
  // View-targeted commands are NOT in the remote set.
  for (const name of viewOnly) expect(remote).not.toContain(name);
  // Quitting detaches this client and says nothing about the session, so it
  // never leaves the view: a daemon asked to quit would have to guess whose.
  expect(remote).not.toContain("app.quit");
  expect(commands.list({ exposure: "agent" }).map((c) => c.name)).not.toContain("app.quit");
});

/**
 * Descriptions live in the Schema annotation, not only on the metadata record.
 *
 * That is what makes the agent tool surface a derivation: a JSON Schema built
 * from these members carries the description with it, instead of a second table
 * of prose maintained by hand beside this one.
 */
test("every verb annotates its own description and is unique", () => {
  const tags = COMMAND_DEFS.map((def) => def.tag);
  expect(new Set(tags).size).toBe(tags.length);

  for (const def of COMMAND_DEFS) {
    expect(def.schema.ast.annotations).toMatchObject({
      [Symbol.for("effect/annotation/Description")]: def.desc,
      [Symbol.for("effect/annotation/Identifier")]: def.tag,
    });
    expect(def.desc.length).toBeGreaterThan(0);
    expect(COMMAND_META[def.tag]).toEqual({
      name: def.tag,
      desc: def.desc,
      group: def.group,
      target: def.target,
      exposure: def.exposure,
    });
  }
});

test("agent tools are generated from the command definitions", () => {
  const tools = agentToolDefinitions();
  const split = tools.find((tool) => tool.name === "pane.split");
  const capture = tools.find((tool) => tool.name === "pane.capture");

  expect(tools.map((tool) => tool.name)).toEqual(
    COMMAND_DEFS.filter((def) => def.exposure === "agent").map((def) => def.tag),
  );
  expect(split).toMatchObject({
    name: "pane.split",
    description: "split the focused pane",
    parameters: {
      type: "object",
      required: ["axis"],
      properties: { axis: { type: "string", enum: ["row", "column"] } },
    },
  });
  expect(capture).toMatchObject({
    name: "pane.capture",
    description: "capture the focused pane",
    parameters: {
      type: "object",
      required: [],
      properties: { session: { type: "string" } },
    },
  });
});

/**
 * A failed command says so rather than vanishing.
 *
 * Nothing awaits a dispatched command — the keymap's dispatch is a predicate
 * that has already returned by the time the fiber finishes — so an unobserved
 * failure would be silence.
 */
test("a detached command reports its failure", () => {
  const errors: string[] = [];
  const original = console.error;
  console.error = (message: string) => void errors.push(message);
  try {
    runDetached("pane.send-keys", Effect.fail(new CommandError({ message: "no pane to send to" })));
    runDetached("pane.zoom", Effect.void);
  } finally {
    console.error = original;
  }

  expect(errors).toHaveLength(1);
  expect(errors[0]).toContain("pane.send-keys");
  expect(errors[0]).toContain("no pane to send to");
});

/**
 * Commands with results return typed values, not just void.
 */
test("commands with declared results carry them through the handler", () => {
  const handlers: CommandHandlers = {
    ...Object.fromEntries(COMMAND_DEFS.map((def) => [def.tag, () => Effect.void])),
    "buffer.set": ({ name, data }: any) => Effect.succeed(name ?? `buffer-${data.length}`),
    "buffer.show": ({ name }: any) => Effect.succeed(`content of ${name ?? "top"}`),
    "pane.capture": () => Effect.succeed("captured text"),
  } as unknown as CommandHandlers;

  const commands = makeCommands(handlers);

  expect(Effect.runSync(commands.run(command("buffer.set", { data: "hello" })))).toBe("buffer-5");
  expect(Effect.runSync(commands.run(command("buffer.show", { name: "buf1" })))).toBe(
    "content of buf1",
  );
  expect(Effect.runSync(commands.run(command("pane.capture")))).toBe("captured text");
  expect(Effect.runSync(commands.run(command("pane.zoom")))).toBe(undefined);
});

test("command result types match the declared schema", () => {
  const bufSetDef = COMMAND_DEFS.find((d) => d.tag === "buffer.set")!;
  const bufListDef = COMMAND_DEFS.find((d) => d.tag === "buffer.list")!;
  const paneCaptureDef = COMMAND_DEFS.find((d) => d.tag === "pane.capture")!;

  // buffer.set → string
  expect(Schema.decodeUnknownSync(bufSetDef.result)("hello")).toBe("hello");
  // buffer.list → array of {name, bytes, preview}
  expect(
    Schema.decodeUnknownSync(bufListDef.result)([{ name: "x", bytes: 3, preview: "..." }]),
  ).toEqual([{ name: "x", bytes: 3, preview: "..." }]);
  // pane.capture → string
  expect(Schema.decodeUnknownSync(paneCaptureDef.result)("captured text")).toBe("captured text");
  // void-schema decodes to undefined
  const paneZoomDef = COMMAND_DEFS.find((d) => d.tag === "pane.zoom")!;
  expect(Schema.decodeUnknownSync(paneZoomDef.result)(undefined)).toBe(undefined);
  const agentNewDef = COMMAND_DEFS.find((d) => d.tag === "agent.new")!;
  expect(
    Schema.decodeUnknownSync(agentNewDef.result)({ session: "agent-2", pane: "pane-2" }),
  ).toEqual({ session: "agent-2", pane: "pane-2" });
});
