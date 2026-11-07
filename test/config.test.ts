import { describe, expect, it } from "vitest";
import { DEFAULT_FAST_MODEL, DEFAULT_PLANNER_MODEL, loadConfig, SERV_BASE_URL } from "../src/config.js";

const none = () => undefined;

describe("loadConfig", () => {
  it("runs with zero credentials in mock and simulator mode", () => {
    const config = loadConfig({ env: {}, cwd: "/work", resolveBin: none });
    expect(config.serv.mode).toBe("mock");
    expect(config.kpass.mode).toBe("sim");
    expect(config.serv.baseURL).toBe(SERV_BASE_URL);
    expect(config.serv.plannerModel).toBe(DEFAULT_PLANNER_MODEL);
    expect(config.serv.fastModel).toBe(DEFAULT_FAST_MODEL);
    expect(config.stateDir).toBe("/work/.pursestrings");
  });

  it("goes live when a key and a kpass binary are present", () => {
    const config = loadConfig({ env: { SERV_API_KEY: "k" }, cwd: "/", resolveBin: () => "/bin/kpass" });
    expect(config.serv.mode).toBe("live");
    expect(config.kpass).toMatchObject({ mode: "live", bin: "/bin/kpass" });
  });

  it("honours explicit mock and sim overrides", () => {
    const config = loadConfig({ env: { SERV_API_KEY: "k", SERV_MODE: "mock", KPASS_MODE: "sim" }, resolveBin: () => "/bin/kpass" });
    expect(config.serv.mode).toBe("mock");
    expect(config.kpass.mode).toBe("sim");
  });

  it("refuses live modes that cannot work", () => {
    expect(() => loadConfig({ env: { SERV_MODE: "live" }, resolveBin: none })).toThrow(/SERV_API_KEY/);
    expect(() => loadConfig({ env: { KPASS_MODE: "live" }, resolveBin: none })).toThrow(/kpass/);
    expect(() => loadConfig({ env: { SERV_MODE: "maybe" }, resolveBin: none })).toThrow(/SERV_MODE/);
    expect(() => loadConfig({ env: { KPASS_TIMEOUT_MS: "-1" }, resolveBin: none })).toThrow(/KPASS_TIMEOUT_MS/);
  });

  it("reads the Passport backend URL", () => {
    expect(loadConfig({ env: {}, resolveBin: none }).kpass.baseURL).toBeUndefined();
    expect(loadConfig({ env: { KPASS_BASE_URL: " https://passport.dev.gokite.ai " }, resolveBin: none }).kpass.baseURL).toBe("https://passport.dev.gokite.ai");
  });

  it("treats a blank key as absent", () => {
    expect(loadConfig({ env: { SERV_API_KEY: "  " }, resolveBin: none }).serv.mode).toBe("mock");
  });
});
