import { defineConfig } from "@trigger.dev/sdk/v3";

export default defineConfig({
  project: "proj_lpvgerjdqfhvhgzyeiss",
  runtime: "node",
  logLevel: "log",
  maxDuration: 300,
  retries: {
    enabledInDev: false,
    default: {
      maxAttempts: 2,
      minTimeoutInMs: 5000,
      maxTimeoutInMs: 30000,
      factor: 2,
    },
  },
  dirs: ["./src/trigger"],
});
