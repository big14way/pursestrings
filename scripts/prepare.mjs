// Builds dist/ when the package is installed from git (npx github:big14way/pursestrings).
// Skipped where TypeScript is not installed, e.g. a production-only install.
import { execSync } from "node:child_process";
import { createRequire } from "node:module";

try {
  createRequire(import.meta.url).resolve("typescript/package.json");
} catch {
  process.exit(0);
}
execSync("npm run build", { stdio: "inherit" });
