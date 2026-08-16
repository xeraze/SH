import path from "node:path";
import { config } from "../config";
import { loadJson, saveJson } from "./json";

export interface Warn {
  id: number;
  user_id: string;
  moderator_id: string;
  reason: string;
  created_at: string;
}

export interface Reprimand {
  id: number;
  user_id: string;
  moderator_id: string;
  reason: string;
  created_at: string;
}

export type PunishmentType = "temporary" | "temporary_no_appeal" | "permanent" | "permanent_no_appeal";

export interface Mute {
  user_id: string;
  moderator_id: string;
  type: "temporary" | "permanent";
  until: string | null;
  duration: string;
  reason: string;
  created_at: string;
}

export interface TempRole {
  user_id: string;
  role_id: string;
  moderator_id: string | null;
  until: string;
  reason: string;
  created_at: string;
}

export interface Ban {
  user_id: string;
  moderator_id: string;
  type: PunishmentType;
  duration: string;
  until: string | null;
  reason: string;
  created_at: string;
}

const PUNISH_DIR = path.join(config.dataDir, "punishments");
const WARNS_FILE = path.join(PUNISH_DIR, "warns.json");
const REPRIMANDS_FILE = path.join(PUNISH_DIR, "reprimands.json");
const MUTES_FILE = path.join(PUNISH_DIR, "mutes.json");
const TEMPROLES_FILE = path.join(PUNISH_DIR, "temproles.json");
const BANS_FILE = path.join(PUNISH_DIR, "bans.json");

export function loadWarns(): Warn[] {
  return loadJson<Warn[]>(WARNS_FILE, []);
}

export function saveWarns(warns: Warn[]): void {
  saveJson(WARNS_FILE, warns);
}

export function loadReprimands(): Reprimand[] {
  return loadJson<Reprimand[]>(REPRIMANDS_FILE, []);
}

export function saveReprimands(reprimands: Reprimand[]): void {
  saveJson(REPRIMANDS_FILE, reprimands);
}

export function loadMutes(): Mute[] {
  return loadJson<Mute[]>(MUTES_FILE, []);
}

export function saveMutes(mutes: Mute[]): void {
  saveJson(MUTES_FILE, mutes);
}

export function loadTemproles(): TempRole[] {
  return loadJson<TempRole[]>(TEMPROLES_FILE, []);
}

export function saveTemproles(temproles: TempRole[]): void {
  saveJson(TEMPROLES_FILE, temproles);
}

export function loadBans(): Ban[] {
  return loadJson<Ban[]>(BANS_FILE, []);
}

export function saveBans(bans: Ban[]): void {
  saveJson(BANS_FILE, bans);
}

export function nextWarnId(): number {
  const warns = loadWarns();
  return warns.length > 0 ? Math.max(...warns.map((w) => w.id)) + 1 : 1;
}

export function nextReprimandId(): number {
  const reprimands = loadReprimands();
  return reprimands.length > 0 ? Math.max(...reprimands.map((r) => r.id)) + 1 : 1;
}