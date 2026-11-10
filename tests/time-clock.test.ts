import { test } from "node:test";
import assert from "node:assert/strict";
import { csv, dateBounds, durations } from "../lib/time-clock/records";
import {
  hashPin,
  verifyPin,
  newPin,
  pinLookup,
  token,
  digest,
} from "../lib/time-clock/security";
test("PINs use salted scrypt, timing safe verification and scoped keyed lookup", () => {
  process.env.TIME_CLOCK_PIN_PEPPER =
    "synthetic-test-pepper-at-least-32-characters";
  const pin = newPin();
  assert.match(pin, /^\d{4}$/);
  const hash = hashPin(pin);
  assert.notEqual(hash, hashPin(pin));
  assert.ok(verifyPin(pin, hash));
  assert.ok(!verifyPin(pin === "0000" ? "0001" : "0000", hash));
  assert.ok(!verifyPin(pin, "invalid"));
  assert.notEqual(pinLookup("alpha", pin), pinLookup("beta", pin));
  assert.equal(digest(token()).length, 64);
});
test("time accounting clips overnight and DST instants without rounding or inferred breaks", () => {
  const bounds = dateBounds("2026-11-01", "2026-11-01", "America/Denver");
  assert.equal(
    (Date.parse(bounds.end) - Date.parse(bounds.start)) / 3600000,
    25,
  );
  const spring = dateBounds("2026-03-08", "2026-03-08", "America/Denver");
  assert.equal(
    (Date.parse(spring.end) - Date.parse(spring.start)) / 3600000,
    23,
  );
  const c = {
    clock_in: "2026-11-01T05:00:00Z",
    clock_out: "2026-11-01T11:00:00Z",
    time_breaks: [
      { starts_at: "2026-11-01T07:30:00Z", ends_at: "2026-11-01T08:00:00Z" },
    ],
  };
  assert.equal(
    durations(c, bounds.start, bounds.end, bounds.end).paidHours,
    4.5,
  );
  assert.equal(
    durations({ ...c, time_breaks: [] }, c.clock_in, c.clock_out, c.clock_out)
      .paidHours,
    6,
  );
  assert.throws(() => dateBounds("2026-11-02", "2026-11-01", "America/Denver"));
});
test("CSV prevents formula injection and escapes commas, quotes and newlines", () => {
  const data = csv([['=HYPERLINK("x")', " \t+cmd", "@SUM(A1)", 'a,"b"\nc']]);
  assert.ok(data.includes('"\'=HYPERLINK(""x"")"'));
  assert.ok(data.includes('"\' \t+cmd"'));
  assert.ok(data.includes('"\'@SUM(A1)"'));
  assert.ok(data.includes('"a,""b""\nc"'));
});

test("recorded sub-millisecond time is never truncated in hour calculations", () => {
  const c = {
    clock_in: "2026-11-01T05:00:00.000001Z",
    clock_out: "2026-11-01T05:00:00.000002Z",
    time_breaks: [],
  };
  assert.equal(
    durations(c, c.clock_in, c.clock_out, c.clock_out).paidHours,
    1000 / 3.6e12,
  );
  assert.equal(
    durations(
      { ...c, voided_at: c.clock_out },
      c.clock_in,
      c.clock_out,
      c.clock_out,
    ).paidHours,
    0,
  );
});
