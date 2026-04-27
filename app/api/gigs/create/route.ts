import { NextResponse } from "next/server";
import { getConfig } from "@/lib/config";
import { buildAndPersistSnapshot } from "@/lib/sync";
import { buildMonthBoard } from "@/lib/view";
import {
  CreateGigInputSchema,
  DayAlreadyBookedError,
  createGigWriteThrough,
} from "@/lib/gigs";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function parseBearerToken(req: Request): string | null {
  const header = req.headers.get("authorization") ?? "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  const token = match?.[1]?.trim();
  return token && token.length > 0 ? token : null;
}

function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function isDayBookedInSnapshot(
  date: string,
  timezone: string,
  snapshot: Parameters<typeof buildMonthBoard>[0]["snapshot"],
): boolean {
  const month = buildMonthBoard({
    snapshot,
    month: date.slice(0, 7),
    timezone,
    todayKey: date,
  });
  const day = month.weeks.flatMap((week) => week.days).find((d) => d.date === date);
  if (!day) return true; // fail-closed: unknown day is treated as unavailable
  return day.status !== "available";
}

export async function POST(req: Request) {
  const { file, env } = getConfig();
  const presentedToken = parseBearerToken(req);
  if (!presentedToken) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!env.EDITOR_TOKEN) {
    return NextResponse.json({ error: "editor token not configured" }, { status: 503 });
  }
  if (!constantTimeEquals(presentedToken, env.EDITOR_TOKEN)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  if (!env.GOOGLE_CALENDAR_ID) {
    return NextResponse.json(
      { error: "GOOGLE_CALENDAR_ID is not configured" },
      { status: 503 },
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = CreateGigInputSchema.safeParse(body);
  if (!parsed.success) {
    const message = parsed.error.issues[0]?.message ?? "Invalid input";
    return NextResponse.json({ error: message }, { status: 400 });
  }

  const preWriteSync = await buildAndPersistSnapshot();
  if (preWriteSync.status !== "ok" || !preWriteSync.snapshot) {
    return NextResponse.json(
      { error: preWriteSync.error ?? "Failed to refetch calendar data" },
      { status: 502 },
    );
  }
  if (isDayBookedInSnapshot(parsed.data.date, file.timezone, preWriteSync.snapshot)) {
    return NextResponse.json({ error: "Day already booked" }, { status: 409 });
  }

  try {
    const result = await createGigWriteThrough({
      input: parsed.data,
      calendarId: env.GOOGLE_CALENDAR_ID,
      timezone: file.timezone,
      clientId: env.GOOGLE_CLIENT_ID,
      clientSecret: env.GOOGLE_CLIENT_SECRET,
      refreshToken: env.GOOGLE_REFRESH_TOKEN,
      refetchFreshSnapshot: async () => {
        const sync = await buildAndPersistSnapshot();
        if (sync.status !== "ok" || !sync.snapshot) {
          const message = sync.error ?? "Failed to refetch calendar data";
          throw new Error(message);
        }
        return sync.snapshot;
      },
    });

    return NextResponse.json({
      status: "ok",
      snapshot: result.snapshot,
    });
  } catch (err) {
    if (err instanceof DayAlreadyBookedError) {
      return NextResponse.json({ error: "Day already booked" }, { status: 409 });
    }
    const message = err instanceof Error ? err.message : "Failed to create event";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
