import { readSync } from "node:fs";

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
      setTimeout(() => read(fd), 0);
      return;
    } catch (error: any) {
      if (error?.code === "EAGAIN") {
        setTimeout(() => read(fd), 4);
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
