import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const DATA_DIR = process.env.TEAM_ROOM_DATA ?? path.join(ROOT, "data");
export const PORT = Number(process.env.TEAM_ROOM_PORT ?? 8791);
// Loopback only: this app holds T3 operate credentials.
export const HOST = "127.0.0.1";
export const ORIGIN = `http://${HOST}:${PORT}`;
export const CALLBACK_URL = `${ORIGIN}/oauth/callback`;
export const CREDENTIALS_FILE = path.join(DATA_DIR, "t3-credentials.json");
export const DB_FILE = path.join(DATA_DIR, "team-room.sqlite");

/**
 * The human lead's first name, used to recognize questions agents address to the lead by name ("Ali, should we…?").
 * Optional: set TEAM_ROOM_LEAD_NAME, or `"leadName"` in data/settings.json. Without it, "you" and "the lead" still work.
 */
export const LEAD_NAME: string | null = (() => {
  const env = process.env.TEAM_ROOM_LEAD_NAME?.trim();
  if (env) return env;
  try {
    const s = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "settings.json"), "utf8"));
    return typeof s.leadName === "string" && s.leadName.trim() ? s.leadName.trim() : null;
  } catch {
    return null;
  }
})();
