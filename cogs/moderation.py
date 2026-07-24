import asyncio
from pathlib import Path
import json
import aiosqlite
from datetime import datetime, timedelta

import discord
from discord.ext import commands

import config

SUCCESS_TTL = 15
ERROR_TTL = 10

def is_mod(member: discord.Member) -> bool:
    return any(r.id in config.MOD_ROLE_IDS for r in member.roles)

def has_higher_role(issuer: discord.Member, target: discord.Member) -> bool:
    # issuer must have strictly higher top role position than target
    try:
        return issuer.top_role.position > target.top_role.position
    except Exception:
        return False

class Moderation(commands.Cog):
    def __init__(self, bot: commands.Bot):
        self.bot = bot
        self.db_path = config.MOD_DB
        self.bg_task = None

    async def _init_db(self):
        try:
            parent = Path(self.db_path).parent
            parent.mkdir(parents=True, exist_ok=True)
        except Exception:
            pass

        try:
            punish_dir = Path('data') / 'punishments'
            punish_dir.mkdir(parents=True, exist_ok=True)
            warns_path = punish_dir / 'warns.json'
            mutes_path = punish_dir / 'mutes.json'
            temproles_path = punish_dir / 'temproles.json'
            if not warns_path.exists():
                warns_path.write_text(json.dumps([]), encoding='utf-8')
            if not mutes_path.exists():
                mutes_path.write_text(json.dumps([]), encoding='utf-8')
            if not temproles_path.exists():
                temproles_path.write_text(json.dumps([]), encoding='utf-8')
        except Exception:
            pass

        async with aiosqlite.connect(self.db_path) as db:
            await db.execute("""
            CREATE TABLE IF NOT EXISTS warns (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                moderator_id INTEGER NOT NULL,
                reason TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
            """)
            await db.execute("""
            CREATE TABLE IF NOT EXISTS mutes (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                moderator_id INTEGER NOT NULL,
                until TIMESTAMP,
                reason TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
            """)
            await db.execute("""
            CREATE TABLE IF NOT EXISTS temproles (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                role_id INTEGER NOT NULL,
                until TIMESTAMP,
                moderator_id INTEGER,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
            """)
            await db.commit()
        try:
            print(f"Moderation DB initialized: {self.db_path}")
        except Exception:
            pass

    def _read_json(self, filename: str):
        try:
            p = Path(filename)
            if not p.exists():
                return []
            return json.loads(p.read_text(encoding='utf-8'))
        except Exception:
            return []

    def _write_json(self, filename: str, data):
        try:
            p = Path(filename)
            p.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding='utf-8')
            return True
        except Exception:
            return False

    def _parse_duration(self, s: str):
        """Parse a duration string like '15m', '2h', '1d' or plain minutes '30'.
        Returns a timedelta or None if invalid."""
        if not s:
            return None
        s = s.strip().lower()
        try:
            minutes = int(s)
            return timedelta(minutes=minutes)
        except Exception:
            pass
        try:
            if s.endswith('m'):
                return timedelta(minutes=int(s[:-1]))
            if s.endswith('h'):
                return timedelta(hours=int(s[:-1]))
            if s.endswith('d'):
                return timedelta(days=int(s[:-1]))
        except Exception:
            return None
        return None

    async def _background_task(self):
        while not getattr(self.bot, "is_ready", lambda: False)():
            await asyncio.sleep(1)

        while not self.bot.is_closed():
            try:
                try:
                    now = discord.utils.utcnow()
                except Exception:
                    now = datetime.utcnow()
                try:
                    mutes = self._read_json('data/punishments/mutes.json')
                    changed = False
                    for m in list(mutes):
                        until = m.get('until')
                        if not until:
                            continue
                        try:
                            until_dt = datetime.fromisoformat(until)
                        except Exception:
                            continue
                        if until_dt <= now:
                            user_id = m.get('user_id')
                            try:
                                for guild in self.bot.guilds:
                                    member = guild.get_member(user_id)
                                    if member:
                                        await member.timeout(None)
                            except Exception:
                                pass
                            mutes.remove(m)
                            changed = True
                    if changed:
                        self._write_json('data/punishments/mutes.json', mutes)
                except Exception:
                    pass

                try:
                    temproles = self._read_json('data/punishments/temproles.json')
                    changed = False
                    for t in list(temproles):
                        until = t.get('until')
                        if not until:
                            continue
                        try:
                            until_dt = datetime.fromisoformat(until)
                        except Exception:
                            continue
                        if until_dt <= now:
                            user_id = t.get('user_id')
                            role_id = t.get('role_id')
                            try:
                                for guild in self.bot.guilds:
                                    member = guild.get_member(user_id)
                                    role = guild.get_role(role_id)
                                    if member and role:
                                        await member.remove_roles(role, reason="temprole expired")
                            except Exception:
                                pass
                            temproles.remove(t)
                            changed = True
                    if changed:
                        self._write_json('data/punishments/temproles.json', temproles)
                except Exception:
                    pass

                try:
                    async with aiosqlite.connect(self.db_path) as db:
                        cur = await db.execute("SELECT id, user_id, role_id FROM temproles WHERE until IS NOT NULL AND until <= ?", (now,))
                        rows = await cur.fetchall()
                        for row in rows:
                            _id, user_id, role_id = row
                            try:
                                guild = discord.utils.get(self.bot.guilds)
                                member = guild.get_member(user_id)
                                role = guild.get_role(role_id)
                                if member and role:
                                    await member.remove_roles(role, reason="temprole expired")
                            except Exception:
                                pass
                            await db.execute("DELETE FROM temproles WHERE id=?", (_id,))
                        await db.commit()
                except Exception:
                    pass
            except Exception:
                pass
            await asyncio.sleep(30)

    async def _send_and_autodelete(self, ctx_or_channel, content=None, embed=None, success=True):
        ttl = SUCCESS_TTL if success else ERROR_TTL
        try:
            if isinstance(ctx_or_channel, commands.Context):
                sent = await ctx_or_channel.send(content=content, embed=embed)
            else:
                sent = await ctx_or_channel.send(content=content, embed=embed)
            asyncio.create_task(self._delete_later(sent, ttl))
        except Exception:
            pass

    async def _delete_later(self, message: discord.Message, delay: int):
        try:
            await asyncio.sleep(delay)
            await message.delete()
        except Exception:
            pass

    async def _dm_user(self, user: discord.User, embed: discord.Embed):
        try:
            await user.send(embed=embed)
        except Exception:
            pass

    def _build_mod_embed(self, title: str, description: str, user: discord.Member = None):
        e = discord.Embed(title=title, description=description, colour=discord.Colour.orange())
        e.set_footer(text="Kherson, Ukraine")
        if user:
            e.set_author(name=str(user), icon_url=user.display_avatar.url if hasattr(user, 'display_avatar') else None)
        return e

    def _check_executor(self, ctx: commands.Context) -> tuple[bool, str]:
        issuer = ctx.author
        if not isinstance(issuer, discord.Member):
            return False, "Команду можна виконати тільки на сервері."
        if not is_mod(issuer):
            return False, "Недостатньо прав."
        return True, ""

    def _member_has_role(self, member: discord.Member, role_id: int) -> bool:
        return any(r.id == role_id for r in member.roles)

    def _member_has_any(self, member: discord.Member, role_ids: list[int]) -> bool:
        return any(r.id in role_ids for r in member.roles)

    def _can_execute(self, issuer: discord.Member, action: str) -> bool:
        first3 = config.MOD_ROLE_IDS[:3]
        jr_admin = 1409112157832085565
        lead_dev = 1462864241127194728
        project_manager = 1463142695529742488
        chief_admin = 1462864241563402369
        co_chief = 1463139795130646631
        tech_admin = 1462864229341204562
        trial = config.TRIAL_ROLE_ID

        def has_any(ids):
            return self._member_has_any(issuer, ids)

        allowed_users_global = {1404735389603860503, 997425593547227216, 1080396694493077545}
        try:
            if issuer and getattr(issuer, 'id', None) in allowed_users_global:
                return True
        except Exception:
            pass

        if action == 'mute':
            # all staff except Jr Admin
            return is_mod(issuer) and not self._member_has_role(issuer, jr_admin)

        if action == 'unmute':
            allowed = set(first3) | {project_manager, chief_admin, co_chief}
            return self._member_has_any(issuer, list(allowed))

        if action in ('ban', 'unban'):
            allowed = set(first3) | {project_manager, chief_admin}
            return self._member_has_any(issuer, list(allowed))

        if action == 'kick':
            allowed = set(first3) | {project_manager, chief_admin, co_chief}
            return self._member_has_any(issuer, list(allowed))

        if action == 'warn':
            return is_mod(issuer) or self._member_has_role(issuer, trial)

        if action in ('remwarn', 'clear'):
            excluded_roles = {lead_dev, 1408925732251500687, jr_admin, trial}
            if not is_mod(issuer):
                return False
            if any(self._member_has_role(issuer, r) for r in excluded_roles):
                return False
            return True

        if action == 'temprole':
            allowed = [r for r in config.MOD_ROLE_IDS if r != tech_admin]
            return self._member_has_any(issuer, allowed)

        return False

    @commands.command(name="warn", hidden=True)
    async def warn(self, ctx: commands.Context, member: discord.Member, *, reason: str = "Причина не вказана"):
        """Issue a warn to a member."""
        try:
            await ctx.message.delete()
        except Exception:
            pass

        issuer: discord.Member = ctx.author
        if not self._can_execute(issuer, 'warn'):
            await self._send_and_autodelete(ctx, content="Недостатньо прав.", success=False)
            return
        if not has_higher_role(issuer, member) and issuer != ctx.guild.owner:
            await self._send_and_autodelete(ctx, content="Ви не можете попереджувати користувача з ролью вище або ідентичній вашій.", success=False)
            return

        try:
            warns = self._read_json('data/punishments/warns.json')
            next_id = (max([w.get('id', 0) for w in warns]) + 1) if warns else 1
            entry = {
                'id': next_id,
                'user_id': member.id,
                'moderator_id': issuer.id,
                'reason': reason,
                'created_at': datetime.utcnow().isoformat()
            }
            warns.insert(0, entry)
            self._write_json('data/punishments/warns.json', warns)
        except Exception:
            pass

        dm_embed = self._build_mod_embed("Вас попереджено / You have been warned",
                                         f"Вас попереджено адміністратором {issuer.mention}.\nПричина: {reason}\n\nЯкщо ви бажаєте перегляду вашого покарання адміністрацією, заповніть апеляційну форму в каналі <#1458525793608011796>.")
        await self._dm_user(member, dm_embed)

        public = self._build_mod_embed("Warn issued", f"{member.mention} отримав попередження. Причина: {reason}")
        await self._send_and_autodelete(ctx, embed=public, success=True)

        try:
            ch = self.bot.get_channel(config.MOD_LOG_CHANNEL_ID)
            if ch:
                await ch.send(embed=public)
        except Exception:
            pass

    @commands.command(name="warns", hidden=True)
    async def warns(self, ctx: commands.Context, member: discord.Member = None):
        try:
            await ctx.message.delete()
        except Exception:
            pass
        target = member or ctx.author
        warns = self._read_json('data/punishments/warns.json')
        rows = [w for w in warns if w.get('user_id') == target.id]
        if not rows:
            await self._send_and_autodelete(ctx, content=f"У {target.mention} немає попереджень.", success=True)
            return
        desc = "\n".join([f"#{r.get('id')} by <@{r.get('moderator_id')}>: {r.get('reason')} ({r.get('created_at')})" for r in rows[:10]])
        e = discord.Embed(title=f"Warns for {target}", description=desc)
        await self._send_and_autodelete(ctx, embed=e, success=True)

    @commands.command(name="remwarn", hidden=True)
    async def remwarn(self, ctx: commands.Context, member: discord.Member, warn_id: int = None):
        try:
            await ctx.message.delete()
        except Exception:
            pass
        issuer = ctx.author
        if not self._can_execute(issuer, 'remwarn'):
            await self._send_and_autodelete(ctx, content="Недостатньо прав.", success=False)
            return
        try:
            warns = self._read_json('data/punishments/warns.json')
            if warn_id:
                warns = [w for w in warns if not (w.get('id') == warn_id and w.get('user_id') == member.id)]
            else:
                for i, w in enumerate(warns):
                    if w.get('user_id') == member.id:
                        warns.pop(i)
                        break
            self._write_json('data/punishments/warns.json', warns)
        except Exception:
            pass
        await self._send_and_autodelete(ctx, content=f"Попередження видалено для {member.mention}.", success=True)

    @commands.command(name="kick", hidden=True)
    async def kick(self, ctx: commands.Context, member: discord.Member, *, reason: str = "Причина не вказана"):
        try:
            await ctx.message.delete()
        except Exception:
            pass
        issuer = ctx.author
        if not self._can_execute(issuer, 'kick'):
            await self._send_and_autodelete(ctx, content="Недостатньо прав.", success=False)
            return
        if not has_higher_role(issuer, member) and issuer != ctx.guild.owner:
            await self._send_and_autodelete(ctx, content="Ви не можете кікати цього користувача.", success=False)
            return
        try:
            await member.kick(reason=reason)
            public = self._build_mod_embed("User kicked", f"{member.mention} був вигнаний. Причина: {reason}")
            await self._send_and_autodelete(ctx, embed=public, success=True)
            dm = self._build_mod_embed("Вас вигнали з сервера / You have been kicked",
                                       f"Вас вигнав адміністратор {issuer.mention}.\nПричина: {reason}\n\nЯкщо ви бажаєте перегляду вашого покарання адміністрацією, заповніть апеляційну форму в каналі <#{config.MOD_LOG_CHANNEL_ID}>.")
            await self._dm_user(member, dm)
            ch = self.bot.get_channel(config.MOD_LOG_CHANNEL_ID)
            if ch:
                await ch.send(embed=public)
        except Exception as e:
            await self._send_and_autodelete(ctx, content=f"Не вдалось кікнути користувача: {e}", success=False)

    @commands.command(name="ban", hidden=True)
    async def ban(self, ctx: commands.Context, member: discord.Member, *, reason: str = "Причина не вказана"):
        try:
            await ctx.message.delete()
        except Exception:
            pass
        issuer = ctx.author
        if not self._can_execute(issuer, 'ban'):
            await self._send_and_autodelete(ctx, content="Недостатньо прав.", success=False)
            return
        if not has_higher_role(issuer, member) and issuer != ctx.guild.owner:
            await self._send_and_autodelete(ctx, content="Ви не можете банити цього користувача.", success=False)
            return
        try:
            await ctx.guild.ban(member, reason=reason)
            public = self._build_mod_embed("User banned", f"{member.mention} забанений. Причина: {reason}")
            await self._send_and_autodelete(ctx, embed=public, success=True)
            dm = self._build_mod_embed("Вас заблоковано / You have been banned",
                                       f"Вас заблокував адміністратор {issuer.mention}.\nПричина: {reason}\n\nЯкщо ви бажаєте перегляду вашого покарання адміністрацією, заповніть апеляційну форму в каналі <#{config.MOD_LOG_CHANNEL_ID}>.")
            await self._dm_user(member, dm)
            ch = self.bot.get_channel(config.MOD_LOG_CHANNEL_ID)
            if ch:
                await ch.send(embed=public)
        except Exception as e:
            await self._send_and_autodelete(ctx, content=f"Не вдалось забанити користувача: {e}", success=False)

    @commands.command(name="unban", hidden=True)
    async def unban(self, ctx: commands.Context, user_id: int):
        try:
            await ctx.message.delete()
        except Exception:
            pass
        issuer = ctx.author
        if not self._can_execute(issuer, 'unban'):
            await self._send_and_autodelete(ctx, content="Недостатньо прав.", success=False)
            return
        try:
            user = await self.bot.fetch_user(user_id)
            await ctx.guild.unban(user)
            await self._send_and_autodelete(ctx, content=f"Користувач {user} розбанений.", success=True)
        except Exception as e:
            await self._send_and_autodelete(ctx, content=f"Не вдалось розбанити: {e}", success=False)

    @commands.command(name="mute", hidden=True)
    async def mute(self, ctx: commands.Context, member: discord.Member, duration: str = "60", *, reason: str = "Причина не вказана"):
        """Apply a server timeout (native Discord timeout).

        duration accepts minutes or suffixes: 15 (minutes), 15m, 2h, 1d.
        """
        try:
            await ctx.message.delete()
        except Exception:
            pass
        issuer = ctx.author
        if not self._can_execute(issuer, 'mute'):
            await self._send_and_autodelete(ctx, content="Недостатньо прав.", success=False)
            return
        if not has_higher_role(issuer, member) and issuer != ctx.guild.owner:
            await self._send_and_autodelete(ctx, content="Ви не можете мутити цього користувача.", success=False)
            return
        delta = self._parse_duration(duration)
        if delta is None:
            await self._send_and_autodelete(ctx, content="Невірний формат тривалості. Використовуйте числа (хв) або 15m/2h/1d.", success=False)
            return
        try:
            now = discord.utils.utcnow()
        except Exception:
            now = datetime.utcnow()
        until = now + delta
        try:
            await member.timeout(until)
            try:
                mutes = self._read_json('data/punishments/mutes.json')
                entry = {
                    'user_id': member.id,
                    'moderator_id': issuer.id,
                    'until': until.isoformat(),
                    'reason': reason,
                    'created_at': discord.utils.utcnow().isoformat() if hasattr(discord.utils, 'utcnow') else datetime.utcnow().isoformat()
                }
                mutes.append(entry)
                self._write_json('data/punishments/mutes.json', mutes)
            except Exception:
                pass
            public = self._build_mod_embed("User muted", f"{member.mention} замучений на {duration}. Причина: {reason}")
            await self._send_and_autodelete(ctx, embed=public, success=True)
            dm = self._build_mod_embed("Вам тимчасово заборонили спілкування / You have been timed out",
                                       f"Ви тимчасово відключені адміністратором {issuer.mention} до {until} UTC.\nПричина: {reason}\n\nЯкщо ви бажаєте перегляду вашого покарання адміністрацією, заповніть апеляційну форму в каналі <#{config.MOD_LOG_CHANNEL_ID}>.")
            await self._dm_user(member, dm)
            ch = self.bot.get_channel(config.MOD_LOG_CHANNEL_ID)
            if ch:
                await ch.send(embed=public)
        except Exception as e:
            await self._send_and_autodelete(ctx, content=f"Не вдалось мутити користувача: {e}", success=False)

    @commands.command(name="unmute", hidden=True)
    async def unmute(self, ctx: commands.Context, member: discord.Member):
        try:
            await ctx.message.delete()
        except Exception:
            pass
        issuer = ctx.author
        if not self._can_execute(issuer, 'unmute'):
            await self._send_and_autodelete(ctx, content="Недостатньо прав.", success=False)
            return
        try:
            await member.timeout(None)
            try:
                mutes = self._read_json('data/punishments/mutes.json')
                mutes = [m for m in mutes if m.get('user_id') != member.id]
                self._write_json('data/punishments/mutes.json', mutes)
            except Exception:
                pass
            await self._send_and_autodelete(ctx, content=f"{member.mention} розмучено.", success=True)
        except Exception as e:
            await self._send_and_autodelete(ctx, content=f"Не вдалось зняти мут: {e}", success=False)

    @commands.command(name="mutes", hidden=True)
    async def mutes(self, ctx: commands.Context):
        try:
            await ctx.message.delete()
        except Exception:
            pass
        try:
            mutes = self._read_json('data/punishments/mutes.json')
            if not mutes:
                await self._send_and_autodelete(ctx, content="Немає активних мутів.", success=True)
                return
            lines = []
            for m in mutes:
                uid = m.get('user_id')
                until = m.get('until')
                reason = m.get('reason', '')
                lines.append(f"<@{uid}> until {until}: {reason}")
            desc = "\n".join(lines)
            e = discord.Embed(title="Active mutes", description=desc)
            await self._send_and_autodelete(ctx, embed=e, success=True)
        except Exception:
            await self._send_and_autodelete(ctx, content="Не вдалось отримати список мутів.", success=False)

    @commands.command(name="temprole", hidden=True)
    async def temprole(self, ctx: commands.Context, member: discord.Member, role: discord.Role, duration: str, *, reason: str = "Причина не вказана"):
        """Assign a temporary role to a member. Duration: minutes or 15m/2h/1d."""
        try:
            await ctx.message.delete()
        except Exception:
            pass
        issuer = ctx.author
        if not self._can_execute(issuer, 'temprole'):
            await self._send_and_autodelete(ctx, content="Недостатньо прав.", success=False)
            return
        if not has_higher_role(issuer, member) and issuer != ctx.guild.owner:
            await self._send_and_autodelete(ctx, content="Ви не можете призначати роль цьому користувачу.", success=False)
            return
        delta = self._parse_duration(duration)
        if delta is None:
            await self._send_and_autodelete(ctx, content="Невірний формат тривалості. Використовуйте числа (хв) або 15m/2h/1d.", success=False)
            return
        try:
            now = discord.utils.utcnow()
        except Exception:
            now = datetime.utcnow()
        until = now + delta
        try:
            await member.add_roles(role, reason=f"temprole by {issuer} until {until}")
            try:
                temproles = self._read_json('data/punishments/temproles.json')
                entry = {
                    'user_id': member.id,
                    'role_id': role.id,
                    'moderator_id': issuer.id,
                    'until': until.isoformat(),
                    'reason': reason,
                    'created_at': (discord.utils.utcnow().isoformat() if hasattr(discord.utils, 'utcnow') else datetime.utcnow().isoformat())
                }
                temproles.append(entry)
                self._write_json('data/punishments/temproles.json', temproles)
            except Exception:
                pass
            public = self._build_mod_embed("Temprole assigned", f"{member.mention} отримав роль {role.name} до {until} UTC. Причина: {reason}")
            await self._send_and_autodelete(ctx, embed=public, success=True)
            ch = self.bot.get_channel(config.MOD_LOG_CHANNEL_ID)
            if ch:
                await ch.send(embed=public)
        except Exception as e:
            await self._send_and_autodelete(ctx, content=f"Не вдалось призначити роль: {e}", success=False)

    @commands.command(name="unrole", hidden=True)
    async def unrole(self, ctx: commands.Context, member: discord.Member, role: discord.Role):
        """Remove a role from a member and clear any matching temprole entries."""
        try:
            await ctx.message.delete()
        except Exception:
            pass
        issuer = ctx.author
        if not self._can_execute(issuer, 'temprole'):
            await self._send_and_autodelete(ctx, content="Недостатньо прав.", success=False)
            return
        try:
            await member.remove_roles(role, reason=f"removed by {issuer}")
        except Exception as e:
            await self._send_and_autodelete(ctx, content=f"Не вдалося зняти роль: {e}", success=False)
            return
        try:
            temproles = self._read_json('data/punishments/temproles.json')
            temproles = [t for t in temproles if not (t.get('user_id') == member.id and t.get('role_id') == role.id)]
            self._write_json('data/punishments/temproles.json', temproles)
        except Exception:
            pass
        public = self._build_mod_embed("Role removed", f"Роль {role.name} знято у {member.mention}.")
        await self._send_and_autodelete(ctx, embed=public, success=True)
        try:
            ch = self.bot.get_channel(config.MOD_LOG_CHANNEL_ID)
            if ch:
                await ch.send(embed=public)
        except Exception:
            pass

    @commands.command(name="temproles", hidden=True)
    async def temproles(self, ctx: commands.Context, member: discord.Member = None):
        """List active temproles. If member omitted, lists caller's."""
        try:
            await ctx.message.delete()
        except Exception:
            pass
        target = member or ctx.author
        try:
            temproles = self._read_json('data/punishments/temproles.json')
            rows = [t for t in temproles if t.get('user_id') == target.id]
            if not rows:
                await self._send_and_autodelete(ctx, content=f"У {target.mention} немає тимчасових ролей.", success=True)
                return
            lines = []
            for r in rows:
                role_id = r.get('role_id')
                until = r.get('until')
                reason = r.get('reason', '')
                lines.append(f"<@{r.get('user_id')}> — <@&{role_id}> until {until}: {reason}")
            desc = "\n".join(lines)
            e = discord.Embed(title=f"Temproles for {target}", description=desc)
            await self._send_and_autodelete(ctx, embed=e, success=True)
        except Exception:
            await self._send_and_autodelete(ctx, content="Не вдалось отримати список тимчасових ролей.", success=False)

    @commands.command(name="clear", hidden=True)
    async def clear(self, ctx: commands.Context, limit: int = 10):
        try:
            await ctx.message.delete()
        except Exception:
            pass
        issuer = ctx.author
        if not self._can_execute(issuer, 'clear'):
            await self._send_and_autodelete(ctx, content="Недостатньо прав.", success=False)
            return
        try:
            deleted = await ctx.channel.purge(limit=limit)
            await self._send_and_autodelete(ctx, content=f"Видалено {len(deleted)} повідомлень.", success=True)
        except Exception as e:
            await self._send_and_autodelete(ctx, content=f"Не вдалося очистити: {e}", success=False)


async def setup(bot: commands.Bot):
    """Async setup called by load_extension: create cog, add it and schedule async tasks."""
    cog = Moderation(bot)
    await bot.add_cog(cog)
    try:
        loop = asyncio.get_running_loop()
        loop.create_task(cog._init_db())
        loop.create_task(cog._background_task())
    except RuntimeError:
        pass