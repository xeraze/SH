import { EmbedBuilder, GuildMember } from "discord.js";
import { config } from "../config";

export function isMod(member: GuildMember): boolean {
  return member.roles.cache.some((r) => config.modRoleIds.includes(r.id));
}

export function hasHigherRole(issuer: GuildMember, target: GuildMember): boolean {
  try {
    return issuer.roles.highest.position > target.roles.highest.position;
  } catch {
    return false;
  }
}

function hasAny(member: GuildMember, ids: string[]): boolean {
  return member.roles.cache.some((r) => ids.includes(r.id));
}

export function buildModEmbed(
  title: string,
  description: string,
  user?: GuildMember,
): EmbedBuilder {
  const e = new EmbedBuilder({ title, description, color: 0xffa500 });
  e.setFooter({ text: "Sloboda Hospital" });
  if (user) {
    e.setAuthor({ name: user.user.username, iconURL: user.displayAvatarURL() });
  }
  return e;
}

export function canExecute(member: GuildMember, action: string): boolean {
  const first3 = config.modRoleIds.slice(0, 3);
  const jrAdmin = "1409112157832085565";
  const leadDev = "1462864241127194728";
  const projectManager = "1463142695529742488";
  const chiefAdmin = "1462864241563402369";
  const coChief = "1463139795130646631";
  const techAdmin = "1462864229341204562";

  if (config.allowedGlobalUsers.includes(String(member.id))) return true;
  if (config.adminRoleId && member.roles.cache.has(config.adminRoleId)) return true;

  switch (action) {
    case "mute":
      return isMod(member) && !member.roles.cache.has(jrAdmin);
    case "unmute": {
      const allowed = new Set([...first3, projectManager, chiefAdmin, coChief]);
      return hasAny(member, [...allowed]);
    }
    case "ban":
    case "unban": {
      const allowed = new Set([...first3, projectManager, chiefAdmin]);
      return hasAny(member, [...allowed]);
    }
    case "kick": {
      const allowed = new Set([...first3, projectManager, chiefAdmin, coChief]);
      return hasAny(member, [...allowed]);
    }
    case "warn":
      return isMod(member);
    case "remwarn":
    case "clear": {
      const excluded = new Set([leadDev, "1408925732251500687", jrAdmin]);
      if (!isMod(member)) return false;
      if (member.roles.cache.some((r) => excluded.has(r.id))) return false;
      return true;
    }
    case "temprole":
      return hasAny(member, config.modRoleIds.filter((id) => id !== techAdmin));
    default:
      return false;
  }
}