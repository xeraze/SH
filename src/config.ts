import "dotenv/config";
import { config as loadDotenv } from "dotenv";
import fs from "node:fs";
import path from "node:path";

const tokenEnvPath = path.join(process.cwd(), "token.env");
if (fs.existsSync(tokenEnvPath)) {
  loadDotenv({ path: tokenEnvPath });
}

function csv(key: string): string[] {
  return (process.env[key] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export const config = {
  token: process.env.TOKEN || process.env.DISCORD_TOKEN || "",
  guildId: process.env.GUILD_ID || "",
  prefix: process.env.PREFIX || "s.",
  adminRoleId: process.env.ADMIN_ROLE_ID || "",
  embedFolder: process.env.EMBED_FOLDER || "data",
  modLogChannelId: process.env.MOD_LOG_CHANNEL_ID || "",
  blacklistRoleId: process.env.BLACKLIST_ROLE_ID || "",
  muteRoleId: process.env.MUTE_ROLE_ID || "",
  modRoleIds: csv("MOD_ROLE_IDS"),
  allowedGlobalUsers: csv("ALLOWED_GLOBAL_USERS"),
  embedsReloadUsers: csv("EMBEDS_RELOAD_USERS"),
  dataDir: path.join(process.cwd(), "data"),
} as const;