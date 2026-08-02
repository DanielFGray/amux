import { expect, test } from "bun:test"
import { BufferError, PasteBuffers } from "./BufferStore.ts"

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes)

test("unnamed sets name the buffer with the lowest unused number", () => {
  const buffers = new PasteBuffers()
  expect(buffers.set(undefined, "a")).toBe("0")
  expect(buffers.set(undefined, "b")).toBe("1")
  expect(buffers.set(undefined, "c")).toBe("2")
  // Deleting frees a number for reuse; the next set takes the lowest free one.
  buffers.delete("1")
  expect(buffers.set(undefined, "d")).toBe("1")
})

test("each copy is a new buffer on top of the stack, so the default paste is the newest", () => {
  const buffers = new PasteBuffers()
  expect(buffers.top).toBeNull()
  buffers.set(undefined, "first")
  expect(buffers.top).toBe("0")
  buffers.set(undefined, "second")
  expect(buffers.top).toBe("1")
  expect(text(buffers.show())).toBe("second")
})

test("list reports buffers top-first with their size and a first-line preview", () => {
  const buffers = new PasteBuffers()
  buffers.set(undefined, "alpha\nbeta\n")
  buffers.set(undefined, "gamma")
  expect(buffers.list()).toEqual([
    { name: "1", bytes: 5, preview: "gamma" },
    { name: "0", bytes: 11, preview: "alpha" },
  ])
})

test("a long preview is truncated, not wrapped", () => {
  const buffers = new PasteBuffers()
  const long = "x".repeat(100)
  buffers.set(undefined, long)
  expect(buffers.list()[0]!.preview).toBe(`${"x".repeat(64)}…`)
  expect(buffers.list()[0]!.bytes).toBe(100)
})

test("setting a new named buffer creates it; setting an existing name replaces in place", () => {
  const buffers = new PasteBuffers()
  buffers.set("clip", "one")
  buffers.set(undefined, "top")
  // The unnamed copy sits above it and is the paste default; the numeric
  // name is 0 because "clip" is not a number.
  expect(buffers.set("clip", "two")).toBe("clip")
  expect(buffers.list().map((entry) => entry.name)).toEqual(["0", "clip"])
  expect(text(buffers.show("clip"))).toBe("two")
  // The unnamed copy above it is still the paste default.
  expect(text(buffers.show())).toBe("top")
})

test("delete and show default to the top of the stack", () => {
  const buffers = new PasteBuffers()
  buffers.set(undefined, "first")
  buffers.set(undefined, "second")
  expect(text(buffers.show())).toBe("second")
  buffers.delete()
  expect(text(buffers.show())).toBe("first")
  buffers.delete("0")
  expect(buffers.list()).toEqual([])
})

test("an empty stack or an unknown name is a BufferError with a readable message", () => {
  const buffers = new PasteBuffers()
  expect(() => buffers.show()).toThrow(BufferError)
  expect(() => buffers.show()).toThrow("no buffers to show")
  expect(() => buffers.delete()).toThrow("no buffers to delete")
  buffers.set(undefined, "only")
  expect(() => buffers.show("nope")).toThrow("no buffer 'nope'")
  expect(() => buffers.delete("nope")).toThrow("no buffer 'nope'")
})

test("the stack keeps only the most recent limit buffers", () => {
  const buffers = new PasteBuffers(3)
  for (const value of ["a", "b", "c", "d"]) buffers.set(undefined, value)
  expect(buffers.list().map((entry) => entry.name)).toEqual(["3", "2", "1"])
  // "0" was dropped as the oldest, exactly tmux's buffer-limit behaviour.
  expect(() => buffers.show("0")).toThrow("no buffer '0'")
})
