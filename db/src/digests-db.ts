import { and, asc, eq, isNull, lt, or } from "drizzle-orm";
import type { Db } from "./index.js";
import {
  type DigestPromptRow,
  type DigestScheduleRow,
  digestPrompts,
  digestSchedules,
} from "./schema.js";
import { getSetting } from "./settings.js";

// ── Pure helpers (unit-tested without a DB) ────────────────────────────────

export function slugify(name: string): string {
  const s = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return s || "item";
}

export function validSendAt(s: string): boolean {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
}

export function parseRecipients(text: string): string[] {
  return text
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function validRecipients(list: string[]): boolean {
  return list.every((e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e));
}

export function isDue(
  s: { sendAt: string; enabled: boolean; lastRunOn: string | null },
  todayLocal: string,
  hhmm: string,
): boolean {
  return s.enabled && s.sendAt === hhmm && (s.lastRunOn == null || s.lastRunOn < todayLocal);
}

/** Generate a slug from `name` that is unique among existing ids in the given column. */
async function uniqueSlug(existingIds: Set<string>, name: string): Promise<string> {
  const base = slugify(name);
  if (!existingIds.has(base)) return base;
  for (let i = 2; ; i++) {
    const candidate = `${base}-${i}`;
    if (!existingIds.has(candidate)) return candidate;
  }
}

// ── Prompts CRUD ───────────────────────────────────────────────────────────

export async function listPrompts(db: Db): Promise<DigestPromptRow[]> {
  return db.select().from(digestPrompts).orderBy(asc(digestPrompts.name));
}

export async function getPrompt(db: Db, id: string): Promise<DigestPromptRow | undefined> {
  const rows = await db.select().from(digestPrompts).where(eq(digestPrompts.id, id));
  return rows[0];
}

/** Create (id omitted) or update (id given) a prompt. Returns the row id. */
export async function upsertPrompt(
  db: Db,
  input: { id?: string; name: string; body: string },
): Promise<string> {
  if (input.id) {
    await db
      .update(digestPrompts)
      .set({ name: input.name, body: input.body, updatedAt: new Date() })
      .where(eq(digestPrompts.id, input.id));
    return input.id;
  }
  const existing = await db.select({ id: digestPrompts.id }).from(digestPrompts);
  const id = await uniqueSlug(new Set(existing.map((r) => r.id)), input.name);
  await db.insert(digestPrompts).values({ id, name: input.name, body: input.body });
  return id;
}

export async function deletePrompt(db: Db, id: string): Promise<void> {
  await db.delete(digestPrompts).where(eq(digestPrompts.id, id));
}

// ── Schedules CRUD ─────────────────────────────────────────────────────────

export interface ScheduleWithPrompt extends DigestScheduleRow {
  promptName: string;
}

export async function listSchedules(db: Db): Promise<ScheduleWithPrompt[]> {
  const rows = await db
    .select({
      id: digestSchedules.id,
      name: digestSchedules.name,
      promptId: digestSchedules.promptId,
      sendAt: digestSchedules.sendAt,
      recipients: digestSchedules.recipients,
      enabled: digestSchedules.enabled,
      lastRunOn: digestSchedules.lastRunOn,
      createdAt: digestSchedules.createdAt,
      updatedAt: digestSchedules.updatedAt,
      promptName: digestPrompts.name,
    })
    .from(digestSchedules)
    .innerJoin(digestPrompts, eq(digestSchedules.promptId, digestPrompts.id))
    .orderBy(asc(digestSchedules.name));
  return rows as ScheduleWithPrompt[];
}

export async function getSchedule(db: Db, id: string): Promise<DigestScheduleRow | undefined> {
  const rows = await db.select().from(digestSchedules).where(eq(digestSchedules.id, id));
  return rows[0];
}

export async function upsertSchedule(
  db: Db,
  input: {
    id?: string;
    name: string;
    promptId: string;
    sendAt: string;
    recipients: string[] | null;
    enabled: boolean;
  },
): Promise<string> {
  const set = {
    name: input.name,
    promptId: input.promptId,
    sendAt: input.sendAt,
    recipients: input.recipients,
    enabled: input.enabled,
    updatedAt: new Date(),
  };
  if (input.id) {
    await db.update(digestSchedules).set(set).where(eq(digestSchedules.id, input.id));
    return input.id;
  }
  const existing = await db.select({ id: digestSchedules.id }).from(digestSchedules);
  const id = await uniqueSlug(new Set(existing.map((r) => r.id)), input.name);
  await db.insert(digestSchedules).values({ id, ...set });
  return id;
}

export async function deleteSchedule(db: Db, id: string): Promise<void> {
  await db.delete(digestSchedules).where(eq(digestSchedules.id, id));
}

// ── Scheduler support ──────────────────────────────────────────────────────

export interface DueSchedule {
  id: string;
  name: string;
  body: string;
  recipients: string[] | null;
}

/** Enabled schedules whose send_at == hhmm and that have not run on todayLocal yet. */
export async function dueSchedules(
  db: Db,
  todayLocal: string,
  hhmm: string,
): Promise<DueSchedule[]> {
  const rows = await db
    .select({
      id: digestSchedules.id,
      name: digestSchedules.name,
      body: digestPrompts.body,
      recipients: digestSchedules.recipients,
    })
    .from(digestSchedules)
    .innerJoin(digestPrompts, eq(digestSchedules.promptId, digestPrompts.id))
    .where(
      and(
        eq(digestSchedules.enabled, true),
        eq(digestSchedules.sendAt, hhmm),
        or(isNull(digestSchedules.lastRunOn), lt(digestSchedules.lastRunOn, todayLocal)),
      ),
    );
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    body: r.body,
    recipients: (r.recipients as string[] | null) ?? null,
  }));
}

export async function markScheduleRan(db: Db, id: string, todayLocal: string): Promise<void> {
  await db
    .update(digestSchedules)
    .set({ lastRunOn: todayLocal })
    .where(eq(digestSchedules.id, id));
}

/** A schedule's recipients, or the global digest_recipients setting, or a final default. */
export async function resolveRecipients(
  db: Db,
  schedule: { recipients: string[] | null },
): Promise<string[]> {
  if (schedule.recipients && schedule.recipients.length > 0) return schedule.recipients;
  return getSetting<string[]>(db, "digest_recipients", ["dragan@mytime.mk"]);
}

// ── Seed (cutover) ─────────────────────────────────────────────────────────

const DEFAULT_PROMPT_BODY =
  "You are a competitive-intelligence analyst. Write a concise daily competitor briefing " +
  "in BOTH English and Macedonian (English section first, then a Macedonian section) from " +
  "this JSON. One short block per competitor, highlighting the most important changes (new " +
  "sales campaigns, new/long-running ads, follower swings, stockouts, price moves). Output " +
  "clean semantic HTML only (h2/h3/p/ul/li) — NO markdown, no code fences.";

/** Seed the default prompt + 07:00 schedule once (idempotent). Replaces the old hardcoded send. */
export async function seedDigestDefaults(db: Db): Promise<void> {
  await db
    .insert(digestPrompts)
    .values({ id: "daily-default", name: "Daily competitor digest", body: DEFAULT_PROMPT_BODY })
    .onConflictDoNothing({ target: digestPrompts.id });
  await db
    .insert(digestSchedules)
    .values({
      id: "daily-0700",
      name: "Daily 07:00",
      promptId: "daily-default",
      sendAt: "07:00",
      recipients: null,
      enabled: true,
    })
    .onConflictDoNothing({ target: digestSchedules.id });
}
