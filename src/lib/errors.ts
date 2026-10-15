import { Client, EmbedBuilder, TextChannel } from "discord.js";
import { config } from "../config";
import { log } from "./logger";

export async function logErrorToChannel(opts: {
  client: Client;
  commandName: string;
  error: Error | string;
  userLabel: string;
  channelLabel: string;
}): Promise<void> {
  const channelId = config.errorLogChannelId;
  if (!channelId) return;
  const channel = opts.client.channels.cache.get(channelId);
  if (!channel || !(channel instanceof TextChannel)) return;

  const trace = (opts.error instanceof Error ? opts.error.stack || opts.error.message : opts.error).slice(-1500);
  const embed = new EmbedBuilder()
    .setTitle(`⚠️ Помилка в команді: ${opts.commandName}`)
    .setDescription(
      `**Користувач:** ${opts.userLabel}\n**Канал:** ${opts.channelLabel}`,
    )
    .setColor(0xff0000)
    .addFields({
      name: "📝 Повідомлення про помилку",
      value: `\`\`\`\n${trace}\n\`\`\``,
    })
    .setFooter({ text: `Команда: /${opts.commandName}` });

  try {
    await channel.send({ embeds: [embed] });
  } catch (e) {
    log("error", "Не вдалося залогіювати помилку в канал:", e);
  }
}

export function userLabel(user: { username?: string; id?: string } | undefined): string {
  if (!user) return "Невідомий користувач";
  return `${user.username ?? "?"} (${user.id ?? "N/A"})`;
}
