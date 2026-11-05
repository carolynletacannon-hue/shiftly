"use client";

import { useMemo, useState } from "react";

type Tab = "schedule" | "requests" | "team";
type Request = {
  id: number;
  employee: string;
  date: string;
  note: string;
  status: "Pending" | "Approved" | "Denied";
};
type Shift = { employee: string; time: string; role: string };

const employees = [
  "Alex Morgan",
  "Jamie Lee",
  "Taylor Brooks",
  "Riley Chen",
  "Jordan Ellis",
  "Sam Rivera",
  "Casey Parker",
];
const shifts: Shift[][] = [
  [
    { employee: employees[0], time: "7 AM – 3 PM", role: "Morning" },
    { employee: employees[1], time: "3 PM – 11 PM", role: "Evening" },
  ],
  [
    { employee: employees[2], time: "7 AM – 3 PM", role: "Morning" },
    { employee: employees[3], time: "3 PM – 11 PM", role: "Evening" },
  ],
  [
    { employee: employees[4], time: "7 AM – 3 PM", role: "Morning" },
    { employee: employees[5], time: "3 PM – 11 PM", role: "Evening" },
  ],
  [
    { employee: employees[6], time: "7 AM – 3 PM", role: "Morning" },
    { employee: employees[0], time: "3 PM – 11 PM", role: "Evening" },
  ],
  [
    { employee: employees[1], time: "7 AM – 3 PM", role: "Morning" },
    { employee: employees[2], time: "3 PM – 11 PM", role: "Evening" },
  ],
  [
    { employee: employees[3], time: "7 AM – 3 PM", role: "Morning" },
    { employee: employees[4], time: "3 PM – 11 PM", role: "Evening" },
  ],
  [
    { employee: employees[5], time: "7 AM – 3 PM", role: "Morning" },
    { employee: employees[6], time: "3 PM – 11 PM", role: "Evening" },
  ],
];
const initialRequests: Request[] = [
  {
    id: 1,
    employee: "Jamie Lee",
    date: "Nov 20, 2026",
    note: "Family event",
    status: "Pending",
  },
  {
    id: 2,
    employee: "Riley Chen",
    date: "Nov 27, 2026",
    note: "Appointment",
    status: "Pending",
  },
];
const sunday = (weekOffset: number) => {
  const base = new Date(Date.UTC(2026, 10, 1 + weekOffset * 7));
  return Array.from({ length: 7 }, (_, index) => {
    const day = new Date(base);
    day.setUTCDate(base.getUTCDate() + index);
    return day;
  });
};
const fmt = (date: Date, opts: Intl.DateTimeFormatOptions) =>
  date.toLocaleDateString("en-US", { ...opts, timeZone: "UTC" });

