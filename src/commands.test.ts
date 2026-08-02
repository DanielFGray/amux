import { test, expect } from "bun:test"
import { Effect, Either } from "effect"
import {
  COMMAND_DEFS,
  COMMAND_META,
  Command,
  CommandError,
  atLeast,
  command,
  decodeCommand,
  makeCommands,
  runDetached,
  type CommandHandlers,
  type CommandTag,
} from "./commands.ts"

/** Handlers that record what they were called with, so a test can watch a
 *  command arrive at exactly one of them with its arguments intact. */
function recording(): { seen: Command[]; handlers: CommandHandlers } {
  const seen: Command[] = []
  const handlers = Object.fromEntries(
    COMMAND_DEFS.map((def) => [def.tag, (args: Command) => Effect.sync(() => void seen.push(args))]),
  ) as unknown as CommandHandlers
  return { seen, handlers }
}

test("a command reaches its own handler with its arguments", () => {
  const { seen, handlers } = recording()
  const commands = makeCommands(handlers)

  Effect.runSync(commands.run(command("window.select", { number: 3 })))
  Effect.runSync(commands.run(command("pane.split", { axis: "column" })))

  expect(seen).toEqual([
    { _tag: "window.select", number: 3 },
    { _tag: "pane.split", axis: "column" },
  ])
})

/**
 * The reason `run` suspends.
 *
 * A binding builds its effect once, when the table is built — so if `run` called
 * the handler eagerly, every command would read the workspace at startup and act
 * on whatever it saw then. Nothing may happen until the effect is executed.
 */
test("building a command's effect runs nothing until it is executed", () => {
  const { seen, handlers } = recording()
  const commands = makeCommands(handlers)

  const effect = commands.run(command("pane.zoom"))
  expect(seen).toEqual([])

  Effect.runSync(effect)
  expect(seen).toEqual([{ _tag: "pane.zoom" }])
})

/**
 * A rejection is a value on the error channel, not a throw.
 *
 * The send-keys prompt is what needs this: it stays open with the reason in it,
 * which it can only do by reading the failure back out.
 */
test("a command can fail with a message the caller can read", () => {
  const { handlers } = recording()
  const commands = makeCommands({
    ...handlers,
    "pane.send-keys": () => Effect.fail(new CommandError({ message: "unterminated quote" })),
  })

  const result = Effect.runSync(Effect.either(commands.run(command("pane.send-keys", { keys: "'" }))))

  expect(Either.isLeft(result) && result.left.message).toBe("unterminated quote")
})

test("the wire decodes into a command, and rejects one it cannot type", () => {
  expect(Effect.runSync(decodeCommand({ _tag: "window.select", number: 2 }))).toEqual(
    command("window.select", { number: 2 }),
  )
  // Optional targets stay optional over the wire.
  expect(Effect.runSync(decodeCommand({ _tag: "agent.kill" }))).toEqual(command("agent.kill"))
  expect(Effect.runSync(decodeCommand({ _tag: "pane.resize", direction: "left" }))).toEqual(
    command("pane.resize", { direction: "left" }),
  )

  const rejects = (input: unknown) =>
    Either.isLeft(Effect.runSync(Effect.either(decodeCommand(input))))
  expect(rejects({ _tag: "window.select", number: "two" })).toBe(true)
  expect(rejects({ _tag: "pane.split", axis: "diagonal" })).toBe(true)
  expect(rejects({ _tag: "pane.resize", direction: "diagonal" })).toBe(true)
  expect(rejects({ _tag: "no.such.command" })).toBe(true)
  // A verb that takes an argument cannot be invoked without it.
  expect(rejects({ _tag: "window.rename" })).toBe(true)
})

test("the buffer verbs carry their stack arguments over the wire", () => {
  const rejects = (input: unknown) =>
    Either.isLeft(Effect.runSync(Effect.either(decodeCommand(input))))
  expect(Effect.runSync(decodeCommand({ _tag: "buffer.set", data: "x" }))).toEqual(
    command("buffer.set", { data: "x" }),
  )
  expect(Effect.runSync(decodeCommand({ _tag: "buffer.paste", name: "clip" }))).toEqual(
    command("buffer.paste", { name: "clip" }),
  )
  expect(Effect.runSync(decodeCommand({ _tag: "buffer.choose" }))).toEqual(command("buffer.choose"))
  // A buffer verb's name is optional, exactly like a tmux -b flag.
  expect(Effect.runSync(decodeCommand({ _tag: "buffer.delete" }))).toEqual(command("buffer.delete"))
  expect(rejects({ _tag: "buffer.set" })).toBe(true)
})

/**
 * Capability is what stops ts-538b30 handing an agent the whole table.
 *
 * Monotone, so a surface filters with a floor rather than a set: everything the
 * agent tool surface sees is also invocable over the socket, and the overlays
 * are invocable from neither.
 */
test("listing by capability is monotone, and overlays are local only", () => {
  const commands = makeCommands(recording().handlers)
  const names = (floor: Parameters<typeof commands.list>[0]) => commands.list(floor).map((c) => c.name)

  expect(names("local")).toEqual(COMMAND_DEFS.map((def) => def.tag))
  expect(names("agent").every((name) => names("remote").includes(name))).toBe(true)

  const local: CommandTag[] = ["app.settings", "app.command-palette", "app.help", "pane.capture"]
  for (const name of local) expect(names("remote")).not.toContain(name)
  // Quitting the client is scriptable but not something to hand an agent.
  expect(names("remote")).toContain("app.quit")
  expect(names("agent")).not.toContain("app.quit")

  expect(atLeast("agent", "remote")).toBe(true)
  expect(atLeast("local", "remote")).toBe(false)
})

/**
 * Descriptions live in the Schema annotation, not only on the metadata record.
 *
 * That is what makes the agent tool surface a derivation: a JSON Schema built
 * from these members carries the description with it, instead of a second table
 * of prose maintained by hand beside this one.
 */
test("every verb annotates its own description and is unique", () => {
  const tags = COMMAND_DEFS.map((def) => def.tag)
  expect(new Set(tags).size).toBe(tags.length)

  for (const def of COMMAND_DEFS) {
    expect(def.schema.ast.annotations).toMatchObject({
      [Symbol.for("effect/annotation/Description")]: def.desc,
      [Symbol.for("effect/annotation/Identifier")]: def.tag,
    })
    expect(def.desc.length).toBeGreaterThan(0)
    expect(COMMAND_META[def.tag]).toEqual({
      name: def.tag,
      desc: def.desc,
      group: def.group,
      capability: def.capability,
    })
  }
})

/**
 * A failed command says so rather than vanishing.
 *
 * Nothing awaits a dispatched command — the keymap's dispatch is a predicate
 * that has already returned by the time the fiber finishes — so an unobserved
 * failure would be silence.
 */
test("a detached command reports its failure", () => {
  const errors: string[] = []
  const original = console.error
  console.error = (message: string) => void errors.push(message)
  try {
    runDetached("pane.send-keys", Effect.fail(new CommandError({ message: "no pane to send to" })))
    runDetached("pane.zoom", Effect.void)
  } finally {
    console.error = original
  }

  expect(errors).toHaveLength(1)
  expect(errors[0]).toContain("pane.send-keys")
  expect(errors[0]).toContain("no pane to send to")
})
