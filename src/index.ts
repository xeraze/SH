import { execSync } from "node:child_process";
import crypto from "node:crypto";
import {
  ActionRowBuilder,
  ActivityType,
  ButtonBuilder,
  ButtonStyle,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  GuildMember,
  MessageFlags,
  ModalActionRowComponentBuilder,
  ModalBuilder,
  REST,
  Routes,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  TextChannel,
  TextInputBuilder,
  TextInputStyle,
  type ChatInputCommandInteraction,
  type Interaction,
  type RESTPostAPIChatInputApplicationCommandsJSONBody,
  type StringSelectMenuInteraction,
} from "discord.js";
import { config } from "./config";
import { baseEmbed, loadEmbeds, jsonToEmbed, type EmbedData, type SelectOption } from "./lib/embeds";
import { logErrorToChannel, userLabel } from "./lib/errors";
import { log } from "./lib/logger";
import { notifyUser } from "./lib/notify";
import { parseDuration } from "./lib/duration";
import {
  buildModEmbed,
  canExecute,
  canTarget,
  hasHigherRole,
  isAdminRole,
  isGlobalAllowed,
} from "./lib/moderation";
import {
  loadBans,
  loadMutes,
  loadReprimands,
  loadTemproles,
  loadWarns,
  nextReprimandId,
  nextWarnId,
  saveBans,
  saveMutes,
  saveReprimands,
  saveTemproles,
  saveWarns,
  type PunishmentType,
} from "./store/punishments";

if (!config.token) {
  console.error("TOKEN не задано в token.env");
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
});

let globalEmbeds: Record<string, EmbedData> = loadEmbeds(config.embedFolder);

const BAN_TYPE_LABELS: Record<PunishmentType, string> = {
  temporary: "Тимчасовий",
  temporary_no_appeal: "Тимчасовий без апеляції",
  permanent: "Перманентний",
  permanent_no_appeal: "Перманентний без апеляції",
};

function isTemporary(type: PunishmentType): boolean {
  return type === "temporary" || type === "temporary_no_appeal";
}

function humanDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const parts: string[] = [];
  if (d) parts.push(`${d} д.`);
  if (h) parts.push(`${h} год.`);
  if (m) parts.push(`${m} хв.`);
  return parts.join(" ") || `${s} с.`;
}

function nowTs(): number {
  return Math.floor(Date.now() / 1000);
}

function formatBytes(kb: number): string {
  if (kb >= 1048576) return `${(kb / 1048576).toFixed(1)} ГБ`;
  if (kb >= 1024) return `${(kb / 1024).toFixed(1)} МБ`;
  return `${Math.round(kb)} КБ`;
}

function diskUsage(): string {
  try {
    const out = execSync("df -k /home/container 2>/dev/null || df -k /", { encoding: "utf8" });
    const line = out.trim().split("\n").filter((l) => !l.startsWith("Filesystem")).pop();
    if (!line) return "—";
    const parts = line.split(/\s+/).filter(Boolean);
    if (parts.length < 5) return "—";
    const used = Number(parts[2]);
    const available = Number(parts[3]);
    const total = used + available;
    const pct = total > 0 ? Math.round((used / total) * 100) : 0;
    return `${formatBytes(used)} / ${formatBytes(total)} (${pct}%) · вільно ${formatBytes(available)}`;
  } catch {
    return "—";
  }
}

function formatUptime(ms: number): string {
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const parts: string[] = [];
  if (d) parts.push(`${d} дн.`);
  if (h) parts.push(`${h} год.`);
  if (m) parts.push(`${m} хв.`);
  parts.push(`${sec} сек.`);
  return parts.join(" ");
}

function memberOf(interaction: ChatInputCommandInteraction): GuildMember | null {
  return interaction.member as GuildMember | null;
}

function isAdmin(interaction: ChatInputCommandInteraction): boolean {
  const member = memberOf(interaction);
  return (
    !!member &&
    (member.roles.cache.has(config.adminRoleId) || isGlobalAllowed(member))
  );
}

async function replyEphemeral(interaction: ChatInputCommandInteraction, content: string): Promise<void> {
  await interaction.reply({ content, flags: MessageFlags.Ephemeral }).catch(() => undefined);
}

async function replyOk(interaction: ChatInputCommandInteraction, content: string): Promise<void> {
  await replyEphemeral(interaction, content);
}

async function replyErr(interaction: ChatInputCommandInteraction, content: string): Promise<void> {
  await replyEphemeral(interaction, content);
}

async function sendPublic(
  interaction: ChatInputCommandInteraction,
  embed: EmbedBuilder,
): Promise<void> {
  const channel = interaction.channel;
  if (!channel || !("send" in channel)) return;
  try {
    const msg = await channel.send({ embeds: [embed] });
    setTimeout(() => msg.delete().catch(() => undefined), 15_000);
  } catch {}
}

async function dmUser(member: GuildMember, embed: EmbedBuilder): Promise<void> {
  await notifyUser(client, member.id, { embeds: [embed] });
}

async function logToModChannel(embed: EmbedBuilder): Promise<void> {
  if (!config.modLogChannelId) return;
  const ch = client.channels.cache.get(config.modLogChannelId);
  if (ch instanceof TextChannel) {
    try {
      await ch.send({ embeds: [embed] });
    } catch {}
  }
}

async function resolveMember(
  interaction: ChatInputCommandInteraction,
  option: string,
): Promise<GuildMember | null> {
  const user = interaction.options.getUser(option);
  if (!user || !interaction.guild) return null;
  try {
    return await interaction.guild.members.fetch(user.id);
  } catch {
    return null;
  }
}

function modActionEmbed(opts: {
  title: string;
  color: number;
  target: string;
  executor: string;
  type?: string;
  duration?: string;
  until?: string;
  reason?: string;
}): EmbedBuilder {
  const e = buildModEmbed(opts.title, opts.target);
  e.addFields(
    { name: "Модератор:", value: opts.executor, inline: true },
    { name: "Коли:", value: `<t:${nowTs()}:F>`, inline: true },
  );
  if (opts.type) e.addFields({ name: "Вид:", value: opts.type, inline: true });
  if (opts.duration) e.addFields({ name: "Тривалість:", value: opts.duration, inline: true });
  if (opts.until) e.addFields({ name: "До:", value: `<t:${opts.until}:F>`, inline: true });
  e.addFields({ name: "Причина:", value: opts.reason || "Не вказано", inline: false });
  return e;
}

function buildEmbedView(selects?: SelectOption[]): ActionRowBuilder<StringSelectMenuBuilder>[] {
  if (!selects || selects.length === 0) return [];
  const options = selects.map((s) => {
    const opt = new StringSelectMenuOptionBuilder()
      .setLabel(s.label || s.value || "")
      .setValue(s.value || s.label || "");
    if (s.description) opt.setDescription(s.description);
    return opt;
  });
  return [
    new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId("embed_menu")
        .setPlaceholder("Оберіть, що вас цікавить з цього")
        .setMinValues(1)
        .setMaxValues(1)
        .addOptions(options),
    ),
  ];
}