export default function Home() {
  const [tab, setTab] = useState<Tab>("schedule");
  const [weekOffset, setWeekOffset] = useState(0);
  const [requests, setRequests] = useState<Request[]>(initialRequests);
  const [requestDate, setRequestDate] = useState("");
  const [requestNote, setRequestNote] = useState("");
  const [notice, setNotice] = useState("");
  const days = useMemo(() => sunday(weekOffset), [weekOffset]);
  const pendingCount = requests.filter(
    (request) => request.status === "Pending",
  ).length;

  function decide(id: number, status: "Approved" | "Denied") {
    setRequests((current) =>
      current.map((request) =>
        request.id === id ? { ...request, status } : request,
      ),
    );
    setNotice("Demo only: the approval was not saved.");
  }
  function submitRequest(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!requestDate) return;
    setRequests((current) => [
      {
        id: Date.now(),
        employee: "Alex Morgan",
        date: new Date(requestDate + "T12:00:00Z").toLocaleDateString("en-US", {
          month: "short",
          day: "numeric",
          year: "numeric",
          timeZone: "UTC",
        }),
        note: requestNote.trim() || "No reason provided",
        status: "Pending",
      },
      ...current,
    ]);
    setRequestDate("");
    setRequestNote("");
    setNotice("Demo only: this request will disappear when you reload.");
    setTab("requests");
  }

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">S</span>
          <span>
            shiftly<span className="brand-dot">.</span>
          </span>
        </div>
        <div className="workspace">
          <span className="workspace-avatar">D</span>
          <span>
            <strong>Demo Workspace</strong>
            <small>Sample hospitality team</small>
          </span>
        </div>
        <a href="/workspaces" className="nav-item">
          Open real workspaces →
        </a>
        <div className="nav-label">DEMO WORKSPACE</div>
        <nav aria-label="Main navigation">
          <button
            className={tab === "schedule" ? "nav-item active" : "nav-item"}
            onClick={() => setTab("schedule")}
          >
            <span>▦</span> Schedule
          </button>
          <button
            className={tab === "requests" ? "nav-item active" : "nav-item"}
            onClick={() => setTab("requests")}
          >
            <span>▣</span> Requests{" "}
            <span className="nav-count">{pendingCount}</span>
          </button>
          <button
            className={tab === "team" ? "nav-item active" : "nav-item"}
            onClick={() => setTab("team")}
          >
            <span>♧</span> Team
          </button>
        </nav>
        <div className="sidebar-bottom">
          <strong>Built for smaller teams.</strong>
          <p>Scheduling should be the easiest part of your day.</p>
        </div>
      </aside>

      <main className="content">
        <header className="topbar">
          <span>
            Shiftly /{" "}
            {tab === "schedule"
              ? "Schedule"
              : tab === "requests"
                ? "Requests"
                : "Team"}
          </span>
          <span className="user-pill">
            AM <span>Demo manager</span>
          </span>
        </header>
        <div className="page">
          <div className="demo-banner">
            <span className="demo-dot" /> <strong>Preview mode</strong> —
            Fictional team and schedule. Nothing is stored or sent to employees.
          </div>
          {notice && (
            <div role="status" className="notice">
              {notice}{" "}
              <button onClick={() => setNotice("")} aria-label="Dismiss notice">
                ×
              </button>
            </div>
          )}
          {tab === "schedule" && (
            <>
              <div className="page-heading">
                <div>
                  <p className="eyebrow">TEAM SCHEDULING</p>
                  <h1>Weekly schedule</h1>
                  <p className="subtitle">
                    A clear view of who is working and when.
                  </p>
                </div>
                <button
                  className="button primary"
                  onClick={() =>
                    setNotice(
                      "Demo only: schedule publishing is not implemented.",
                    )
                  }
                >
                  + Publish schedule
                </button>
              </div>
              <div className="stats">
                <div className="stat">
                  <span>TEAM MEMBERS</span>
                  <strong>7</strong>
                  <small>On your roster</small>
                </div>
                <div className="stat">
                  <span>SHIFTS THIS WEEK</span>
                  <strong>14</strong>
                  <small>Sample schedule</small>
                </div>
                <div className="stat">
                  <span>PENDING REQUESTS</span>
                  <strong>{pendingCount}</strong>
                  <small>Awaiting review</small>
                </div>
              </div>
              <section className="panel">
                <div className="panel-header">
                  <div>
                    <h2>Team calendar</h2>
                    <p>Sample morning and evening shifts</p>
                  </div>
                  <div className="week-nav">
                    <button
                      onClick={() => setWeekOffset((w) => w - 1)}
                      aria-label="Previous week"
                    >
                      ‹
                    </button>
                    <span>
                      {fmt(days[0], { month: "short", day: "numeric" })} –{" "}
                      {fmt(days[6], {
                        month: "short",
                        day: "numeric",
                        year: "numeric",
                      })}
                    </span>
                    <button
                      onClick={() => setWeekOffset((w) => w + 1)}
                      aria-label="Next week"
                    >
                      ›
                    </button>
                  </div>
                </div>
                <div className="calendar-scroll">
                  <div className="calendar-grid">
                    {days.map((day, i) => (
                      <div className="day" key={i}>
                        <div className="day-heading">
                          <strong>{fmt(day, { weekday: "short" })}</strong>
                          <span>
                            {fmt(day, { month: "short", day: "numeric" })}
                          </span>
                        </div>
                        {shifts.map((group, groupIndex) =>
                          groupIndex === i
                            ? group.map((shift, j) => (
                                <div
                                  className={
                                    j === 0 ? "shift morning" : "shift evening"
                                  }
                                  key={j}
                                >
                                  <span className="shift-type">
                                    {shift.role}
                                  </span>
                                  <strong>{shift.employee}</strong>
                                  <small>{shift.time}</small>
                                </div>
                              ))
                            : null,
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              </section>
              <div className="hint">
                ✨ Coming next: publish controls, availability conflicts, shift
                swaps, and private calendar subscriptions.
              </div>
            </>
          )}
          {tab === "requests" && (
            <>
              <div className="page-heading">
                <div>
                  <p className="eyebrow">EMPLOYEE REQUESTS</p>
                  <h1>Time off</h1>
                  <p className="subtitle">
                    Give your team a simpler way to ask for days off.
                  </p>
                </div>
              </div>
              <div className="two-col">
                <section className="panel">
                  <div className="panel-header">
                    <div>
                      <h2>Requests to review</h2>
                      <p>Try the demonstration approvals</p>
                    </div>
                    <span className="count-pill">{pendingCount} pending</span>
                  </div>
                  <div className="request-list">
                    {requests.map((request) => (
                      <article className="request-card" key={request.id}>
                        <div className="request-top">
                          <strong>{request.employee}</strong>
                          <span
                            className={"status " + request.status.toLowerCase()}
                          >
                            {request.status}
                          </span>
                        </div>
                        <p>{request.date}</p>
                        <small>{request.note}</small>
                        {request.status === "Pending" && (
                          <div className="actions">
                            <button
                              className="button primary"
                              onClick={() => decide(request.id, "Approved")}
                            >
                              Approve
                            </button>
                            <button
                              className="button secondary"
                              onClick={() => decide(request.id, "Denied")}
                            >
                              Deny
                            </button>
                          </div>
                        )}
                      </article>
                    ))}
                  </div>
                </section>
                <section className="panel">
                  <div className="panel-header">
                    <div>
                      <h2>Request a day off</h2>
                      <p>Employee view demonstration</p>
                    </div>
                  </div>
                  <form className="request-form" onSubmit={submitRequest}>
                    <label htmlFor="request-date">Requested date</label>
                    <input
                      id="request-date"
                      type="date"
                      required
                      value={requestDate}
                      onChange={(e) => setRequestDate(e.target.value)}
                    />
                    <label htmlFor="request-note">Reason (optional)</label>
                    <textarea
                      id="request-note"
                      placeholder="Family event, appointment…"
                      rows={4}
                      value={requestNote}
                      onChange={(e) => setRequestNote(e.target.value)}
                    />
                    <button type="submit" className="button primary">
                      Submit demo request
                    </button>
                  </form>
                </section>
              </div>
            </>
          )}
          {tab === "team" && (
            <>
              <div className="page-heading">
                <div>
                  <p className="eyebrow">YOUR PEOPLE</p>
                  <h1>Team directory</h1>
                  <p className="subtitle">
                    Seven fictional employees, one organized schedule.
                  </p>
                </div>
              </div>
              <section className="panel">
                <div className="panel-header">
                  <div>
                    <h2>Employee roster</h2>
                    <p>Team roles and availability coming soon</p>
                  </div>
                  <span className="count-pill">7 members</span>
                </div>
                <div className="team-grid">
                  {employees.map((employee, i) => (
                    <div className="person" key={employee}>
                      <span className="avatar">
                        {employee
                          .split(" ")
                          .map((part) => part[0])
                          .join("")}
                      </span>
                      <span>
                        <strong>{employee}</strong>
                        <small>{i === 0 ? "Demo manager" : "Front desk"}</small>
                      </span>
                      <span className="member-status">Active</span>
                    </div>
                  ))}
                </div>
              </section>
            </>
          )}
          <footer>
            Shiftly demo · No workplace data · Built for small teams
          </footer>
        </div>
      </main>
    </div>
  );
}
