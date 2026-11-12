/* Local HTTP fixture only: no real Supabase project, mail, or calendar tokens. */
const { createServer } = require("node:http");
const { spawn } = require("node:child_process");
const assert = require("node:assert/strict");
const { chromium } = (() => {
  try {
    return require("playwright");
  } catch {
    return require("../../work/browser-tools/node_modules/playwright");
  }
})();
const path = require("node:path");
const fs = require("node:fs");
const org = "00000000-0000-0000-0000-000000000001";
const owner = "00000000-0000-0000-0000-000000000002";
const employee = "00000000-0000-0000-0000-000000000003";
const user = (id) => ({
  id,
  aud: "authenticated",
  role: "authenticated",
  email: "sample@example.test",
  email_confirmed_at: new Date().toISOString(),
  app_metadata: {},
  user_metadata: {},
});
const requests = [];
let fixtureEmployees = [];
let fixtureStatuses = {};
let fixtureInvitations = [];
let tableResponses = {};
const employeeCommands = [];
const fixture = createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  let id = owner;
  try {
    id = JSON.parse(
      Buffer.from((req.headers.authorization || "").split(".")[1], "base64url"),
    ).sub;
  } catch {}
  res.setHeader("Content-Type", "application/json");
  if (url.pathname === "/auth/v1/user")
    return res.end(JSON.stringify(user(id)));
  requests.push(url);
  const table = url.pathname.split("/").pop();
  const single = (req.headers.accept || "").includes("vnd.pgrst.object");
  if (table === "employee_lifecycle") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const { command, employee: target } = JSON.parse(body);
      employeeCommands.push(command);
      if (command === "archive")
        fixtureEmployees = fixtureEmployees.map((e) =>
          e.id === target ? { ...e, archived_at: "2026-01-05T12:00:00Z" } : e,
        );
      if (command === "restore")
        fixtureEmployees = fixtureEmployees.map((e) =>
          e.id === target ? { ...e, archived_at: null } : e,
        );
      if (command === "delete")
        fixtureEmployees = fixtureEmployees.filter((e) => e.id !== target);
      res.end(
        JSON.stringify(
          fixtureStatuses[target] || {
            ok: true,
            blockers: [],
            delete_reasons: [],
          },
        ),
      );
    });
    return;
  }
  let result = [];
  if (table === "memberships")
    result =
      url.searchParams.get("organization_id") === `eq.${org}`
        ? [
            {
              user_id: id,
              role: id === employee ? "employee" : "owner",
              profiles: { display_name: "Sample member" },
            },
          ]
        : url.searchParams.has("organization_id")
          ? []
          : [
              {
                organization_id: org,
                role: id === employee ? "employee" : "owner",
                organizations: {
                  name: "Sample workplace",
                  timezone: "America/Denver",
                },
              },
              {
                organization_id: "00000000-0000-0000-0000-000000000004",
                role: "employee",
                organizations: {
                  name: "Second sample workplace",
                  timezone: "America/Denver",
                },
              },
            ];
  if (table === "organizations")
    result = [
      {
        name: "Sample workplace",
        timezone: "America/Denver",
        settings: { week_starts_on: 0 },
      },
    ];
  if (table === "employees" && id === employee)
    result = [
      {
        id: employee,
        user_id: employee,
        display_name: "Sample team member",
        archived_at: null,
      },
    ];
  if (table === "employees" && id === owner) result = fixtureEmployees;
  if (table === "invitations") result = fixtureInvitations;
  if (table === "notifications") result = { unread: 0 };
  if (Object.hasOwn(tableResponses, table)) {
    result = tableResponses[table];
    if (Array.isArray(result))
      result = result.filter((row) =>
        [...url.searchParams].every(([key, query]) => {
          if (!Object.hasOwn(row, key)) return true;
          if (query.startsWith("eq."))
            return String(row[key]) === query.slice(3);
          if (query.startsWith("lt.")) return String(row[key]) < query.slice(3);
          if (query.startsWith("gt.")) return String(row[key]) > query.slice(3);
          if (query.startsWith("gte."))
            return String(row[key]) >= query.slice(4);
          return true;
        }),
      );
  }
  if (req.method === "HEAD") res.setHeader("Content-Range", "*/0");
  if (single && !result.length) {
    res.statusCode = 406;
    return res.end(
      JSON.stringify({
        code: "PGRST116",
        details: "The result contains 0 rows",
        message: "No rows",
      }),
    );
  }
  res.end(JSON.stringify(single ? result[0] : result));
});
function session(id) {
  const jwt = [
    "eyJhbGciOiJIUzI1NiJ9",
    Buffer.from(
      JSON.stringify({ sub: id, exp: Math.floor(Date.now() / 1000) + 3600 }),
    ).toString("base64url"),
    "fixture",
  ].join(".");
  return (
    "base64-" +
    Buffer.from(
      JSON.stringify({
        access_token: jwt,
        refresh_token: "local-fixture",
        token_type: "bearer",
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        user: user(id),
      }),
    ).toString("base64url")
  );
}

module.exports = {
  fixture,
  session,
  org,
  owner,
  employee,
  employeeCommands,
  setTableResponses: (responses) => {
    tableResponses = responses;
  },
  setInvitations: (invitations) => {
    fixtureInvitations = invitations;
  },
  setStatuses: (statuses) => {
    fixtureStatuses = statuses;
  },
  setEmployees: (employees) => {
    fixtureEmployees = employees;
  },
};