async function handleEmbedMenu(interaction: StringSelectMenuInteraction): Promise<void> {
  if (interaction.customId !== "embed_menu") return;
  const val = interaction.values[0];
  const embeds = globalEmbeds;

  if (val.startsWith("open:")) {
    const key = val.slice(5);
    const data = embeds[key];
    if (data) {
      const embedsSrc = data.embeds?.length
        ? data.embeds
        : data.embed
          ? [data.embed]
          : [];
      const embObjs = embedsSrc.map((src) => jsonToEmbed(src)).filter((e) => e.data?.description || e.data?.title);
      const fullText = data.content || "";
      if (embObjs.length > 0) {
        await interaction.reply({
          embeds: embObjs,
          content: fullText || undefined,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      await interaction.reply({ content: fullText || `Ви обрали: ${key}`, flags: MessageFlags.Ephemeral });
      return;
    }
    await interaction.reply({ content: `Ви обрали: ${key}`, flags: MessageFlags.Ephemeral });
    return;
  }

  await interaction.reply({ content: `Ви обрали: ${val}`, flags: MessageFlags.Ephemeral });
}

async function sendEmbedData(
  interaction: ChatInputCommandInteraction,
  data: EmbedData,
  successLabel: string,
): Promise<void> {
  const srcs = data.embeds?.length ? data.embeds : data.embed ? [data.embed] : [];
  const embObjs = srcs.map((src) => jsonToEmbed(src)).filter((e) => e.data?.description || e.data?.title);
  const view = buildEmbedView(data.selects);
  const content = data.content || undefined;
  const channel = interaction.channel as TextChannel | null;
  if (!channel || !("send" in channel)) {
    await replyEphemeral(interaction, "Цю команду необхідно використовувати в текстовому каналі.");
    return;
  }
  try {
    await channel.send({ content, embeds: embObjs, components: view });
  } catch (e) {
    await replyErr(interaction, `Не вдалося надіслати: ${e}`);
    return;
  }
  await replyOk(interaction, successLabel);
}

async function cmdMenu(interaction: ChatInputCommandInteraction): Promise<void> {
  const data = globalEmbeds["menu"];
  if (!data) {
    await replyEphemeral(interaction, "Меню не знайдено. Додайте `data/embeds/menu.json`.");
    return;
  }
  await sendEmbedData(interaction, data, "✅ Меню опубліковано в канал.");
}

async function cmdEmbed(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!isAdmin(interaction)) {
    await replyEphemeral(interaction, "У вас немає прав для цієї команди.");
    return;
  }
  const key = (interaction.options.getString("name") || "").trim();
  const data = globalEmbeds[key];
  if (!data) {
    await replyEphemeral(
      interaction,
      `Ембед \`${key}\` не знайдено. Доступні: ${Object.keys(globalEmbeds).sort().join(", ")}`,
    );
    return;
  }
  await sendEmbedData(interaction, data, "✅ Ембед опубліковано в канал.");
}

async function cmdEmbeds(interaction: ChatInputCommandInteraction): Promise<void> {
  const names = Object.keys(globalEmbeds).sort();
  if (names.length === 0) {
    await replyEphemeral(interaction, "Немає доступних ембедів.");
    return;
  }
  await replyEphemeral(interaction, "**Доступні ембеди:**\n" + names.join(", "));
}

async function cmdEmbedsReload(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!(config.embedsReloadUsers ?? []).includes(String(interaction.user.id))) {
    await replyErr(interaction, "У вас немає прав для виконання цієї команди.");
    return;
  }
  globalEmbeds = loadEmbeds(config.embedFolder);
  await replyEphemeral(interaction, `Завантажено ${Object.keys(globalEmbeds).length} ембедів.`);
}

async function cmdSay(interaction: ChatInputCommandInteraction): Promise<void> {
  const member = memberOf(interaction);
  const hasModRole = member?.roles.cache.some((r) => config.modRoleIds.includes(r.id)) ?? false;
  if (
    !member ||
    (!isAdmin(interaction) &&
      !isGlobalAllowed(member) &&
      !hasModRole)
  ) {
    await replyErr(interaction, "У вас немає прав для виконання цієї команди.");
    return;
  }
  const text = interaction.options.getString("text", true);
  const channel = interaction.channel as TextChannel | null;
  await channel?.send(text).catch(() => undefined);
  await replyOk(interaction, "✅ Повідомлення надіслано.");
}

async function cmdHelp(interaction: ChatInputCommandInteraction): Promise<void> {
  const commands: [string, string][] = [
    ["menu", "Меню сервера"],
    ["embed <name>", "Надіслати ембед (адмін)"],
    ["embeds", "Список ембедів"],
    ["embeds-reload", "Перезавантажити ембеди (адмін)"],
    ["say <text>", "Надіслати текст від імені бота (адмін)"],
    ["post", "Опублікувати пост у канал"],
    ["status", "Інформація про бота"],
    ["warn <user> [reason]", "Попередження"],
    ["warns [user]", "Список попереджень"],
    ["unwarn <user> [id]", "Зняти попередження"],
    ["reprimand <user> [reason]", "Видати догану"],
    ["reprimands [user]", "Список доган"],
    ["kick <user> [reason]", "Кік"],
    ["ban <user> <type> [duration] [reason]", "Бан (тип: temporary/permanent)"],
    ["unban <id> [reason]", "Розбан"],
    ["mute <user> <duration> <type> [reason]", "Мут (таймаут + роль ізолятора)"],
    ["unmute <user> [reason]", "Зняти мут"],
    ["mutes", "Список мутів"],
    ["temprole <user> <role> <duration> [reason]", "Тимчасова роль"],
    ["unrole <user> <role> [reason]", "Зняти роль"],
    ["temproles [user]", "Список тимчасових ролей"],
    ["clear <count> [user]", "Очистити повідомлення"],
    ["blacklist <user> [reason]", "Внести до ЧС"],
    ["unblacklist <user> [reason]", "Прибрати з ЧС"],
  ];
  const lines = commands.map(([sig, brief]) => `\`/${sig}\` — ${brief}`);
  await replyEphemeral(interaction, `**Команди бота**\n\n${lines.join("\n")}`);
}

async function cmdStatus(interaction: ChatInputCommandInteraction): Promise<void> {
  const embed = new EmbedBuilder({
    color: 0x3498db,
    title: "Статус бота",
    thumbnail: { url: client.user?.displayAvatarURL() ?? "" },
  });
  const commands = buildCommands();
  const lines = [
    `🤖 Бот: **${client.user?.tag ?? "?"}**`,
    `📶 Пінг: \`${client.ws.ping} мс\``,
    `⏱ Аптайм: \`${formatUptime(client.uptime ?? 0)}\``,
    `🖥 Сервер: \`${interaction.guild?.name ?? "—"}\``,
    `📝 Команд: \`${commands.length}\``,
    `👤 Користувачів на сервері: \`${interaction.guild?.memberCount ?? "—"}\``,
    `⚠️ Попереджень: \`${loadWarns().length}\``,
    `🏳️ Доган: \`${loadReprimands().length}\``,
    `🔇 Активних мутів: \`${loadMutes().length}\``,
    `🚫 Банів у базі: \`${loadBans().length}\``,
    `⏱ Тимчасових ролей: \`${loadTemproles().length}\``,
    `💽 Диск: \`${diskUsage()}\``,
  ];
  embed.setDescription(lines.join("\n")).setFooter({ text: `Shard: ${interaction.guild?.shardId ?? 0}` });
  await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral }).catch(() => undefined);
}

async function cmdWarn(interaction: ChatInputCommandInteraction): Promise<void> {
  const issuer = memberOf(interaction);
  if (!issuer) return;
  if (!canExecute(issuer, "warn")) {
    await replyErr(interaction, "Недостатньо прав.");
    return;
  }
  const target = await resolveMember(interaction, "user");
  if (!target) {
    await replyErr(interaction, "Користувача не знайдено.");
    return;
  }
  if (!canTarget(issuer, target) || (!hasHigherRole(issuer, target) && issuer.id !== interaction.guild!.ownerId)) {
    await replyErr(interaction, "Ви не можете попереджати користувача з роллю вище або ідентичною вашій.");
    return;
  }
  const warns = loadWarns().filter((w) => String(w.user_id) === String(target.id));
  const reprimands = loadReprimands().filter((r) => String(r.user_id) === String(target.id));
  if (reprimands.length >= 3) {
    await replyErr(
      interaction,
      `У ${target.toString()} вже 3 догани. Далі доступні лише мут, кік або бан.`,
    );
    return;
  }
  if (warns.length >= 5) {
    await replyErr(
      interaction,
      `У ${target.toString()} вже ${warns.length} попереджень (максимум 5). Використайте /reprimand.`,
    );
    return;
  }
  const reason = interaction.options.getString("reason") || "Причина не вказана";

  const entry = {
    id: nextWarnId(),
    user_id: String(target.id),
    moderator_id: String(issuer.id),
    reason,
    created_at: new Date().toISOString(),
  };
  const allWarns = loadWarns();
  allWarns.unshift(entry);
  saveWarns(allWarns);

  const dm = buildModEmbed(
    "Вас попереджено",
    `Вас попереджено модератором ${issuer.toString()}.\nПричина: ${reason}\n\nЯкщо ви бажаєте перегляду вашого покарання модерацією, заповніть апеляційну форму в каналі https://discord.com/channels/1465334351452569800/1466418410035482706.`,
  );
  await dmUser(target, dm);

  const embed = modActionEmbed({
    title: "Видано попередження",
    color: 0xffa500,
    target: target.toString(),
    executor: `${issuer.user.username} (ID: ${issuer.id})`,
    reason,
  });
  await sendPublic(interaction, embed);
  await logToModChannel(embed);
  await replyOk(interaction, "✅ Попередження видано.");
}

