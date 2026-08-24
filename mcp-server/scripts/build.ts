import { chmod } from "node:fs/promises";

const result = await Bun.build({
  entrypoints: ["src/index.ts"],
  target: "node",
  outdir: "dist",
  naming: "index.js",
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  throw new Error("MCP Server build failed");
}

const outputPath = "dist/index.js";
const output = await Bun.file(outputPath).text();
if (!output.startsWith("#!")) {
  await Bun.write(outputPath, `#!/usr/bin/env node\n${output}`);
}
await chmod(outputPath, 0o755);
