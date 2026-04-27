import { beforeEach, describe, expect, it, vi } from "vitest";

const { getConfigMock, buildAndPersistSnapshotMock, createGigWriteThroughMock } = vi.hoisted(() => ({
  getConfigMock: vi.fn(() => ({
    file: { timezone: "UTC" },
    env: {
      EDITOR_TOKEN: "editor-secret-token",
      GOOGLE_CALENDAR_ID: "la-work@group.calendar.google.com",
      GOOGLE_CLIENT_ID: "google-client-id",
      GOOGLE_CLIENT_SECRET: "google-client-secret",
      GOOGLE_REFRESH_TOKEN: "refresh-token",
    },
  })),
  buildAndPersistSnapshotMock: vi.fn(),
  createGigWriteThroughMock: vi.fn(),
}));

vi.mock("@/lib/config", () => ({
  getConfig: getConfigMock,
}));

vi.mock("@/lib/sync", () => ({
  buildAndPersistSnapshot: buildAndPersistSnapshotMock,
}));

vi.mock("@/lib/gigs", async () => {
  const actual = await vi.importActual<typeof import("@/lib/gigs")>("@/lib/gigs");
  return {
    ...actual,
    createGigWriteThrough: createGigWriteThroughMock,
  };
});

import { POST } from "@/app/api/gigs/create/route";

function makeSnapshot(partial?: {
  generatedAtUtc?: string;
  busy?: Array<{ startUtc: string; endUtc: string }>;
}) {
  return {
    version: 1 as const,
    generatedAtUtc: partial?.generatedAtUtc ?? "2026-05-01T10:00:00.000Z",
    windowStartUtc: "2026-05-01T00:00:00.000Z",
    windowEndUtc: "2026-06-01T00:00:00.000Z",
    busy: partial?.busy ?? [],
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

describe("POST /api/gigs/create authorization", () => {
  beforeEach(() => {
    getConfigMock.mockClear();
    buildAndPersistSnapshotMock.mockReset();
    createGigWriteThroughMock.mockReset();
  });

  it("rejects unauthenticated requests server-side", async () => {
    const req = new Request("http://localhost/api/gigs/create", {
      method: "POST",
      body: JSON.stringify({ date: "2026-05-01", title: "LA#70001" }),
      headers: { "content-type": "application/json" },
    });

    const res = await POST(req);
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: "unauthorized" });
  });

  it("rejects requests with an invalid editor token", async () => {
    const req = new Request("http://localhost/api/gigs/create", {
      method: "POST",
      body: JSON.stringify({ date: "2026-05-01", title: "LA#70001" }),
      headers: {
        "content-type": "application/json",
        authorization: "Bearer wrong-token",
      },
    });

    const res = await POST(req);
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({ error: "forbidden" });
  });
});

describe("POST /api/gigs/create availability conflict checks", () => {
  beforeEach(() => {
    buildAndPersistSnapshotMock.mockReset();
    createGigWriteThroughMock.mockReset();
  });

  it("blocks a day that is booked in blocker-calendar snapshot even if target write calendar is empty", async () => {
    buildAndPersistSnapshotMock.mockResolvedValue({
      status: "ok",
      snapshot: makeSnapshot({
        busy: [{
          startUtc: "2026-05-08T00:00:00.000Z",
          endUtc: "2026-05-09T00:00:00.000Z",
        }],
      }),
    });

    const req = new Request("http://localhost/api/gigs/create", {
      method: "POST",
      body: JSON.stringify({ date: "2026-05-08", title: "LA#70008" }),
      headers: {
        "content-type": "application/json",
        authorization: "Bearer editor-secret-token",
      },
    });

    const res = await POST(req);
    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toEqual({ error: "Day already booked" });
    expect(createGigWriteThroughMock).not.toHaveBeenCalled();
  });

  it("allows creating on a truly available day and returns freshly rebuilt snapshot", async () => {
    const preSnapshot = makeSnapshot({
      generatedAtUtc: "2026-05-01T10:00:00.000Z",
      busy: [],
    });
    const postSnapshot = makeSnapshot({
      generatedAtUtc: "2026-05-01T10:05:00.000Z",
      busy: [{
        startUtc: "2026-05-10T00:00:00.000Z",
        endUtc: "2026-05-11T00:00:00.000Z",
      }],
    });

    buildAndPersistSnapshotMock
      .mockResolvedValueOnce({ status: "ok", snapshot: preSnapshot })
      .mockResolvedValueOnce({ status: "ok", snapshot: postSnapshot });

    createGigWriteThroughMock.mockImplementation(async (opts: {
      refetchFreshSnapshot: () => Promise<unknown>;
    }) => ({
      snapshot: await opts.refetchFreshSnapshot(),
    }));

    const req = new Request("http://localhost/api/gigs/create", {
      method: "POST",
      body: JSON.stringify({ date: "2026-05-10", title: "LA#70010" }),
      headers: {
        "content-type": "application/json",
        authorization: "Bearer editor-secret-token",
      },
    });

    const res = await POST(req);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.status).toBe("ok");
    expect(json.snapshot?.generatedAtUtc).toBe("2026-05-01T10:05:00.000Z");
    expect(buildAndPersistSnapshotMock).toHaveBeenCalledTimes(2);
    expect(createGigWriteThroughMock).toHaveBeenCalledTimes(1);
  });
});
