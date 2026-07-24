import os
import json
from pathlib import Path
import asyncio

import discord
from discord.ext import commands
from dotenv import load_dotenv

import config

load_dotenv("token.env")
TOKEN = os.getenv("TOKEN") or os.getenv("DISCORD_TOKEN")

if not TOKEN:
    print("ERROR: Discord token not found. Add TOKEN=<your token> to token.env")
    raise SystemExit(1)

intents = discord.Intents.default()
intents.message_content = True
intents.members = True

bot = commands.Bot(command_prefix=config.PREFIX, intents=intents)
try:
    bot.remove_command("help")
except Exception:
    pass

EMBEDS: dict = {}


def load_embeds(folder: str) -> dict:
    """Load all embed JSON files from `folder/embeds` and return a dict name->data."""
    base = Path(folder) / "embeds"
    embeds = {}
    if not base.exists():
        return embeds
    for p in base.glob("*.json"):
        try:
            with p.open("r", encoding="utf-8") as f:
                data = json.load(f)
            if isinstance(data, dict) and data.get("embeds") and not data.get("embed"):
                embeds_list = data.get("embeds") or []
                normalized = {
                    "embeds": embeds_list,
                    "embed": embeds_list[0] if embeds_list else {},
                    "content": data.get("content", ""),
                    "selects": data.get("selects") or []
                }
                embeds[p.stem] = normalized
            else:
                embeds[p.stem] = data
        except Exception as e:
            print(f"Failed to load embed {p}: {e}")
    return embeds

EMBEDS = load_embeds(config.EMBED_FOLDER)

from pathlib import Path

_pending_extension_coros: list = []
for p in Path("cogs").glob("*.py"):
    name = p.stem
    try:
        res = bot.load_extension(f"cogs.{name}")
        if asyncio.iscoroutine(res):
            _pending_extension_coros.append((name, res))
        else:
            print(f"Loaded cog sync: cogs.{name}")
    except Exception as e:
        print(f"Failed to load cog {name}: {e}")

async def _await_pending_extensions_once():
    """Await any pending extension coroutines once on the bot's running loop."""
    if not _pending_extension_coros:
        return
    import traceback
    for name, coro in list(_pending_extension_coros):
        try:
            await coro
            print(f"Loaded async cog: cogs.{name}")
        except Exception:
            print(f"Exception while loading async cog: cogs.{name}")
            traceback.print_exc()
    _pending_extension_coros.clear()

def json_to_embed(d: dict) -> discord.Embed:
    e = discord.Embed()
    if not d:
        return e
    title = d.get("title")
    description = d.get("description")
    color = d.get("color")
    if title:
        e.title = title
    if description:
        e.description = description
    if color is not None:
        try:
            e.colour = discord.Colour(color)
        except Exception:
            try:
                e.colour = discord.Colour(int(color))
            except Exception:
                pass
    if d.get("fields"):
        for f in d.get("fields"):
            e.add_field(name=f.get("name", ""), value=f.get("value", ""), inline=f.get("inline", False))
    if d.get("footer"):
        e.set_footer(text=d.get("footer", {}).get("text", ""))
    if d.get("image"):
        url = d.get("image", {}).get("url") or d.get("image")
        if url:
            e.set_image(url=url)
    if d.get("thumbnail"):
        url = d.get("thumbnail", {}).get("url") or d.get("thumbnail")
        if url:
            e.set_thumbnail(url=url)
    return e


async def _delete_later(message: discord.Message, delay: int = 15):
    """Helper: delete a message after delay seconds (runs as background task)."""
    try:
        await asyncio.sleep(delay)
        await message.delete()
    except Exception:
        pass

class EmbedSelect(discord.ui.Select):
    def __init__(self, options, ephemeral=True):
        super().__init__(placeholder="Оберіть, що вас цікавить з цього / Make a choose", min_values=1, max_values=1, options=options)
        self.ephemeral = ephemeral

    async def callback(self, interaction: discord.Interaction):
        val = self.values[0]
        try:
            from __main__ import EMBEDS as GLOBAL_EMBEDS
        except Exception:
            GLOBAL_EMBEDS = globals().get('EMBEDS', {})

        if val.startswith("open:"):
            key = val[5:]

            if key in ("rules", "kherson_rules"):
                data_rules = GLOBAL_EMBEDS.get(key)
                if data_rules:
                    embeds_src = data_rules.get("embeds") or ([data_rules.get("embed")] if data_rules.get("embed") else [])
                    full_text = data_rules.get("content")
                    emb_objs = []
                    for src in embeds_src:
                        if not src:
                            continue
                        emb = json_to_embed(src)
                        emb_objs.append(emb)

                    if not emb_objs:
                        msg = full_text or f"Оберіть: {key}"
                        await interaction.response.send_message(msg, ephemeral=self.ephemeral)
                    else:
                        kwargs = {"embeds": emb_objs, "ephemeral": self.ephemeral}
                        if full_text:
                            kwargs["content"] = full_text
                        await interaction.response.send_message(**kwargs)
                    return

            data = GLOBAL_EMBEDS.get(key)
            
            if data:
                embeds_src = data.get("embeds") or ([data.get("embed")] if data.get("embed") else [])
                if embeds_src:
                    emb_objs = []
                    for src in embeds_src:
                        if not src:
                            continue
                        emb = json_to_embed(src)
                        emb_objs.append(emb)
                    full_text = data.get("content")
                    if not emb_objs:
                        msg = full_text or data.get('content') or f"Оберіть: {key}"
                        await interaction.response.send_message(msg, ephemeral=self.ephemeral)
                    else:
                        kwargs = {"embeds": emb_objs, "ephemeral": self.ephemeral}
                        if full_text:
                            kwargs["content"] = full_text
                        await interaction.response.send_message(**kwargs)
                    return
                msg = data.get("content") or (data.get("embed") or {}).get("description")
            else:
                msg = f"Ви обрали: {key}"
            await interaction.response.send_message(msg, ephemeral=self.ephemeral)
            return

        await interaction.response.send_message(f"Ви обрали: {val}", ephemeral=self.ephemeral)

