import {
  ActionRowBuilder,
  ActivityType,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  GuildMember,
  MessageFlags,
  REST,
  Routes,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  TextChannel,
  type ChatInputCommandInteraction,
  type RESTPostAPIChatInputApplicationCommandsJSONBody,
  type StringSelectMenuInteraction,
} from "discord.js";
import { config } from "./config";
import { loadEmbeds, jsonToEmbed, type EmbedData, type SelectOption } from "./lib/embeds";
import { log } from "./lib/logger";
import { parseDuration } from "./lib/duration";
import {
  buildModEmbed,
  canExecute,
  canTarget,
  hasHigherRole,
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
  try {
    await member.send({ embeds: [embed] });
  } catch {}
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
  if (!config.embedsReloadUsers.includes(String(interaction.user.id))) {
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
  const uptimeSec = Math.floor((client.uptime ?? 0) / 1000);
  const d = Math.floor(uptimeSec / 86400);
  const h = Math.floor((uptimeSec % 86400) / 3600);
  const m = Math.floor((uptimeSec % 3600) / 60);
  const sec = uptimeSec % 60;
  const uptimeParts: string[] = [];
  if (d) uptimeParts.push(`${d} дн.`);
  if (h) uptimeParts.push(`${h} год.`);
  if (m) uptimeParts.push(`${m} хв.`);
  uptimeParts.push(`${sec} сек.`);
  const commands = buildCommands();
  const lines = [
    `🤖 Бот: **${client.user?.tag ?? "?"}**`,
    `📶 Пінг: \`${client.ws.ping} мс\``,
    `⏱ Аптайм: \`${uptimeParts.join(" ")}\``,
    `🖥 Сервер: \`${interaction.guild?.name ?? "—"}\``,
    `📝 Команд: \`${commands.length}\``,
    `👤 Користувачів на сервері: \`${interaction.guild?.memberCount ?? "—"}\``,
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

const handlers: Record<string, (i: ChatInputCommandInteraction) => Promise<void>> = {
  menu: cmdMenu,
  embed: cmdEmbed,
  embeds: cmdEmbeds,
  "embeds-reload": cmdEmbedsReload,
  say: cmdSay,
  help: cmdHelp,
  status: cmdStatus,
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
    if (interaction.isChatInputCommand()) {
      const handler = handlers[interaction.commandName];
      if (handler) {
        await handler(interaction);
      }
    }
  } catch (e) {
    log("error", "Помилка в обробці взаємодії:", e);
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