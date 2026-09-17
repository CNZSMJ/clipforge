import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

/** Use an isolated Web Storage shim only when the runtime provides a nonfunctional stub. */
for (const name of ["localStorage", "sessionStorage"] as const) {
  if (typeof globalThis[name]?.setItem === "function") continue;
  const memory = new Map<string, string>();
  const storage: Storage = {
    get length() { return memory.size; },
    clear() { memory.clear(); },
    getItem(key: string) { return memory.get(key) ?? null; },
    key(index: number) { return Array.from(memory.keys())[index] ?? null; },
    removeItem(key: string) { memory.delete(key); },
    setItem(key: string, value: string) { memory.set(key, String(value)); },
  };
  Object.defineProperty(globalThis, name, { value: storage, configurable: true, writable: true });
}

/** An executable static FFmpeg can still lack drawtext. Probe actual filters, not version text. */
function runnable(bin: unknown): bin is string {
  if (typeof bin !== "string" || !bin) return false;
  try {
    execFileSync(bin, ["-version"], { stdio: "ignore", timeout: 10_000 });
    return true;
  } catch { return false; }
}
function hasMediaFilters(bin: unknown): bin is string {
  if (typeof bin !== "string" || !bin) return false;
  try {
    const filters = execFileSync(bin, ["-hide_banner", "-filters"], { encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "ignore"] });
    return ["drawtext", "subtitles", "showwavespic"].every(name => new RegExp(`\\s${name}\\s`).test(filters));
  } catch { return false; }
}
const require = createRequire(import.meta.url);
let bundled: unknown;
let probe: unknown;
try { bundled = require("ffmpeg-static"); } catch { /* optional platform package */ }
try { probe = (require("@ffprobe-installer/ffprobe") as { path?: unknown })?.path; } catch { /* optional platform package */ }
const ffmpeg = [process.env.FFMPEG_PATH, bundled, "ffmpeg"].find(hasMediaFilters);
if (ffmpeg) process.env.FFMPEG_PATH = ffmpeg;
// Missing capable binaries remain real failures: do not fake or skip rendering assertions.
const ffprobe = [process.env.FFPROBE_PATH, probe, "ffprobe"].find(runnable);
if (ffprobe) process.env.FFPROBE_PATH = ffprobe;