class EmbedView(discord.ui.View):
    def __init__(self, selects: list | None = None):
        super().__init__(timeout=None)
        if selects:
            options = []
            for s in selects:
                options.append(discord.SelectOption(label=s.get("label", s.get("value", "")), value=s.get("value", s.get("label", "")), description=s.get("description", None)))
            self.add_item(EmbedSelect(options))

@bot.event
async def on_ready():
    print(f"Logged in as: {bot.user} (id: {bot.user.id})")
    
    try:
        activity = discord.Activity(type=discord.ActivityType.watching, name="Kherson, Ukraine | <>")
        await bot.change_presence(status=discord.Status.online, activity=activity)
    except Exception as e:
        print(f"Failed to set presence: {e}")
    try:
        asyncio.create_task(_await_pending_extensions_once())
    except Exception:
        pass

@bot.command(name="embed")
@commands.has_role(config.ADMIN_ROLE_ID)
async def send_embed(ctx: commands.Context, name: str):
    """Send an embed loaded from data/embeds/<name>.json. Restricted by role ID from config.py."""
    embeds = EMBEDS or load_embeds(config.EMBED_FOLDER)
    key = name.strip()
    if key not in embeds:
        await ctx.send(f"Embed `{key}` не знайдений. Список доступних: {', '.join(sorted(embeds.keys()))}")
        return
    data = embeds[key].get("embed") or embeds[key]
    embed = json_to_embed(data)
    selects = embeds[key].get("selects")
    view = EmbedView(selects)
    content = embeds[key].get("content")
    await ctx.send(content or None, embed=embed, view=view)

@bot.command(name="listembeds")
async def list_embeds(ctx: commands.Context):
    """List available embed names from `data/embeds/`."""
    embeds = EMBEDS or load_embeds(config.EMBED_FOLDER)
    if not embeds:
        await ctx.send("Немає доступних ембедів.")
        return
    names = sorted(embeds.keys())
    text = "Available embeds:\n" + ", ".join(names)
    if len(text) > 1900:
        chunk = []
        cur = ""
        for n in names:
            if len(cur) + len(n) + 2 > 1900:
                chunk.append(cur)
                cur = n
            else:
                cur = cur + (", " if cur else "") + n
        if cur:
            chunk.append(cur)
        for c in chunk:
            await ctx.send(c)
    else:
        await ctx.send(text)

@bot.command(name="help")
async def show_help(ctx: commands.Context):
    """Custom help command listing visible commands and brief docstrings."""
    lines = []
    for c in bot.commands:
        if c.hidden:
            continue
        sig = f"{config.PREFIX}{c.name}"
        brief = (c.help or "").splitlines()[0] if c.help else ""
        lines.append(f"{sig} — {brief}")
    if not lines:
        await ctx.send("No commands available.")
        return
    text = "\n".join(lines)
    await ctx.send(f"Допомога - команди бота\n\n{text}")

@bot.command(name="reloadembeds")
@commands.has_role(config.ADMIN_ROLE_ID)
async def reload_embeds(ctx: commands.Context):
    """Reload embed JSON files from disk into cache. Admin-only."""
    global EMBEDS
    EMBEDS = load_embeds(config.EMBED_FOLDER)
    await ctx.send(f"Завантажено {len(EMBEDS)} ембедів.")


@bot.command(name="say")
@commands.has_role(config.ADMIN_ROLE_ID)
async def say(ctx: commands.Context, *, text: str):
    """Send plain text message as the bot. Restricted by role ID from config.py.

    Behavior:
      - Try to delete the invoker's message immediately.
      - If deletion fails, show a brief error notice that auto-deletes after 15s.
      - Send the bot message and auto-delete it after 15s.
    """
    try:
        await ctx.message.delete()
    except discord.Forbidden:
        try:
            notice = await ctx.send("Не можу видалити ваше повідомлення — недостатньо прав у бота.")
            asyncio.create_task(_delete_later(notice, 15))
        except Exception:
            pass
    except Exception as e:
        try:
            notice = await ctx.send(f"Помилка при видаленні повідомлення: {e}")
            asyncio.create_task(_delete_later(notice, 15))
        except Exception:
            pass

    try:
        sent = await ctx.send(text)
    except Exception as e:
        try:
            err = await ctx.send(f"Помилка при відправленні повідомлення: {e}")
            asyncio.create_task(_delete_later(err, 15))
        except Exception:
            pass

@send_embed.error
@say.error
async def info_error(ctx: commands.Context, error):
    if isinstance(error, commands.MissingRole):
        await ctx.send("У вас немає дозволу на використання цієї команди.")
    else:
        await ctx.send(f"Виникла помилка: {error}")

if __name__ == "__main__":
    bot.run(TOKEN)