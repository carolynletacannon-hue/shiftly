import { test } from "node:test";
import assert from "node:assert/strict";
import {
  calendarFeed,
  escapeText,
  foldLine,
  type CalendarEvent,
} from "../lib/calendar/ical";
import {
  calendarTokenHash,
  newCalendarToken,
  validCalendarToken,
} from "../lib/calendar/token";
import { serveCalendar } from "../lib/calendar/response";
import { localToInstant } from "../lib/scheduling/time";

const event: CalendarEvent = {
  shift_id: "shift",
  employee_id: "employee",
  organization_id: "business",
  sequence: 0,
  updated_at: "2026-11-01T06:00:00Z",
  cancelled: false,
  details: {
    label: "Night shift",
    position: "Front desk",
    business: "Sample Lodge",
    notes: "Employee visible notes",
    starts_at: "2026-11-01T06:00:00Z",
    ends_at: "2026-11-01T10:00:00Z",
  },
};
test("secure tokens are random, URL-safe, hashed and strictly validated", () => {
  const a = newCalendarToken(),
    b = newCalendarToken();
  assert.notEqual(a, b);
  assert.equal(a.length, 43);
  assert.ok(validCalendarToken(a));
  assert.match(calendarTokenHash(a), /^[a-f0-9]{64}$/);
  for (const value of ["", "employee-id", a + ".ics", "a".repeat(44), a + "\n"])
    assert.equal(validCalendarToken(value), false);
});
test("RFC 5545 escaping, injection resistance, UTF-8 octet folding and empty feeds", () => {
  assert.equal(
    escapeText("a\\b;c,d\r\nEND:VEVENT\u0000"),
    "a\\\\b\\;c\\,d\\nEND:VEVENT",
  );
  const line = "DESCRIPTION:" + "é😀,".repeat(90);
  const folded = foldLine(line);
  assert.equal(folded.replace(/\r\n /g, ""), line);
  assert.ok(folded.split("\r\n").every((l) => Buffer.byteLength(l) <= 75));
  const empty = calendarFeed([], "https://example.test");
  assert.match(empty, /^BEGIN:VCALENDAR\r\nVERSION:2.0/);
  assert.ok(empty.endsWith("END:VCALENDAR\r\n"));
  assert.ok(!empty.includes("VEVENT"));
});
test("stable UIDs, sequence, cancellation and actual UTC instants across overnight/DST/time zones", () => {
  const cases = [
    ["2026-11-01T00:00", "2026-11-01T03:00", "America/Denver", 4],
    ["2026-03-08T00:00", "2026-03-08T04:00", "America/Denver", 3],
    ["2026-11-07T22:00", "2026-11-08T06:00", "Europe/London", 8],
    ["2026-11-07T22:00", "2026-11-08T06:00", "Asia/Tokyo", 8],
  ] as const;
  for (const [start, end, zone, hours] of cases) {
    const starts_at = localToInstant(start, zone),
      ends_at = localToInstant(end, zone);
    assert.equal(
      (Date.parse(ends_at) - Date.parse(starts_at)) / 3600000,
      hours,
    );
    const feed = calendarFeed(
      [{ ...event, details: { ...event.details, starts_at, ends_at } }],
      "https://example.test",
    );
    assert.ok(
      feed.includes(
        `DTSTART:${new Date(starts_at).toISOString().replace(/[-:]/g, "").replace(".000", "")}`,
      ),
    );
    assert.match(feed, /UID:business-employee-shift@calendar.meadowmark/);
  }
  const changed = calendarFeed(
    [{ ...event, cancelled: true, sequence: 2 }],
    "https://example.test",
  );
  assert.match(changed, /SEQUENCE:2\r\n/);
  assert.match(changed, /STATUS:CANCELLED/);
  assert.equal(
    calendarFeed([event], "https://example.test"),
    calendarFeed([event], "https://example.test"),
  );
});
test("feed responses: hashed lookup only, invalid/revoked/expired denial, no-store and generic failures", async () => {
  const token = newCalendarToken();
  const request = (suffix: string) =>
    new Request(`https://example.test/api/calendar${suffix}`);
  let calls = 0;
  const lookup = async (hash: string) => {
    calls++;
    assert.equal(hash, calendarTokenHash(token));
    return { status: "ok", events: [event] };
  };
  for (const suffix of [
    "",
    "?token=employee-id",
    `?token=${token}&token=${token}`,
  ])
    assert.equal(
      (await serveCalendar(request(suffix), "https://example.test", lookup))
        .status,
      404,
    );
  assert.equal(calls, 0);
  const response = await serveCalendar(
    request(`?token=${token}`),
    "https://example.test",
    lookup,
  );
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type")!, /text\/calendar/);
  assert.match(response.headers.get("cache-control")!, /no-store/);
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  assert.ok(!(await response.text()).includes(token));
  for (const status of ["invalid", "expired", "revoked"])
    assert.equal(
      (
        await serveCalendar(
          request(`?token=${token}`),
          "https://example.test",
          async () => ({ status }),
        )
      ).status,
      404,
    );
  const limited = await serveCalendar(
    request(`?token=${token}`),
    "https://example.test",
    async () => ({ status: "limited" }),
  );
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get("retry-after"), "60");
  const failed = await serveCalendar(
    request(`?token=${token}`),
    "https://example.test",
    async () => {
      throw new Error(token);
    },
  );
  assert.equal(failed.status, 503);
  assert.ok(!(await failed.text()).includes(token));
});

