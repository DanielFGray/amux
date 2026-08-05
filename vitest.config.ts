import { defineConfig } from "vitest/config";
import { transformSolidSource } from "./node_modules/@opentui/solid/scripts/solid-transform.js";

export default defineConfig({
  resolve: {
    conditions: ["bun", "import", "default"],
  },
  plugins: [
    {
      name: "opentui-solid",
      enforce: "pre",
      async transform(code, id) {
        if (!/\.[jt]sx$/.test(id) || id.includes("/node_modules/")) return;
        return {
          code: await transformSolidSource(code, {
            filename: id,
            resolvePath: (specifier) =>
              specifier === "solid-js" ? "solid-js/dist/solid.js" : specifier,
          }),
          map: null,
        };
      },
    },
  ],
  test: {
    environment: "node",
    pool: "forks",
    fileParallelism: false,
    maxWorkers: 1,
    minWorkers: 1,
    include: ["src/**/*.test.ts", "src/**/*.test.tsx", "e2e/**/*.test.ts"],
  },
});
