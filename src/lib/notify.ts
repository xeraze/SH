import { Client, MessageCreateOptions } from "discord.js";
import { log } from "./logger";

export async function notifyUser(
  client: Client,
  userId: string | null | undefined,
  payload: MessageCreateOptions,
  fallbackChannelId?: string | null,
): Promise<boolean> {
  if (!userId) return false;
  try {
    const user = await client.users.fetch(String(userId));
    if (user.bot) return false;
    await user.send(payload);
    log("info", `ЛС надіслано користувачу ${userId}`);
    return true;
  } catch (e) {
    log("warn", `ЛС користувача ${userId} недоступне:`, e);
    if (fallbackChannelId) {
      try {
        const ch = await client.channels.fetch(fallbackChannelId);
        if (ch && "send" in ch) {
          await ch.send({ content: `<@${userId}>`, ...payload });
          return true;
        }
      } catch (e2) {
        log("warn", `Не вдалося надіслати у фолбек-канал для ${userId}:`, e2);
      }
    }
    return false;
  }
}
