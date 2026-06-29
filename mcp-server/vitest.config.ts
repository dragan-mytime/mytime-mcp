import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // NodeNext source uses ".js" import specifiers that point at ".ts" files.
    extensionAlias: { ".js": [".ts", ".js"] },
  },
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
});
