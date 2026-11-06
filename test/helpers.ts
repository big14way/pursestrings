import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, type Config } from "../src/config.js";

export function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "pursestrings-test-"));
}

export function testConfig(env: Record<string, string> = {}, bin?: string): Config {
  return loadConfig({ env: { PURSESTRINGS_STATE_DIR: tempDir(), ...env }, cwd: "/", resolveBin: () => bin });
}
