import { test } from "node:test";
import assert from "node:assert/strict";
import nodemailer, { type SMTPSentMessageInfo } from "nodemailer";
import { createGmailProvider, type GmailTransportFactory } from "../lib/email/gmail";
import { sendEmail, type EmailMessage, type EmailProvider } from "../lib/email/service";
import { invitationEmail } from "../lib/email/invitation";

const message: EmailMessage = { to: "teammate@example.test", ...invitationEmail({
  businessName: "Sample Team", role: "employee", invitationUrl: "https://example.test/invite?token=fixture-private-link",
}) };
const config = { user: "dedicated.shiftly@gmail.com", appPassword: "fixture-app-password" };
function response(overrides: Partial<SMTPSentMessageInfo> = {}): SMTPSentMessageInfo {
  return {
    accepted: [message.to], rejected: [], response: "250 2.0.0 OK queued",
    envelope: { from: config.user, to: [message.to] }, messageId: "fixture-id", envelopeTime: 1, messageTime: 1, messageSize: 100,
    ...overrides,
  };
}

test("Gmail requires implicit TLS, verified certificates, bounded waits and private logging", async () => {
  let closed = 0;
  const factory: GmailTransportFactory = options => {
    assert.equal(options.host, "smtp.gmail.com");
    assert.equal(options.port, 465);
    assert.equal(options.secure, true);
    assert.deepEqual(options.tls, { minVersion: "TLSv1.2", rejectUnauthorized: true, servername: "smtp.gmail.com" });
    assert.deepEqual(options.auth, { user: config.user, pass: "abcdefghijklmnop" });
    assert.equal(options.logger, false);
    assert.equal(options.debug, false);
    assert.equal(options.pool, false);
    assert.equal(options.disableFileAccess, true);
    assert.equal(options.disableUrlAccess, true);
    assert.equal(options.connectionTimeout, 10_000);
    assert.equal(options.greetingTimeout, 10_000);
    assert.equal(options.socketTimeout, 15_000);
    return {
      async sendMail(mail) {
        assert.deepEqual(mail.from, { name: "Shiftly", address: config.user });
        assert.deepEqual(mail.envelope, { from: config.user, to: [message.to] });
        assert.equal(mail.to, message.to);
        assert.equal(mail.html, message.html);
        assert.equal(mail.text, message.text);
        return response();
      },
      close() { closed++; },
    };
  };
  const provider = createGmailProvider({ user: " Dedicated.Shiftly@Gmail.com ", appPassword: "abcd efgh ijkl mnop" }, factory);
  assert.deepEqual(await sendEmail(message, "invitation/fixture", provider), { status: "accepted" });
  assert.equal(closed, 1);
});

test("SMTP acceptance must confirm the exact employee, with a successful final response", async () => {
  for (const result of [
    response({ accepted: [] }),
    response({ accepted: ["someone-else@example.test"] }),
    response({ rejected: [message.to] }),
    response({ response: "451 4.7.0 Quota exceeded" }),
    response({ response: "" }),
    response({ response: "2500 malformed" }),
  ]) {
    const provider = createGmailProvider(config, () => ({ async sendMail() { return result; }, close() {} }));
    assert.deepEqual(await sendEmail(message, "fixture", provider), { status: "failed" });
  }
  const provider = createGmailProvider(config, () => ({
    async sendMail() { return response({ accepted: [message.to.toUpperCase()] }); }, close() {},
  }));
  assert.deepEqual(await sendEmail(message, "fixture", provider), { status: "accepted" });
});

test("missing or invalid Gmail configuration disables delivery without opening a connection", async () => {
  let opened = false;
  const factory: GmailTransportFactory = () => { opened = true; throw Error("must not connect"); };
  for (const settings of [{}, { user: config.user }, { appPassword: config.appPassword },
    { user: "sender@unverified.test", appPassword: config.appPassword },
    { user: "sender@gmail.com\r\nBcc:other@example.test", appPassword: config.appPassword },
    { user: config.user, appPassword: "   " },
  ]) {
    const provider = createGmailProvider(settings, factory);
    assert.equal(provider, null);
    assert.deepEqual(await sendEmail(message, "fixture", provider), { status: "unconfigured" });
  }
  assert.equal(opened, false);
});

test("authentication, TLS, quota and connection failures are sanitized and never retried", async () => {
  for (const code of ["EAUTH", "ESOCKET", "ETIMEDOUT", "ECONNECTION", "EENVELOPE", "EMESSAGE"]) {
    let attempts = 0, closed = 0;
    const provider = createGmailProvider(config, () => ({
      async sendMail() {
        attempts++;
        throw Object.assign(new Error(`${config.appPassword} fixture-private-link`), { code });
      },
      close() { closed++; },
    }));
    const result = await sendEmail(message, "fixture", provider);
    assert.deepEqual(result, { status: "failed" });
    assert.doesNotMatch(JSON.stringify(result), /fixture-app-password|fixture-private-link/);
    assert.equal(attempts, 1);
    assert.equal(closed, 1);
  }
  const brokenFactory = createGmailProvider(config, () => { throw Error("transport setup"); });
  assert.deepEqual(await sendEmail(message, "fixture", brokenFactory), { status: "failed" });
  const brokenCleanup = createGmailProvider(config, () => ({
    async sendMail() { return response(); }, close() { throw Error("cleanup"); },
  }));
  assert.deepEqual(await sendEmail(message, "fixture", brokenCleanup), { status: "accepted" });
});

test("the service accepts a different provider without changing invitations", async () => {
  const provider: EmailProvider = {
    async send(received, deliveryKey) {
      assert.equal(received, message);
      assert.equal(deliveryKey, "invitation/fixture");
      return { status: "accepted" };
    },
  };
  assert.deepEqual(await sendEmail(message, "invitation/fixture", provider), { status: "accepted" });
  assert.deepEqual(await sendEmail(message, "fixture", { async send() { throw Error("private provider error"); } }), { status: "failed" });
});

test("Nodemailer composes both invitation alternatives and branded sender without a network connection", async () => {
  const composer = nodemailer.createTransport({ streamTransport: true, buffer: true });
  const provider = createGmailProvider(config, () => ({
    async sendMail(mail) {
      const composed = await composer.sendMail(mail);
      const mime = composed.message.toString();
      assert.match(mime, /From: Shiftly <dedicated.shiftly@gmail.com>/);
      assert.match(mime, /Content-Type: multipart\/alternative/);
      assert.match(mime, /Content-Type: text\/plain/);
      assert.match(mime, /Content-Type: text\/html/);
      assert.match(mime, /Join Workspace/);
      assert.doesNotMatch(mime, /fixture-app-password/);
      return response();
    },
    close() { composer.close(); },
  }));
  assert.deepEqual(await sendEmail(message, "fixture", provider), { status: "accepted" });
});