async function cmdWarns(interaction: ChatInputCommandInteraction): Promise<void> {
  const target = interaction.options.getUser("user")
    ? await resolveMember(interaction, "user")
    : memberOf(interaction);
  if (!target) return;
  if (!target) {
    await replyErr(interaction, "Користувача не знайдено.");
    return;
  }
  const warns = loadWarns().filter((w) => String(w.user_id) === String(target.id));
  if (warns.length === 0) {
    await replyEphemeral(interaction, `У ${target.toString()} немає попереджень.`);
    return;
  }
  const desc = warns
    .slice(0, 10)
    .map((w) => `#${w.id} by <@${w.moderator_id}>: ${w.reason} (${w.created_at})`)
    .join("\n");
  const e = new EmbedBuilder({ title: `Попередження: ${target.user.username}`, description: desc });
  await interaction.reply({ embeds: [e], flags: MessageFlags.Ephemeral }).catch(() => undefined);
}

async function cmdUnwarn(interaction: ChatInputCommandInteraction): Promise<void> {
  const issuer = memberOf(interaction);
  if (!issuer) return;
  if (!canExecute(issuer, "remwarn")) {
    await replyErr(interaction, "Недостатньо прав.");
    return;
  }
  const target = await resolveMember(interaction, "user");
  if (!target) {
    await replyErr(interaction, "Користувача не знайдено.");
    return;
  }
  const reason = interaction.options.getString("reason") || "Причина не вказана";
  const warnId = interaction.options.getInteger("id");

  let warns = loadWarns();
  if (warnId !== null) {
    warns = warns.filter((w) => !(w.id === warnId && String(w.user_id) === String(target.id)));
  } else {
    const idx = warns.findIndex((w) => String(w.user_id) === String(target.id));
    if (idx !== -1) warns.splice(idx, 1);
  }
  saveWarns(warns);

  const embed = modActionEmbed({
    title: "Попередження знято",
    color: 0x2ecc71,
    target: target.toString(),
    executor: `${issuer.user.username} (ID: ${issuer.id})`,
    reason,
  });
  await logToModChannel(embed);
  await replyOk(interaction, `Попередження видалено для ${target.toString()}.`);
}

async function cmdReprimand(interaction: ChatInputCommandInteraction): Promise<void> {
  const issuer = memberOf(interaction);
  if (!issuer) return;
  if (!canExecute(issuer, "warn")) {
    await replyErr(interaction, "Недостатньо прав.");
    return;
  }
  const target = await resolveMember(interaction, "user");
  if (!target) {
    await replyErr(interaction, "Користувача не знайдено.");
    return;
  }
  if (!canTarget(issuer, target) || (!hasHigherRole(issuer, target) && issuer.id !== interaction.guild!.ownerId)) {
    await replyErr(interaction, "Ви не можете видавати догану цьому користувачу.");
    return;
  }
  const reprimands = loadReprimands().filter((r) => String(r.user_id) === String(target.id));
  if (reprimands.length >= 3) {
    await replyErr(
      interaction,
      `У ${target.toString()} вже 3 догани. Далі доступні лише мут, кік або бан.`,
    );
    return;
  }
  const reason = interaction.options.getString("reason") || "Причина не вказана";

  const entry = {
    id: nextReprimandId(),
    user_id: String(target.id),
    moderator_id: String(issuer.id),
    reason,
    created_at: new Date().toISOString(),
  };
  const all = loadReprimands();
  all.unshift(entry);
  saveReprimands(all);

  const dm = buildModEmbed(
    "Вам винесено догану",
    `Вам винесено догану модератором ${issuer.toString()}.\nПричина: ${reason}\n\nЯкщо ви бажаєте перегляду вашого покарання модерацією, заповніть апеляційну форму в каналі https://discord.com/channels/1465334351452569800/1466418410035482706.`,
  );
  await dmUser(target, dm);

  const embed = modActionEmbed({
    title: "Винесено догану",
    color: 0xe67e22,
    target: target.toString(),
    executor: `${issuer.user.username} (ID: ${issuer.id})`,
    reason,
  });
  await sendPublic(interaction, embed);
  await logToModChannel(embed);
  await replyOk(interaction, "✅ Догану винесено.");
}

async function cmdReprimands(interaction: ChatInputCommandInteraction): Promise<void> {
  const target = interaction.options.getUser("user")
    ? await resolveMember(interaction, "user")
    : memberOf(interaction);
  if (!target) return;
  if (!target) {
    await replyErr(interaction, "Користувача не знайдено.");
    return;
  }
  const rows = loadReprimands().filter((r) => String(r.user_id) === String(target.id));
  if (rows.length === 0) {
    await replyEphemeral(interaction, `У ${target.toString()} немає доган.`);
    return;
  }
  const desc = rows
    .slice(0, 10)
    .map((r) => `#${r.id} by <@${r.moderator_id}>: ${r.reason} (${r.created_at})`)
    .join("\n");
  const e = new EmbedBuilder({ title: `Догани: ${target.user.username}`, description: desc });
  await interaction.reply({ embeds: [e], flags: MessageFlags.Ephemeral }).catch(() => undefined);
}

async function cmdKick(interaction: ChatInputCommandInteraction): Promise<void> {
  const issuer = memberOf(interaction);
  if (!issuer) return;
  if (!canExecute(issuer, "kick")) {
    await replyErr(interaction, "Недостатньо прав.");
    return;
  }
  const target = await resolveMember(interaction, "user");
  if (!target) {
    await replyErr(interaction, "Користувача не знайдено.");
    return;
  }
  if (!canTarget(issuer, target) || (!hasHigherRole(issuer, target) && issuer.id !== interaction.guild!.ownerId)) {
    await replyErr(interaction, "Ви не можете кікати цього користувача.");
    return;
  }
  const reason = interaction.options.getString("reason") || "Причина не вказана";
  try {
    await target.kick(reason);
    const embed = modActionEmbed({
      title: "Користувача вигнано",
      color: 0xff5733,
      target: target.toString(),
      executor: `${issuer.user.username} (ID: ${issuer.id})`,
      reason,
    });
    await sendPublic(interaction, embed);
    const dm = buildModEmbed(
      "Вас вигнали з сервера",
      `Вас вигнав модератор ${issuer.toString()}.\nПричина: ${reason}\n\nЯкщо ви бажаєте перегляду вашого покарання модерацією, заповніть апеляційну форму в каналі https://discord.com/channels/1465334351452569800/1466418410035482706.`,
    );
    await dmUser(target, dm);
    await logToModChannel(embed);
    await replyOk(interaction, "✅ Користувача вигнано.");
  } catch (e) {
    await replyErr(interaction, `Не вдалося кікнути користувача: ${e}`);
  }
}

