import { Effect } from "effect";

const readSync = (process.getBuiltinModule("node:fs") as typeof import("node:fs")).readSync;

type Command = { readonly type: "start"; readonly fd: number } | { readonly type: "stop" };

const bufferSize = 65536;
let stopped = false;

const read = (fd: number) => {
  const buffer = new Uint8Array(bufferSize);
  while (!stopped) {
    try {
      const size = readSync(fd, buffer, 0, buffer.length, null);
      if (size > 0) {
        const data = buffer.slice(0, size);
        postMessage({ type: "data", data }, [data.buffer]);
        continue;
      }
      Effect.runFork(Effect.sleep("0 millis").pipe(Effect.andThen(Effect.sync(() => read(fd)))));
      return;
    } catch (error: any) {
      if (error?.code === "EAGAIN") {
        Effect.runFork(Effect.sleep("4 millis").pipe(Effect.andThen(Effect.sync(() => read(fd)))));
        return;
      }
      postMessage({ type: "error", code: error?.code ?? "EIO" });
      return;
    }
  }
};

(globalThis as any).onmessage = (event: MessageEvent<Command>) => {
  if (event.data.type === "stop") {
    stopped = true;
    return;
  }
  stopped = false;
  read(event.data.fd);
};
