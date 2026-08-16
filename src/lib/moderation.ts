import { EmbedBuilder, GuildMember } from "discord.js";
import { config } from "../config";

export function isMod(member: GuildMember): boolean {
  return member.roles.cache.some((r) => config.modRoleIds.includes(r.id));
}

export function isGlobalAllowed(member: GuildMember): boolean {
  return (
    config.allowedGlobalUsers.includes(String(member.id)) ||
    member.roles.cache.some((r) => config.allowedGlobalUsers.includes(r.id))
  );
}

export function isAdminRole(member: GuildMember): boolean {
  return !!config.adminRoleId && member.roles.cache.has(config.adminRoleId);
}

export function hasHigherRole(issuer: GuildMember, target: GuildMember): boolean {
  try {
    return issuer.roles.highest.position > target.roles.highest.position;
  } catch {
    return false;
  }
}

export function canTarget(issuer: GuildMember, target: GuildMember): boolean {
  return !isGlobalAllowed(target) || isGlobalAllowed(issuer);
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

  if (isGlobalAllowed(member)) return true;
  const admin = isAdminRole(member);

  switch (action) {
    case "mute":
      return admin || (isMod(member) && !member.roles.cache.has(jrAdmin));
    case "unmute": {
      if (admin) return true;
      const allowed = new Set([...first3, projectManager, chiefAdmin, coChief]);
      return hasAny(member, [...allowed]);
    }
    case "ban":
    case "unban": {
      if (admin) return true;
      const allowed = new Set([...first3, projectManager, chiefAdmin]);
      return hasAny(member, [...allowed]);
    }
    case "kick": {
      if (admin) return true;
      const allowed = new Set([...first3, projectManager, chiefAdmin, coChief]);
      return hasAny(member, [...allowed]);
    }
    case "warn":
      return admin || isMod(member);
    case "remwarn":
    case "clear": {
      if (admin) return true;
      const excluded = new Set([leadDev, "1408925732251500687", jrAdmin]);
      if (!isMod(member)) return false;
      if (member.roles.cache.some((r) => excluded.has(r.id))) return false;
      return true;
    }
    case "temprole":
      return admin || hasAny(member, config.modRoleIds.filter((id) => id !== techAdmin));
    default:
      return admin || false;
  }
}