async function cmdBan(interaction: ChatInputCommandInteraction): Promise<void> {
  const issuer = memberOf(interaction);
  if (!issuer) return;
  if (!canExecute(issuer, "ban")) {
    await replyErr(interaction, "Недостатньо прав.");
    return;
  }
  const target = await resolveMember(interaction, "user");
  if (!target) {
    await replyErr(interaction, "Користувача не знайдено.");
    return;
  }
  if (!canTarget(issuer, target) || (!hasHigherRole(issuer, target) && issuer.id !== interaction.guild!.ownerId)) {
    await replyErr(interaction, "Ви не можете забанити цього користувача.");
    return;
  }
  const type = (interaction.options.getString("type") || "permanent") as PunishmentType;
  const durationStr = interaction.options.getString("duration") || "";
  const reason = interaction.options.getString("reason") || "Причина не вказана";

  let until: number | null = null;
  let ms: number | null = null;
  if (isTemporary(type)) {
    ms = parseDuration(durationStr);
    if (ms === null) {
      await replyErr(
        interaction,
        "Для тимчасового бана вкажіть тривалість (напр. 15m, 2h, 1d).",
      );
      return;
    }
    until = Date.now() + ms;
  }

  const auditReason = `${issuer.user.username} (ID: ${issuer.id}): ${reason}`;
  try {
    await target.ban({ reason: auditReason });
    const untilIso = until ? new Date(until).toISOString() : null;
    const bans = loadBans();
    bans.push({
      user_id: String(target.id),
      moderator_id: String(issuer.id),
      type,
      duration: isTemporary(type) ? durationStr : "Не вказано",
      until: untilIso,
      reason,
      created_at: new Date().toISOString(),
    });
    saveBans(bans);

    const embed = modActionEmbed({
      title: "Користувача заблоковано",
      color: 0xe74c3c,
      target: target.toString(),
      executor: `${issuer.user.username} (ID: ${issuer.id})`,
      type: BAN_TYPE_LABELS[type],
      duration: isTemporary(type) ? durationStr : "Не вказано",
      until: until ? String(Math.floor(until / 1000)) : undefined,
      reason,
    });
    await sendPublic(interaction, embed);
    const dm = buildModEmbed(
      "Вас заблоковано",
      `Вас заблокував модератор ${issuer.toString()}.\nВид: ${BAN_TYPE_LABELS[type]}\n${
        until ? `До: ${new Date(until).toISOString()} UTC\n` : ""
      }Причина: ${reason}\n\nЯкщо ви бажаєте перегляду вашого покарання модерацією, заповніть апеляційну форму в каналі https://discord.com/channels/1465334351452569800/1466418410035482706.`,
    );
    await dmUser(target, dm);
    await logToModChannel(embed);
    await replyOk(interaction, "✅ Користувача заблоковано.");
  } catch (e) {
    await replyErr(interaction, `Не вдалося забанити користувача: ${e}`);
  }
}

async function cmdUnban(interaction: ChatInputCommandInteraction): Promise<void> {
  const issuer = memberOf(interaction);
  if (!issuer) return;
  if (!canExecute(issuer, "unban")) {
    await replyErr(interaction, "Недостатньо прав.");
    return;
  }
  const userId = (interaction.options.getString("id") || "").trim();
  if (!/^\d{15,21}$/.test(userId)) {
    await replyErr(interaction, "Вкажіть ID користувача.");
    return;
  }
  const reason = interaction.options.getString("reason") || "Причина не вказана";
  try {
    const user = await client.users.fetch(userId);
    await interaction.guild!.bans.remove(user, `${issuer.user.username} (ID: ${issuer.id}): ${reason}`);
    const bans = loadBans().filter((b) => String(b.user_id) !== userId);
    saveBans(bans);
    const embed = modActionEmbed({
      title: "Користувача розблоковано",
      color: 0x2ecc71,
      target: user.toString(),
      executor: `${issuer.user.username} (ID: ${issuer.id})`,
      reason,
    });
    await sendPublic(interaction, embed);
    await logToModChannel(embed);
    await replyOk(interaction, "✅ Користувача розбанено.");
  } catch (e) {
    await replyErr(interaction, `Не вдалося розбанити: ${e}`);
  }
}

async function cmdMute(interaction: ChatInputCommandInteraction): Promise<void> {
  const issuer = memberOf(interaction);
  if (!issuer) return;
  if (!canExecute(issuer, "mute")) {
    await replyErr(interaction, "Недостатньо прав.");
    return;
  }
  const target = await resolveMember(interaction, "user");
  if (!target) {
    await replyErr(interaction, "Користувача не знайдено.");
    return;
  }
  if (!canTarget(issuer, target) || (!hasHigherRole(issuer, target) && issuer.id !== interaction.guild!.ownerId)) {
    await replyErr(interaction, "Ви не можете замутити цього користувача.");
    return;
  }
  const type = (interaction.options.getString("type") || "temporary") as "temporary" | "permanent";
  const durationStr = interaction.options.getString("duration") || "";
  const reason = interaction.options.getString("reason") || "Причина не вказана";

  const ms = parseDuration(durationStr);
  if (ms === null) {
    await replyErr(
      interaction,
      "Невірний формат тривалості. Використовуйте формат 15m/2h/1d.",
    );
    return;
  }
  if (!config.muteRoleId) {
    await replyErr(interaction, "Роль ізолятора (MUTE_ROLE_ID) не налаштована.");
    return;
  }

  const untilMs = type === "permanent" ? null : Date.now() + ms;
  try {
    if (type === "permanent") {
      await target.timeout(null).catch(() => undefined);
    } else {
      await target.timeout(ms, reason);
    }
    await target.roles.add(config.muteRoleId, `mute by ${issuer.user.username} (ID: ${issuer.id})`);

    const untilIso = untilMs ? new Date(untilMs).toISOString() : null;
    const mutes = loadMutes();
    mutes.push({
      user_id: String(target.id),
      moderator_id: String(issuer.id),
      type,
      until: untilIso,
      duration: durationStr,
      reason,
      created_at: new Date().toISOString(),
    });
    saveMutes(mutes);

    const embed = modActionEmbed({
      title: "Користувача замучено",
      color: 0xffa500,
      target: target.toString(),
      executor: `${issuer.user.username} (ID: ${issuer.id})`,
      type: type === "permanent" ? "Перманентний" : "Тимчасовий",
      duration: type === "permanent" ? "не вказано" : humanDuration(ms),
      until: untilMs ? String(Math.floor(untilMs / 1000)) : undefined,
      reason,
    });
    await sendPublic(interaction, embed);
    const dm = buildModEmbed(
      "Вам заборонили спілкування",
      `Вас замучено модератором ${issuer.toString()}.\nВид: ${type === "permanent" ? "Перманентний" : "Тимчасовий"}\n${
        untilMs ? `До: ${new Date(untilMs).toISOString()} UTC\n` : ""
      }Причина: ${reason}\n\nЯкщо ви бажаєте перегляду вашого покарання модерацією, заповніть апеляційну форму в каналі https://discord.com/channels/1465334351452569800/1466418410035482706.`,
    );
    await dmUser(target, dm);
    await logToModChannel(embed);
    await replyOk(interaction, "✅ Користувача замучено.");
  } catch (e) {
    await replyErr(interaction, `Не вдалося замутити користувача: ${e}`);
  }
}

async function cmdUnmute(interaction: ChatInputCommandInteraction): Promise<void> {
  const issuer = memberOf(interaction);
  if (!issuer) return;
  if (!canExecute(issuer, "unmute")) {
    await replyErr(interaction, "Недостатньо прав.");
    return;
  }
  const target = await resolveMember(interaction, "user");
  if (!target) {
    await replyErr(interaction, "Користувача не знайдено.");
    return;
  }
  if (!canTarget(issuer, target)) {
    await replyErr(interaction, "Ви не можете застосовувати це покарання до цього користувача.");
    return;
  }
  const reason = interaction.options.getString("reason") || "Причина не вказана";
  try {
    await target.timeout(null).catch(() => undefined);
    if (config.muteRoleId) {
      await target.roles.remove(config.muteRoleId, `unmute by ${issuer.user.username}`).catch(() => undefined);
    }
    const mutes = loadMutes().filter((m) => String(m.user_id) !== String(target.id));
    saveMutes(mutes);
    const embed = modActionEmbed({
      title: "Мут знято",
      color: 0x2ecc71,
      target: target.toString(),
      executor: `${issuer.user.username} (ID: ${issuer.id})`,
      reason,
    });
    await sendPublic(interaction, embed);
    await logToModChannel(embed);
    await replyOk(interaction, `✅ ${target.toString()} розмучено.`);
  } catch (e) {
    await replyErr(interaction, `Не вдалося зняти мут: ${e}`);
  }
}

