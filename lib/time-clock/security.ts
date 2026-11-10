import "server-only";
import {
  createHash,
  createHmac,
  randomBytes,
  randomInt,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
export const kioskCookie = "__Host-meadowmark-kiosk";
export const token = () => randomBytes(32).toString("base64url");
export const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export const validToken = (value: string) => /^[A-Za-z0-9_-]{43}$/.test(value);
export const newPin = () => randomInt(0, 10000).toString().padStart(4, "0");
export function pinLookup(org: string, pin: string) {
  return createHmac("sha256", process.env.TIME_CLOCK_PIN_PEPPER!)
    .update(`${org.toLowerCase()}:${pin}`)
    .digest("hex");
}
export function hashPin(pin: string) {
  const salt = randomBytes(16).toString("hex");
  return `${salt}:${scryptSync(pin, salt, 32).toString("hex")}`;
}
export function verifyPin(pin: string, encoded: string) {
  const [salt, hash] = encoded.split(":");
  const actual = scryptSync(pin, salt || "invalid-pin-salt", 32);
  const expected = /^[a-f0-9]{64}$/.test(hash || "")
    ? Buffer.from(hash, "hex")
    : Buffer.alloc(32);
  return timingSafeEqual(actual, expected);
}
export function timeClockEnabled() {
  return (
    process.env.TIME_CLOCK_ENABLED === "true" &&
    (process.env.TIME_CLOCK_PIN_PEPPER?.length || 0) >= 32 &&
    !!process.env.SUPABASE_SERVICE_ROLE_KEY
  );
}
