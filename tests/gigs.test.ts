import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Snapshot } from "@/lib/types";

type StoredEvent = {
  id: string;
  status?: string;
  startMs: number;
  endMs: number;
};

type EventsListRequest = {
  calendarId?: string;
  timeMin?: string;
  timeMax?: string;
};

type EventsInsertRequest = {
  calendarId?: string;
  requestBody?: {
    id?: string;
    start?: { date?: string | null };
    end?: { date?: string | null };
  };
};

const calendars = new Map<string, StoredEvent[]>();
const listMock = vi.fn();
const insertMock = vi.fn();

vi.mock("googleapis", () => {
  class OAuth2Mock {
    constructor(_clientId: string, _clientSecret: string) {}
    setCredentials(_creds: unknown) {}
  }

  return {
    google: {
      auth: { OAuth2: OAuth2Mock },
      calendar: vi.fn(() => ({
        events: {
          list: listMock,
          insert: insertMock,
        },
      })),
    },
  };
});

import {
  DayAlreadyBookedError,
  createGigWriteThrough,
} from "@/lib/gigs";

function snapshotStub(): Snapshot {
  return {
    version: 1,
    generatedAtUtc: "2026-04-27T15:00:00.000Z",
    windowStartUtc: "2026-04-27T00:00:00.000Z",
    windowEndUtc: "2026-05-27T00:00:00.000Z",
    busy: [],
    sourceCalendarIds: ["primary"],
    config: {
      timezone: "UTC",
      workdayStartHour: 9,
      workdayEndHour: 18,
      hideWeekends: true,
      showTentative: false,
      pageTitle: "Availability",
    },
  };
}

describe("createGigWriteThrough", () => {
  beforeEach(() => {
    calendars.clear();
    listMock.mockReset();
    insertMock.mockReset();

    listMock.mockImplementation(async (req: EventsListRequest) => {
      const calendarId = req.calendarId ?? "primary";
      const timeMinMs = Date.parse(req.timeMin ?? "");
      const timeMaxMs = Date.parse(req.timeMax ?? "");
      const events = calendars.get(calendarId) ?? [];
      const items = events
        .filter((event) => event.endMs > timeMinMs && event.startMs < timeMaxMs)
        .map((event) => ({
          id: event.id,
          status: event.status ?? "confirmed",
        }));
      return { data: { items } };
    });

    insertMock.mockImplementation(async (req: EventsInsertRequest) => {
      const calendarId = req.calendarId ?? "primary";
      const id = req.requestBody?.id ?? "generated-id";
      const startDate = req.requestBody?.start?.date;
      const endDate = req.requestBody?.end?.date;
      if (!startDate || !endDate) {
        throw new Error("missing date fields");
      }

      const events = calendars.get(calendarId) ?? [];
      if (events.some((event) => event.id === id)) {
        const err = new Error("duplicate");
        (err as { status?: number }).status = 409;
        throw err;
      }

      // Simulate API latency so idempotency locking can be exercised.
      await new Promise((resolve) => setTimeout(resolve, 30));
      events.push({
        id,
        startMs: Date.parse(`${startDate}T00:00:00.000Z`),
        endMs: Date.parse(`${endDate}T00:00:00.000Z`),
      });
      calendars.set(calendarId, events);

      return { data: { id } };
    });
  });

  it("creates an all-day gig on an empty day and returns freshly refetched data", async () => {
    const refetch = vi.fn(async () => snapshotStub());
    const result = await createGigWriteThrough({
      input: {
        date: "2026-05-01",
        title: "LA#72345 New Gig",
        notes: "Load-in at noon",
      },
      calendarId: "la-work@group.calendar.google.com",
      timezone: "UTC",
      clientId: "id",
      clientSecret: "secret",
      refreshToken: "refresh",
      refetchFreshSnapshot: refetch,
    });

    expect(insertMock).toHaveBeenCalledTimes(1);
    const insertArg = insertMock.mock.calls[0]?.[0] as EventsInsertRequest;
    expect(insertArg.requestBody?.start?.date).toBe("2026-05-01");
    expect(insertArg.requestBody?.end?.date).toBe("2026-05-02");
    expect(refetch).toHaveBeenCalledTimes(1);
    expect(result.snapshot.generatedAtUtc).toBe("2026-04-27T15:00:00.000Z");
  });

  it("returns DayAlreadyBookedError when any event already exists on that day", async () => {
    calendars.set("la-work@group.calendar.google.com", [{
      id: "existing-event",
      startMs: Date.parse("2026-05-03T09:00:00.000Z"),
      endMs: Date.parse("2026-05-03T10:00:00.000Z"),
    }]);

    await expect(
      createGigWriteThrough({
        input: {
          date: "2026-05-03",
          title: "LA#73333 Existing day",
        },
        calendarId: "la-work@group.calendar.google.com",
        timezone: "UTC",
        clientId: "id",
        clientSecret: "secret",
        refreshToken: "refresh",
        refetchFreshSnapshot: async () => snapshotStub(),
      }),
    ).rejects.toBeInstanceOf(DayAlreadyBookedError);

    expect(insertMock).not.toHaveBeenCalled();
  });

  it("prevents duplicate bookings on double-submit for the same day", async () => {
    const refetch = vi.fn(async () => snapshotStub());
    const request = {
      input: {
        date: "2026-05-04",
        title: "LA#74444 Double click",
      },
      calendarId: "la-work@group.calendar.google.com",
      timezone: "UTC",
      clientId: "id",
      clientSecret: "secret",
      refreshToken: "refresh",
      refetchFreshSnapshot: refetch,
    } as const;

    const [first, second] = await Promise.allSettled([
      createGigWriteThrough(request),
      createGigWriteThrough(request),
    ]);

    const successCount = [first, second].filter((r) => r.status === "fulfilled").length;
    const conflictCount = [first, second].filter(
      (r) => r.status === "rejected" && r.reason instanceof DayAlreadyBookedError,
    ).length;

    expect(successCount).toBe(1);
    expect(conflictCount).toBe(1);
    expect(insertMock).toHaveBeenCalledTimes(1);
    expect(refetch).toHaveBeenCalledTimes(1);
  });
});
