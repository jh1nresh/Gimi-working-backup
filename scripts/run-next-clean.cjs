#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports */

const { spawn } = require("node:child_process");
const path = require("node:path");

const nextBin = require.resolve("next/dist/bin/next");
const warningHook = path.join(__dirname, "suppress-bigint-buffer-warning.cjs");
const existingNodeOptions = process.env.NODE_OPTIONS || "";
const nodeOptions = [`--require=${warningHook}`, existingNodeOptions].filter(Boolean).join(" ");

const child = spawn(process.execPath, [nextBin, ...process.argv.slice(2)], {
  stdio: "inherit",
  env: {
    ...process.env,
    NODE_OPTIONS: nodeOptions,
  },
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.exit(1);
  }

  process.exit(code ?? 1);
});
