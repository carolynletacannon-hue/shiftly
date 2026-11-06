import { test } from "node:test";
import assert from "node:assert/strict";
import { deliverTimeOffEmails } from "../lib/time-off/notifications";
import { timeOffEmail } from "../lib/email/time-off";
import {
  availabilityWarning,
  timeOffConflict,
} from "../lib/time-off/conflicts";
import type { TimeOff } from "../lib/time-off/types";

test("private one-recipient emails; SMTP failures preserve decisions and do not retry", async () => {
  const previous = process.env.NEXT_PUBLIC_SITE_URL;
  process.env.NEXT_PUBLIC_SITE_URL = "https://shiftly.example.test";
  try {
    const finished: [string, string][] = [];
    const sent: string[] = [];
    const worker = {
      claim: async () => [
        {
          id: "n1",
          email: "manager@example.test",
          event: "submitted",
          organization_id: "org",
        },
        {
          id: "n2",
          email: "owner@example.test",
          event: "submitted",
          organization_id: "org",
        },
      ],
      finish: async (id: string, result: string) => {
        finished.push([id, result]);
      },
    };
    const ok = await deliverTimeOffEmails(
      "request",
      worker,
      async (message, key) => {
        sent.push(message.to);
        assert.equal(Object.hasOwn(message, "cc"), false);
        assert.match(
          message.text,
          /https:\/\/shiftly.example.test\/workspaces\/org\/time-off/,
        );
        assert.ok(!message.text.includes("notes"));
        if (key === "n1")
          throw Error("Private SMTP credentials should never escape");
        return { status: "accepted" };
      },
    );
    assert.equal(ok, false);
    assert.deepEqual(sent.sort(), [
      "manager@example.test",
      "owner@example.test",
    ]);
    assert.deepEqual(finished.sort(), [
      ["n1", "failed"],
      ["n2", "accepted"],
    ]);
    assert.equal(await deliverTimeOffEmails("request", null), false);
    assert.equal(
      await deliverTimeOffEmails("request", {
        ...worker,
        claim: async () => {
          throw Error("DB unavailable");
        },
      }),
      false,
    );
    const unconfigured = await deliverTimeOffEmails(
      "request",
      worker,
      async () => ({ status: "unconfigured" }),
    );
    assert.equal(unconfigured, false);
    process.env.NEXT_PUBLIC_SITE_URL = "javascript:alert(1)";
    let claimed = false;
    assert.equal(
      await deliverTimeOffEmails("request", {
        ...worker,
        claim: async () => {
          claimed = true;
          return [];
        },
      }),
      false,
    );
    assert.equal(claimed, false);
    for (const event of ["submitted", "approved", "denied"]) {
      const template = timeOffEmail(
        event,
        "https://shiftly.example.test/?a=<test>",
      );
      assert.ok(!template.html.includes("<test>"));
      assert.match(template.html, /&lt;test&gt;/);
    }
  } finally {
    if (previous === undefined) delete process.env.NEXT_PUBLIC_SITE_URL;
    else process.env.NEXT_PUBLIC_SITE_URL = previous;
  }
});

test("hard conflicts use actual instants, approved status, roster identity and exclusive boundaries", () => {
  const shift = {
    employee_id: "roster",
    starts_at: "2026-11-08T16:00:00Z",
    ends_at: "2026-11-08T20:00:00Z",
  };
  const off = {
    employee_id: "roster",
    starts_at: "2026-11-08T19:00:00Z",
    ends_at: "2026-11-08T22:00:00Z",
    status: "approved",
  } as TimeOff;
  assert.equal(timeOffConflict(shift, [off]), true);
  assert.equal(timeOffConflict(shift, [{ ...off, status: "pending" }]), false);
  assert.equal(
    timeOffConflict(shift, [{ ...off, employee_id: "other" }]),
    false,
  );
  assert.equal(
    timeOffConflict(shift, [{ ...off, starts_at: shift.ends_at }]),
    false,
  );
  assert.equal(timeOffConflict({ ...shift, employee_id: null }, [off]), false);
});

test("availability checks overnight segments, local weekdays and both DST transitions", () => {
  const zone = "America/Denver";
  const sunday = {
    employee_id: "roster",
    weekday: 0,
    unavailable: true,
    start_time: null,
    end_time: null,
  };
  const saturdayNight = {
    employee_id: "roster",
    starts_at: "2026-11-08T05:00:00Z",
    ends_at: "2026-11-08T09:00:00Z",
  };
  assert.equal(availabilityWarning(saturdayNight, [sunday], zone), true);
  assert.equal(
    availabilityWarning(
      { ...saturdayNight, ends_at: "2026-11-08T07:00:00Z" },
      [sunday],
      zone,
    ),
    false,
  );
  assert.equal(
    availabilityWarning(
      saturdayNight,
      [{ ...sunday, employee_id: "other" }],
      zone,
    ),
    false,
  );
  const window = {
    ...sunday,
    unavailable: false,
    start_time: "09:00:00",
    end_time: "17:00:00",
  };
  assert.equal(
    availabilityWarning(
      {
        employee_id: "roster",
        starts_at: "2026-11-08T16:00:00Z",
        ends_at: "2026-11-09T00:00:00Z",
      },
      [window],
      zone,
    ),
    false,
  );
  assert.equal(
    availabilityWarning(
      {
        employee_id: "roster",
        starts_at: "2026-11-08T15:59:00Z",
        ends_at: "2026-11-09T00:00:00Z",
      },
      [window],
      zone,
    ),
    true,
  );
  assert.equal(
    availabilityWarning(
      {
        employee_id: "roster",
        starts_at: "2026-11-01T07:30:00Z",
        ends_at: "2026-11-01T09:30:00Z",
      },
      [sunday],
      zone,
    ),
    true,
  );
  assert.equal(
    availabilityWarning(
      {
        employee_id: "roster",
        starts_at: "2027-03-14T08:30:00Z",
        ends_at: "2027-03-14T09:30:00Z",
      },
      [sunday],
      zone,
    ),
    true,
  );
});

test("availability checks the entire repeated hour, not just its endpoints", () => {
  const shift = {
    employee_id: "roster",
    starts_at: "2026-11-01T07:15:00Z",
    ends_at: "2026-11-01T08:15:00Z",
  };
  const window = {
    employee_id: "roster",
    weekday: 0,
    unavailable: false,
    start_time: "01:00:00",
    end_time: "01:30:00",
  };
  // Both endpoints say 1:15, but the shift also passes 1:30–1:59 MDT.
  assert.equal(availabilityWarning(shift, [window], "America/Denver"), true);
  assert.equal(
    availabilityWarning(
      shift,
      [{ ...window, end_time: "02:00:00" }],
      "America/Denver",
    ),
    false,
  );
});