async function cmdMutes(interaction: ChatInputCommandInteraction): Promise<void> {
  const mutes = loadMutes();
  if (mutes.length === 0) {
    await replyEphemeral(interaction, "Немає активних мутів.");
    return;
  }
  const desc = mutes
    .map((m) =>
      `<@${m.user_id}> — ${m.type === "permanent" ? "перманентний" : `до ${m.until}`}: ${m.reason}`,
    )
    .join("\n");
  const e = new EmbedBuilder({ title: "Активні мути", description: desc });
  await interaction.reply({ embeds: [e], flags: MessageFlags.Ephemeral }).catch(() => undefined);
}

async function cmdTempRole(interaction: ChatInputCommandInteraction): Promise<void> {
  const issuer = memberOf(interaction);
  if (!issuer) return;
  if (!canExecute(issuer, "temprole")) {
    await replyErr(interaction, "Недостатньо прав.");
    return;
  }
  const target = await resolveMember(interaction, "user");
  const role = interaction.options.getRole("role");
  if (!target || !role) {
    await replyErr(interaction, "Вкажіть користувача та роль.");
    return;
  }
  if (!canTarget(issuer, target) || (!hasHigherRole(issuer, target) && issuer.id !== interaction.guild!.ownerId)) {
    await replyErr(interaction, "Ви не можете призначати роль цьому користувачу.");
    return;
  }
  const durationStr = interaction.options.getString("duration") || "";
  const reason = interaction.options.getString("reason") || "Причина не вказана";
  const ms = parseDuration(durationStr);
  if (ms === null) {
    await replyErr(
      interaction,
      "Невірний формат тривалості. Використовуйте формат 15m/2h/1d.",
    );
    return;
  }
  try {
    await target.roles.add(role.id, `temprole by ${issuer.user.username} до ${new Date(Date.now() + ms).toISOString()}`);
    const until = new Date(Date.now() + ms);
    const temproles = loadTemproles();
    temproles.push({
      user_id: String(target.id),
      role_id: String(role.id),
      moderator_id: String(issuer.id),
      until: until.toISOString(),
      reason,
      created_at: new Date().toISOString(),
    });
    saveTemproles(temproles);

    const embed = modActionEmbed({
      title: "Призначено тимчасову роль",
      color: 0x3498db,
      target: target.toString(),
      executor: `${issuer.user.username} (ID: ${issuer.id})`,
      duration: humanDuration(ms),
      until: String(Math.floor(until.getTime() / 1000)),
      reason,
    });
    await sendPublic(interaction, embed);
    await logToModChannel(embed);
    await replyOk(interaction, "✅ Роль призначено.");
  } catch (e) {
    await replyErr(interaction, `Не вдалося призначити роль: ${e}`);
  }
}

async function cmdUnrole(interaction: ChatInputCommandInteraction): Promise<void> {
  const issuer = memberOf(interaction);
  if (!issuer) return;
  if (!canExecute(issuer, "temprole")) {
    await replyErr(interaction, "Недостатньо прав.");
    return;
  }
  const target = await resolveMember(interaction, "user");
  const role = interaction.options.getRole("role");
  if (!target || !role) {
    await replyErr(interaction, "Вкажіть користувача та роль.");
    return;
  }
  if (!canTarget(issuer, target)) {
    await replyErr(interaction, "Ви не можете застосовувати це покарання до цього користувача.");
    return;
  }
  const reason = interaction.options.getString("reason") || "Причина не вказана";
  try {
    await target.roles.remove(role.id, `removed by ${issuer.user.username} (ID: ${issuer.id})`);
  } catch (e) {
    await replyErr(interaction, `Не вдалося зняти роль: ${e}`);
    return;
  }
  const temproles = loadTemproles().filter(
    (t) => !(String(t.user_id) === String(target.id) && String(t.role_id) === String(role.id)),
  );
  saveTemproles(temproles);
  const embed = modActionEmbed({
    title: "Роль знято",
    color: 0x2ecc71,
    target: target.toString(),
    executor: `${issuer.user.username} (ID: ${issuer.id})`,
    reason,
  });
  await sendPublic(interaction, embed);
  await logToModChannel(embed);
  await replyOk(interaction, "✅ Роль знято.");
}

async function cmdTempRoles(interaction: ChatInputCommandInteraction): Promise<void> {
  const target = interaction.options.getUser("user")
    ? await resolveMember(interaction, "user")
    : memberOf(interaction);
  if (!target) return;
  if (!target) {
    await replyErr(interaction, "Користувача не знайдено.");
    return;
  }
  const rows = loadTemproles().filter((t) => String(t.user_id) === String(target.id));
  if (rows.length === 0) {
    await replyEphemeral(interaction, `У ${target.toString()} немає тимчасових ролей.`);
    return;
  }
  const lines = rows.map(
    (r) => `<@${r.user_id}> — <@&${r.role_id}> до ${r.until}: ${r.reason}`,
  );
  const e = new EmbedBuilder({ title: `Тимчасові ролі: ${target.user.username}`, description: lines.join("\n") });
  await interaction.reply({ embeds: [e], flags: MessageFlags.Ephemeral }).catch(() => undefined);
}

async function cmdBlacklist(interaction: ChatInputCommandInteraction): Promise<void> {
  const issuer = memberOf(interaction);
  if (!issuer) return;
  if (!canExecute(issuer, "ban")) {
    await replyErr(interaction, "Недостатньо прав.");
    return;
  }
  if (!config.blacklistRoleId) {
    await replyErr(interaction, "Роль ЧС (BLACKLIST_ROLE_ID) не налаштована.");
    return;
  }
  const target = await resolveMember(interaction, "user");
  if (!target) {
    await replyErr(interaction, "Користувача не знайдено.");
    return;
  }
  if (!canTarget(issuer, target)) {
    await replyErr(interaction, "Ви не можете застосовувати це покарання до цього користувача.");
    return;
  }
  const reason = interaction.options.getString("reason") || "Причина не вказана";
  try {
    await target.roles.add(config.blacklistRoleId, `blacklist by ${issuer.user.username} (ID: ${issuer.id})`);
    const embed = modActionEmbed({
      title: "Внесено до ЧС",
      color: 0xe74c3c,
      target: target.toString(),
      executor: `${issuer.user.username} (ID: ${issuer.id})`,
      reason,
    });
    await sendPublic(interaction, embed);
    const dm = buildModEmbed(
      "Вас внесено до ЧС Проекту",
      `Вас внесено до ЧС модератором ${issuer.toString()}.\nПричина: ${reason}`,
    );
    await dmUser(target, dm);
    await logToModChannel(embed);
    await replyOk(interaction, "✅ Користувача внесено до ЧС.");
  } catch (e) {
    await replyErr(interaction, `Не вдалося внести до ЧС: ${e}`);
  }
}

async function cmdUnblacklist(interaction: ChatInputCommandInteraction): Promise<void> {
  const issuer = memberOf(interaction);
  if (!issuer) return;
  if (!canExecute(issuer, "unban")) {
    await replyErr(interaction, "Недостатньо прав.");
    return;
  }
  if (!config.blacklistRoleId) {
    await replyErr(interaction, "Роль ЧС (BLACKLIST_ROLE_ID) не налаштована.");
    return;
  }
  const target = await resolveMember(interaction, "user");
  if (!target) {
    await replyErr(interaction, "Користувача не знайдено.");
    return;
  }
  if (!canTarget(issuer, target)) {
    await replyErr(interaction, "Ви не можете застосовувати це покарання до цього користувача.");
    return;
  }
  const reason = interaction.options.getString("reason") || "Причина не вказана";
  try {
    await target.roles.remove(config.blacklistRoleId, `unblacklist by ${issuer.user.username}`);
    const embed = modActionEmbed({
      title: "Прибрано з ЧС",
      color: 0x2ecc71,
      target: target.toString(),
      executor: `${issuer.user.username} (ID: ${issuer.id})`,
      reason,
    });
    await sendPublic(interaction, embed);
    await logToModChannel(embed);
    await replyOk(interaction, "✅ Користувача прибрано з ЧС.");
  } catch (e) {
    await replyErr(interaction, `Не вдалося прибрати з ЧС: ${e}`);
  }
}

