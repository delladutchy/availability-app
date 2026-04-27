import { createHash } from "node:crypto";
import { DateTime } from "luxon";
import { google } from "googleapis";
import { z } from "zod";
import type { Snapshot } from "./types";

export const CreateGigInputSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD"),
  title: z.string().trim().min(1, "title is required").max(200, "title too long"),
  notes: z.string().max(5000, "notes too long").optional(),
});

export type CreateGigInput = z.infer<typeof CreateGigInputSchema>;

export class DayAlreadyBookedError extends Error {
  constructor() {
    super("Day already booked");
    this.name = "DayAlreadyBookedError";
  }
}

interface CreateGigWriteThroughOptions {
  input: CreateGigInput;
  calendarId: string;
  timezone: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  refetchFreshSnapshot: () => Promise<Snapshot>;
}

export interface CreateGigWriteThroughResult {
  snapshot: Snapshot;
}

const dateLocks = new Map<string, Promise<void>>();

async function withDateLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = dateLocks.get(key);
  let release: (() => void) | undefined;
  const current = new Promise<void>((resolve) => {
    release = () => resolve();
  });
  dateLocks.set(key, current);

  if (previous) {
    await previous;
  }

  try {
    return await fn();
  } finally {
    if (release) {
      release();
    }
    if (dateLocks.get(key) === current) {
      dateLocks.delete(key);
    }
  }
}

function dayBounds(date: string, timezone: string): {
  startUtcIso: string;
  endUtcIso: string;
  nextDateKey: string;
} {
  const start = DateTime.fromISO(date, { zone: timezone }).startOf("day");
  if (!start.isValid || start.toFormat("yyyy-LL-dd") !== date) {
    throw new Error("Invalid date");
  }
  const end = start.plus({ days: 1 });
  const startUtcIso = start.toUTC().toISO();
  const endUtcIso = end.toUTC().toISO();
  if (!startUtcIso || !endUtcIso) {
    throw new Error("Invalid date");
  }
  return {
    startUtcIso,
    endUtcIso,
    nextDateKey: end.toFormat("yyyy-LL-dd"),
  };
}

function idempotencyEventId(calendarId: string, date: string): string {
  const seed = `${calendarId}|${date}`;
  const hash = createHash("sha1").update(seed).digest("hex").slice(0, 20);
  return `gig${date.replace(/-/g, "")}${hash}`;
}

function isConflictError(err: unknown): boolean {
  const status = (err as { code?: number; status?: number; response?: { status?: number } })?.status
    ?? (err as { code?: number })?.code
    ?? (err as { response?: { status?: number } })?.response?.status;
  return status === 409;
}

export async function createGigWriteThrough(
  opts: CreateGigWriteThroughOptions,
): Promise<CreateGigWriteThroughResult> {
  const lockKey = `${opts.calendarId}|${opts.input.date}`;
  return withDateLock(lockKey, async () => {
    const { startUtcIso, endUtcIso, nextDateKey } = dayBounds(opts.input.date, opts.timezone);

    const auth = new google.auth.OAuth2(opts.clientId, opts.clientSecret);
    auth.setCredentials({ refresh_token: opts.refreshToken });
    const calendar = google.calendar({ version: "v3", auth });

    const existing = await calendar.events.list({
      calendarId: opts.calendarId,
      timeMin: startUtcIso,
      timeMax: endUtcIso,
      singleEvents: true,
      showDeleted: false,
      maxResults: 1,
      orderBy: "startTime",
      fields: "items(id,status)",
    });

    const hasEvent = (existing.data.items ?? []).some((item) => item.status !== "cancelled");
    if (hasEvent) {
      throw new DayAlreadyBookedError();
    }

    try {
      await calendar.events.insert({
        calendarId: opts.calendarId,
        requestBody: {
          id: idempotencyEventId(opts.calendarId, opts.input.date),
          summary: opts.input.title.trim(),
          ...(opts.input.notes && opts.input.notes.trim().length > 0
            ? { description: opts.input.notes.trim() }
            : {}),
          start: { date: opts.input.date },
          end: { date: nextDateKey },
        },
      });
    } catch (err) {
      if (isConflictError(err)) {
        throw new DayAlreadyBookedError();
      }
      throw err;
    }

    const snapshot = await opts.refetchFreshSnapshot();
    return { snapshot };
  });
}
