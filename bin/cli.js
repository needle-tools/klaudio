#!/usr/bin/env node

import { run } from "../src/cli.js";

run().catch((err) => {
  if (err.name === "ExitPromptError") {
    // User pressed Ctrl+C
    console.log("\n  Cancelled.\n");
    process.exit(0);
  }
  console.error(err);
  process.exit(1);
});