async function cmdClear(interaction: ChatInputCommandInteraction): Promise<void> {
  const issuer = memberOf(interaction);
  if (!issuer) return;
  if (!canExecute(issuer, "clear")) {
    await replyErr(interaction, "Недостатньо прав.");
    return;
  }
  const count = Math.min(Math.max(interaction.options.getInteger("count", true), 1), 1000);
  const targetUser = interaction.options.getUser("user") ?? null;
  const reason = interaction.options.getString("reason") || "Не вказано";
  const channel = interaction.channel;
  if (!channel || !("bulkDelete" in channel)) {
    await replyErr(interaction, "Цю команду необхідно використовувати в текстовому каналі.");
    return;
  }
  const fourteenDaysMs = 14 * 24 * 60 * 60 * 1000;
  let deleted = 0;
  let beforeId: string | undefined;
  let guard = 0;
  try {
    while (deleted < count && guard < 30) {
      guard++;
      const batch = await channel.messages.fetch({ limit: 100, before: beforeId });
      if (batch.size === 0) break;
      beforeId = batch.last()?.id;
      let candidates = [...batch.values()];
      if (targetUser) candidates = candidates.filter((m) => m.author.id === targetUser.id);
      candidates = candidates.filter((m) => Date.now() - m.createdTimestamp < fourteenDaysMs);
      if (candidates.length === 0) continue;
      const toDelete = candidates.slice(0, count - deleted);
      const result = await channel.bulkDelete(toDelete.map((m) => m.id), true);
      deleted += result.size;
    }
  } catch (e) {
    await replyErr(interaction, `Не вдалося очистити: ${e}`);
    return;
  }
  const embed = new EmbedBuilder({ title: "Повідомлення очищено", color: 0x3498db })
    .setDescription(targetUser ? `Повідомлення від: ${targetUser.toString()}` : "Усі повідомлення")
    .addFields(
      { name: "Модератор:", value: `${issuer.user.username} (ID: ${issuer.id})`, inline: true },
      { name: "Коли:", value: `<t:${nowTs()}:F>`, inline: true },
      { name: "Кількість:", value: String(deleted), inline: true },
      { name: "Причина:", value: reason, inline: false },
    )
    .setFooter({ text: "Sloboda Hospital" });
  await logToModChannel(embed);
  await replyOk(interaction, `✅ Видалено ${deleted} повідомлень${targetUser ? ` від ${targetUser.toString()}` : ""}.`);
}

interface PostDraft {
  title: string;
  description: string;
  imageUrl: string;
  pings: string[];
}

const drafts = new Map<string, PostDraft>();
const previewRefs = new Map<string, { channelId: string; messageId: string }>();

function modalRow(
  ...components: ModalActionRowComponentBuilder[]
): ActionRowBuilder<ModalActionRowComponentBuilder> {
  return new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(components);
}

function buttonRow(...buttons: ButtonBuilder[]): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(buttons);
}

function canPost(member: GuildMember | null): boolean {
  if (!member || !member.roles?.cache) return false;
  if (member.roles.cache.some((r) => config.postRoleIds.includes(r.id))) return true;
  return isAdminRole(member) || isGlobalAllowed(member);
}

function buildPostStartView(): ActionRowBuilder<ButtonBuilder>[] {
  const edit = new ButtonBuilder()
    .setCustomId("post_edit")
    .setLabel("Заповнити текст")
    .setStyle(ButtonStyle.Primary)
    .setEmoji("🎨");
  return [buttonRow(edit)];
}

function buildPostModal(): ModalBuilder {
  const title = new TextInputBuilder()
    .setCustomId("post_title")
    .setLabel("Назва поста")
    .setStyle(TextInputStyle.Short)
    .setPlaceholder("Заголовок поста...")
    .setMaxLength(256)
    .setRequired(true);
  const description = new TextInputBuilder()
    .setCustomId("post_description")
    .setLabel("Опис поста")
    .setPlaceholder("Текст поста...")
    .setStyle(TextInputStyle.Paragraph)
    .setMaxLength(4000)
    .setRequired(true);
  const image = new TextInputBuilder()
    .setCustomId("post_image")
    .setLabel("Зображення (необов'язково)")
    .setStyle(TextInputStyle.Short)
    .setPlaceholder("https://example.com/image.png")
    .setRequired(false)
    .setMaxLength(500);
  const pings = new TextInputBuilder()
    .setCustomId("post_pings")
    .setLabel("Пінги ролей (необов'язково)")
    .setPlaceholder("<@&1234>, <@&5678>")
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(false)
    .setMaxLength(200);
  return new ModalBuilder()
    .setCustomId("post_modal")
    .setTitle("Публікація поста")
    .addComponents(
      modalRow(title),
      modalRow(description),
      modalRow(image),
      modalRow(pings),
    );
}

function buildPostPreviewView(token: string): ActionRowBuilder<ButtonBuilder>[] {
  const publish = new ButtonBuilder()
    .setCustomId(`post_publish:${token}`)
    .setLabel("Опублікувати")
    .setStyle(ButtonStyle.Success)
    .setEmoji("✅");
  const edit = new ButtonBuilder()
    .setCustomId(`post_edit:${token}`)
    .setLabel("Редагувати")
    .setStyle(ButtonStyle.Primary)
    .setEmoji("✏️");
  const cancel = new ButtonBuilder()
    .setCustomId(`post_cancel:${token}`)
    .setLabel("Скасувати")
    .setStyle(ButtonStyle.Secondary)
    .setEmoji("❌");
  return [buttonRow(publish, edit, cancel)];
}

async function cmdPost(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!canPost(memberOf(interaction))) {
    await replyEphemeral(interaction, "У вас немає прав для цієї команди.");
    return;
  }
  const preview = baseEmbed({
    title: "Публікація поста",
    description:
      "Натисніть кнопку нижче, щоб заповнити поля поста.\n" +
      "Після відправлення форми бот опублікує ембед у цей канал.\n\n" +
      "*Заповніть усі поля перед відправленням — попередній перегляд не оновлюється автоматично.*",
  });
  await interaction
    .reply({
      embeds: [preview],
      components: buildPostStartView(),
      flags: MessageFlags.Ephemeral,
    })
    .catch(() => undefined);
}

async function handlePostEdit(interaction: Interaction): Promise<void> {
  if (!interaction.isButton()) return;
  const userId = String(interaction.user.id);
  const token = interaction.customId.includes(":") ? interaction.customId.split(":")[1] : undefined;
  if (token) drafts.delete(token);
  if (interaction.message && interaction.channelId) {
    previewRefs.set(userId, { channelId: interaction.channelId, messageId: interaction.message.id });
  }
  await interaction.showModal(buildPostModal());
}

