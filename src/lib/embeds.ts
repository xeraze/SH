import { EmbedBuilder } from "discord.js";
import fs from "node:fs";
import path from "node:path";
import { config } from "../config";
import { log } from "./logger";

const IMAGE_RE = /\.(png|jpe?g|gif|webp|bmp|tiff)(\?.*)?$/i;

function mediaLink(url: string): string {
  return `[${decodeURIComponent(url.split("/").pop()?.split("?")[0] ?? "файл")}](${url})`;
}

export function baseEmbed(data?: { title?: string; description?: string }): EmbedBuilder {
  const embed = new EmbedBuilder({ color: config.embedColor });
  if (data?.title) embed.setTitle(data.title);
  if (data?.description) embed.setDescription(data.description);
  return embed;
}

export function attachMediaToEmbed(embed: EmbedBuilder, urls: string[] | null | undefined): void {
  const list = (Array.isArray(urls) ? urls : []).filter(Boolean);
  if (list.length === 0) return;
  const images = list.filter((u) => IMAGE_RE.test(u));
  const others = list.filter((u) => !IMAGE_RE.test(u));
  if (images.length > 0) embed.setImage(images[0]);
  const rest = [...images.slice(1), ...others];
  if (rest.length > 0) {
    embed.addFields({
      name: "Вкладення:",
      value: rest.slice(0, 8).map(mediaLink).join("\n"),
      inline: false,
    });
  }
}

export function messageRelayEmbed(opts: {
  authorName: string;
  authorIcon?: string;
  content: string;
  footer?: string;
  attachments?: string[];
}): EmbedBuilder {
  const embed = new EmbedBuilder({
    color: config.embedColor,
    description: opts.content,
  });
  if (opts.authorIcon) {
    embed.setAuthor({ name: opts.authorName, iconURL: opts.authorIcon });
  } else {
    embed.setAuthor({ name: opts.authorName });
  }
  if (opts.footer) embed.setFooter({ text: opts.footer });
  if (opts.attachments?.length) {
    const images = opts.attachments.filter((u) => IMAGE_RE.test(u));
    const others = opts.attachments.filter((u) => !IMAGE_RE.test(u));
    if (images.length > 0) embed.setImage(images[0]);
    const rest = [...images.slice(1), ...others];
    if (rest.length > 0) {
      const lines = rest.slice(0, 8).map(mediaLink).join("\n");
      embed.setDescription(
        `${opts.content || ""}${opts.content ? "\n\n" : ""}${lines}`.slice(0, 4000),
      );
    }
  }
  return embed;
}

export interface SelectOption {
  label?: string;
  value?: string;
  description?: string;
}

export interface EmbedData {
  embed?: Record<string, unknown>;
  embeds?: Record<string, unknown>[];
  content?: string | null;
  selects?: SelectOption[];
}

export function loadEmbeds(folder: string): Record<string, EmbedData> {
  const base = path.join(process.cwd(), folder, "embeds");
  const result: Record<string, EmbedData> = {};
  if (!fs.existsSync(base)) return result;

  for (const file of fs.readdirSync(base)) {
    if (!file.endsWith(".json")) continue;
    const stem = file.replace(/\.json$/, "");
    try {
      const data = JSON.parse(fs.readFileSync(path.join(base, file), "utf-8"));
      if (data && typeof data === "object" && Array.isArray(data.embeds) && !data.embed) {
        const embedsList = (data.embeds as Record<string, unknown>[]) || [];
        result[stem] = {
          embeds: embedsList,
          embed: embedsList[0] || {},
          content: data.content ?? "",
          selects: data.selects || [],
        };
      } else {
        result[stem] = data as EmbedData;
      }
    } catch (e) {
      log("warn", `Не вдалося завантажити ембед ${file}:`, e);
    }
  }
  return result;
}

export function jsonToEmbed(d: Record<string, unknown> | undefined): EmbedBuilder {
  const e = new EmbedBuilder();
  if (!d) return e;
  if (d.title) e.setTitle(String(d.title));
  if (d.description) e.setDescription(String(d.description));
  if (d.color !== undefined && d.color !== null) {
    try {
      e.setColor(Number(d.color));
    } catch {
    }
  }
  if (Array.isArray(d.fields)) {
    for (const f of d.fields as Record<string, unknown>[]) {
      e.addFields({
        name: String(f.name ?? ""),
        value: String(f.value ?? ""),
        inline: Boolean(f.inline),
      });
    }
  }
  if (d.footer && typeof d.footer === "object") {
    const footer = d.footer as Record<string, unknown>;
    if (footer.text) e.setFooter({ text: String(footer.text) });
  }
  const image = (d.image && typeof d.image === "object" ? (d.image as Record<string, unknown>).url : d.image) as string | undefined;
  if (image) e.setImage(image);
  const thumb = (d.thumbnail && typeof d.thumbnail === "object" ? (d.thumbnail as Record<string, unknown>).url : d.thumbnail) as string | undefined;
  if (thumb) e.setThumbnail(thumb);
  return e;
}