test("independent iCalendar parser reads folded Unicode, escaped text, UTC dates and cancellations", async () => {
  const { default: ICAL } = await import("ical.js");
  const notes =
    "Team note, semicolon; slash\\ and newline\n" + "é😀".repeat(60);
  const text = calendarFeed(
    [
      {
        ...event,
        cancelled: true,
        sequence: 4,
        details: { ...event.details, notes },
      },
    ],
    "https://example.test",
  );
  const calendar = new ICAL.Component(ICAL.parse(text));
  const components = calendar.getAllSubcomponents("vevent");
  assert.equal(components.length, 1);
  const component = components[0];
  const parsed = new ICAL.Event(component);
  assert.equal(parsed.uid, "business-employee-shift@calendar.meadowmark");
  assert.equal(
    parsed.startDate.toJSDate().toISOString(),
    event.details.starts_at.replace("Z", ".000Z"),
  );
  assert.equal(
    parsed.endDate.toJSDate().toISOString(),
    event.details.ends_at.replace("Z", ".000Z"),
  );
  assert.ok(parsed.description.includes(notes));
  assert.equal(component.getFirstPropertyValue("status"), "CANCELLED");
  assert.equal(component.getFirstPropertyValue("sequence"), 4);
});

test("calendar rollout is disabled by default and requires server credentials plus canonical HTTPS origin", async () => {
  const { calendarEnabled, calendarOrigin } = await import(
    "../lib/calendar/token"
  );
  const keys = [
    "CALENDAR_FEEDS_ENABLED",
    "SUPABASE_SERVICE_ROLE_KEY",
    "NEXT_PUBLIC_SUPABASE_URL",
    "NEXT_PUBLIC_SITE_URL",
  ] as const;
  const saved = keys.map((key) => process.env[key]);
  try {
    for (const key of keys) delete process.env[key];
    assert.equal(calendarEnabled(), false);
    process.env.CALENDAR_FEEDS_ENABLED = "true";
    assert.equal(calendarEnabled(), false);
    process.env.SUPABASE_SERVICE_ROLE_KEY = "synthetic-key";
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
    assert.equal(calendarEnabled(), true);
    for (const invalid of [
      "http://localhost:3000",
      "https://example.test/path",
      "https://user:pass@example.test",
      "https://example.test?token=abc",
      "https://example.test#fragment",
      "",
    ]) {
      process.env.NEXT_PUBLIC_SITE_URL = invalid;
      assert.throws(calendarOrigin);
    }
    process.env.NEXT_PUBLIC_SITE_URL = "https://example.test/";
    assert.equal(calendarOrigin(), "https://example.test");
  } finally {
    keys.forEach((key, i) => {
      if (saved[i] === undefined) delete process.env[key];
      else process.env[key] = saved[i];
    });
  }
});