async function handlePostModal(interaction: Interaction): Promise<void> {
  if (!interaction.isModalSubmit()) return;
  const title = interaction.fields.getTextInputValue("post_title");
  const description = interaction.fields.getTextInputValue("post_description");
  const imageUrl = interaction.fields.getTextInputValue("post_image").trim();
  const pingsRaw = interaction.fields.getTextInputValue("post_pings").trim();

  const embed = baseEmbed({ title, description });

  if (imageUrl) {
    if (!imageUrl.startsWith("http://") && !imageUrl.startsWith("https://")) {
      await interaction.reply({
        content: "Посилання на зображення має починатися з `http://` або `https://`.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    embed.setImage(imageUrl);
  }

  const mentions: string[] = [];
  if (pingsRaw) {
    const items = pingsRaw.split(",").map((s) => s.trim()).filter(Boolean);
    const re = /^<@&([0-9]+)>$/;
    for (const item of items) {
      const match = re.exec(item);
      if (!match) {
        await interaction.reply({
          content: "Пінги мають бути у форматі `<@&1234>` через кому, до 5 ролей.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      mentions.push(match[1]);
    }
    const unique = [...new Set(mentions)];
    if (unique.length > 5) {
      await interaction.reply({
        content: "Можна вказати не більше 5 пінг-ролей.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
  }

  const token = crypto.randomBytes(6).toString("hex");
  drafts.set(token, { title, description, imageUrl, pings: mentions });

  embed.setFooter({ text: "Попередній перегляд" });

  const userId = String(interaction.user.id);
  const ref = previewRefs.get(userId);
  if (ref) {
    try {
      await interaction.deferUpdate();
      const ch = await interaction.client.channels.fetch(ref.channelId);
      if (ch && "messages" in ch) {
        const msg = await ch.messages.fetch(ref.messageId);
        await msg.edit({ embeds: [embed], components: buildPostPreviewView(token) });
        return;
      }
    } catch {}
    await interaction
      .editReply({ embeds: [embed], components: buildPostPreviewView(token) })
      .catch(() => undefined);
    return;
  }

  await interaction.reply({
    embeds: [embed],
    components: buildPostPreviewView(token),
    flags: MessageFlags.Ephemeral,
  });
  const fetched = await interaction.fetchReply().catch(() => null);
  if (fetched && interaction.channelId) {
    previewRefs.set(userId, { channelId: interaction.channelId, messageId: fetched.id });
  }
}

async function postPermissionCheck(interaction: Interaction): Promise<boolean> {
  const member = interaction.member as GuildMember | null;
  if (!canPost(member)) {
    if (interaction.isRepliable()) {
      await interaction
        .reply({
          content: "У вас немає прав для публікації постів.",
          flags: MessageFlags.Ephemeral,
        })
        .catch(() => undefined);
    }
    return false;
  }
  return true;
}

async function handlePostPublish(interaction: Interaction): Promise<void> {
  if (!interaction.isButton()) return;
  const token = interaction.customId.split(":")[1];
  const draft = drafts.get(token);
  if (!draft) {
    await interaction.reply({
      content: "Чернетку поста не знайдено. Заповніть форму заново.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  if (!(await postPermissionCheck(interaction))) return;

  const embed = baseEmbed({ title: draft.title, description: draft.description });
  if (draft.imageUrl) embed.setImage(draft.imageUrl);

  const channel = interaction.channel;
  if (!channel || !("send" in channel)) {
    await interaction.reply({
      content: "Не вдалося визначити канал для публікації.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  try {
    if (draft.pings.length > 0) {
      const mentionText = draft.pings.map((id) => `<@&${id}>`).join(" ");
      await channel.send({ content: mentionText, embeds: [embed] });
    } else {
      await channel.send({ embeds: [embed] });
    }
  } catch (e) {
    await interaction.reply({
      content: `Не вдалося опублікувати пост: ${e instanceof Error ? e.message : String(e)}`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  drafts.delete(token);
  previewRefs.delete(String(interaction.user.id));
  try {
    await interaction.message.delete();
  } catch {}
  await interaction.reply({
    content: "✅ Пост опубліковано в канал.",
    flags: MessageFlags.Ephemeral,
  });
  log("info", `Пост опублікував користувач ${interaction.user.id}: ${draft.title.slice(0, 80)}`);
}

async function handlePostCancel(interaction: Interaction): Promise<void> {
  if (!interaction.isButton()) return;
  const token = interaction.customId.split(":")[1];
  drafts.delete(token);
  previewRefs.delete(String(interaction.user.id));
  try {
    await interaction.deferUpdate();
  } catch {}
  try {
    await interaction.message.delete();
  } catch {
    await interaction
      .editReply({ content: "Публікацію поста скасовано.", components: [] })
      .catch(() => undefined);
  }
}

const handlers: Record<string, (i: ChatInputCommandInteraction) => Promise<void>> = {
  menu: cmdMenu,
  embed: cmdEmbed,
  embeds: cmdEmbeds,
  "embeds-reload": cmdEmbedsReload,
  say: cmdSay,
  help: cmdHelp,
  status: cmdStatus,
  post: cmdPost,
  warn: cmdWarn,
  warns: cmdWarns,
  unwarn: cmdUnwarn,
  reprimand: cmdReprimand,
  reprimands: cmdReprimands,
  kick: cmdKick,
  ban: cmdBan,
  unban: cmdUnban,
  mute: cmdMute,
  unmute: cmdUnmute,
  mutes: cmdMutes,
  temprole: cmdTempRole,
  unrole: cmdUnrole,
  temproles: cmdTempRoles,
  clear: cmdClear,
  blacklist: cmdBlacklist,
  unblacklist: cmdUnblacklist,
};

const banTypeChoices = [
  { name: "Тимчасовий", value: "temporary" },
  { name: "Тимчасовий без апеляції", value: "temporary_no_appeal" },
  { name: "Перманентний", value: "permanent" },
  { name: "Перманентний без апеляції", value: "permanent_no_appeal" },
];

function buildCommands(): RESTPostAPIChatInputApplicationCommandsJSONBody[] {
  const withUser = (required: boolean) =>
    new SlashCommandBuilder()
      .addUserOption((o) => o.setName("user").setDescription("Користувач").setRequired(required));

  return [
    new SlashCommandBuilder()
      .setName("menu")
      .setDescription("Показати меню сервера").toJSON(),
    new SlashCommandBuilder()
      .setName("embed")
      .setDescription("Надіслати ембед у цей канал")
      .addStringOption((o) => o.setName("name").setDescription("Назва ембеда").setRequired(true)).toJSON(),
    new SlashCommandBuilder()
      .setName("embeds")
      .setDescription("Список доступних ембедів").toJSON(),
    new SlashCommandBuilder()
      .setName("embeds-reload")
      .setDescription("Перезавантажити ембеди з файлів").toJSON(),
    new SlashCommandBuilder()
      .setName("say")
      .setDescription("Надіслати текст від імені бота")
      .addStringOption((o) => o.setName("text").setDescription("Текст").setRequired(true)).toJSON(),
    new SlashCommandBuilder()
      .setName("help")
      .setDescription("Список команд").toJSON(),
    new SlashCommandBuilder()
      .setName("post")
      .setDescription("Опублікувати пост у цей канал").toJSON(),
    new SlashCommandBuilder()
      .setName("status")
      .setDescription("Інформація про бота").toJSON(),
    withUser(true)
      .setName("warn")
      .setDescription("Видати попередження")
      .addStringOption((o) => o.setName("reason").setDescription("Причина").setRequired(false)).toJSON(),
    withUser(false)
      .setName("warns")
      .setDescription("Попередження користувача").toJSON(),
    withUser(true)
      .setName("unwarn")
      .setDescription("Зняти попередження")
      .addIntegerOption((o) => o.setName("id").setDescription("ID попередження (необов'язково)").setRequired(false))
      .addStringOption((o) => o.setName("reason").setDescription("Причина").setRequired(false)).toJSON(),
    withUser(true)
      .setName("reprimand")
      .setDescription("Видати догану (догану)")
      .addStringOption((o) => o.setName("reason").setDescription("Причина").setRequired(false)).toJSON(),
    withUser(false)
      .setName("reprimands")
      .setDescription("Список доган користувача").toJSON(),
    withUser(true)
      .setName("kick")
      .setDescription("Вигнати користувача")
      .addStringOption((o) => o.setName("reason").setDescription("Причина").setRequired(false)).toJSON(),
    withUser(true)
      .setName("ban")
      .setDescription("Забанити користувача")
      .addStringOption((o) =>
        o.setName("type").setDescription("Вид бана").setRequired(true).addChoices(...banTypeChoices),
      )
      .addStringOption((o) => o.setName("duration").setDescription("Тривалість (для тимчасового): 15, 15m, 2h, 1d").setRequired(false))
      .addStringOption((o) => o.setName("reason").setDescription("Причина").setRequired(false)).toJSON(),
    new SlashCommandBuilder()
      .setName("unban")
      .setDescription("Розбанити користувача")
      .addStringOption((o) => o.setName("id").setDescription("ID користувача").setRequired(true))
      .addStringOption((o) => o.setName("reason").setDescription("Причина").setRequired(false)).toJSON(),
    withUser(true)
      .setName("mute")
      .setDescription("Замутити (таймаут + роль ізолятора)")
      .addStringOption((o) => o.setName("duration").setDescription("Тривалість: 15, 15m, 2h, 1d").setRequired(true))
      .addStringOption((o) =>
        o.setName("type").setDescription("Вид мута").setRequired(true).addChoices(
          { name: "Тимчасовий", value: "temporary" },
          { name: "Перманентний", value: "permanent" },
        ),
      )
      .addStringOption((o) => o.setName("reason").setDescription("Причина").setRequired(false)).toJSON(),
    withUser(true)
      .setName("unmute")
      .setDescription("Зняти мут")
      .addStringOption((o) => o.setName("reason").setDescription("Причина").setRequired(false)).toJSON(),
    new SlashCommandBuilder()
      .setName("mutes")
      .setDescription("Список активних мутів").toJSON(),
    withUser(true)
      .setName("temprole")
      .setDescription("Видати тимчасову роль")
      .addRoleOption((o) => o.setName("role").setDescription("Роль").setRequired(true))
      .addStringOption((o) => o.setName("duration").setDescription("Тривалість: 15, 15m, 2h, 1d").setRequired(true))
      .addStringOption((o) => o.setName("reason").setDescription("Причина").setRequired(false)).toJSON(),
    withUser(true)
      .setName("unrole")
      .setDescription("Зняти роль")
      .addRoleOption((o) => o.setName("role").setDescription("Роль").setRequired(true))
      .addStringOption((o) => o.setName("reason").setDescription("Причина").setRequired(false)).toJSON(),
    withUser(false)
      .setName("temproles")
      .setDescription("Тимчасові ролі користувача").toJSON(),
    new SlashCommandBuilder()
      .setName("clear")
      .setDescription("Очистити повідомлення в каналі")
      .addIntegerOption((o) => o.setName("count").setDescription("Кількість (1-1000)").setRequired(true))
      .addUserOption((o) => o.setName("user").setDescription("Лише повідомлення цього користувача").setRequired(false))
      .addStringOption((o) => o.setName("reason").setDescription("Причина").setRequired(false)).toJSON(),
    withUser(true)
      .setName("blacklist")
      .setDescription("Внести користувача до ЧС")
      .addStringOption((o) => o.setName("reason").setDescription("Причина").setRequired(false)).toJSON(),
    withUser(true)
      .setName("unblacklist")
      .setDescription("Прибрати користувача з ЧС")
      .addStringOption((o) => o.setName("reason").setDescription("Причина").setRequired(false)).toJSON(),
  ];
}

async function registerCommands(): Promise<void> {
  if (!config.guildId || !client.user) {
    log("warn", "GUILD_ID не вказано — команди зі слешем не зареєстровані");
    return;
  }
  const rest = new REST().setToken(config.token);
  try {
    await rest.put(Routes.applicationGuildCommands(client.user.id, config.guildId), {
      body: buildCommands(),
    });
    log("info", "Слеш-команди зареєстровані для сервера", config.guildId);
  } catch (e) {
    log("error", "Не вдалося зареєструвати команди:", e);
  }
}

function startBackgroundTask(): void {
  setInterval(async () => {
    const now = new Date();

    try {
      const mutes = loadMutes();
      let changed = false;
      for (const m of [...mutes]) {
        if (!m.until) continue;
        const until = new Date(m.until);
        if (Number.isNaN(until.getTime()) || until > now) continue;
        for (const guild of client.guilds.cache.values()) {
          const member = await guild.members.fetch(m.user_id).catch(() => null);
          if (member) {
            member.timeout(null).catch(() => undefined);
            if (config.muteRoleId) {
              member.roles.remove(config.muteRoleId, "mute expired").catch(() => undefined);
            }
            break;
          }
        }
        const idx = mutes.indexOf(m);
        if (idx !== -1) mutes.splice(idx, 1);
        changed = true;
      }
      if (changed) saveMutes(mutes);
    } catch {}

    try {
      const temproles = loadTemproles();
      let changed = false;
      for (const t of [...temproles]) {
        const until = new Date(t.until);
        if (Number.isNaN(until.getTime()) || until > now) continue;
        for (const guild of client.guilds.cache.values()) {
          const member = await guild.members.fetch(t.user_id).catch(() => null);
          const role = guild.roles.cache.get(t.role_id);
          if (member && role) {
            member.roles.remove(role, "temprole expired").catch(() => undefined);
            break;
          }
        }
        const idx = temproles.indexOf(t);
        if (idx !== -1) temproles.splice(idx, 1);
        changed = true;
      }
      if (changed) saveTemproles(temproles);
    } catch {}

    try {
      const bans = loadBans();
      let changed = false;
      for (const b of [...bans]) {
        if (!b.until) continue;
        const until = new Date(b.until);
        if (Number.isNaN(until.getTime()) || until > now) continue;
        for (const guild of client.guilds.cache.values()) {
          if (guild.id !== config.guildId) continue;
          guild.bans.remove(b.user_id, "temporary ban expired").catch(() => undefined);
          break;
        }
        const idx = bans.indexOf(b);
        if (idx !== -1) bans.splice(idx, 1);
        changed = true;
      }
      if (changed) saveBans(bans);
    } catch {}
  }, 30_000);
}

client.once(Events.ClientReady, async (c) => {
  log("info", `Бота запущено як ${c.user.tag} (${c.user.id})`);
  try {
    await c.user.setActivity({ name: "Sloboda Hospital", type: ActivityType.Watching });
  } catch {}
  await registerCommands();
  startBackgroundTask();
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isStringSelectMenu()) {
      await handleEmbedMenu(interaction);
      return;
    }
    if (interaction.isButton()) {
      const id = interaction.customId;
      if (id.startsWith("post_edit")) {
        await handlePostEdit(interaction);
        return;
      }
      if (id.startsWith("post_publish:")) {
        await handlePostPublish(interaction);
        return;
      }
      if (id.startsWith("post_cancel:")) {
        await handlePostCancel(interaction);
        return;
      }
      return;
    }
    if (interaction.isModalSubmit()) {
      if (interaction.customId === "post_modal") {
        await handlePostModal(interaction);
        return;
      }
      return;
    }
    if (interaction.isChatInputCommand()) {
      const handler = handlers[interaction.commandName];
      if (handler) {
        await handler(interaction);
      }
    }
  } catch (e) {
    log("error", "Помилка в обробці взаємодії:", e);
    await logErrorToChannel({
      client,
      commandName: interaction.isChatInputCommand()
        ? interaction.commandName
        : "customId" in interaction
          ? interaction.customId
          : "unknown",
      error: e instanceof Error ? e : String(e),
      userLabel: userLabel(interaction.user),
      channelLabel: interaction.channelId ?? "—",
    });
    if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
      await interaction
        .reply({ content: "Сталася непередбачувана помилка.", flags: MessageFlags.Ephemeral })
        .catch(() => undefined);
    }
  }
});

process.on("SIGINT", () => {
  log("info", "Отримано SIGINT — завершення бота...");
  const force = setTimeout(() => process.exit(0), 3000);
  force.unref();
  client
    .destroy()
    .then(() => process.exit(0))
    .catch(() => process.exit(0));
});

process.on("SIGTERM", () => {
  log("info", "Отримано SIGTERM — завершення бота...");
  const force = setTimeout(() => process.exit(0), 3000);
  force.unref();
  client
    .destroy()
    .then(() => process.exit(0))
    .catch(() => process.exit(0));
});

client.login(config.token);