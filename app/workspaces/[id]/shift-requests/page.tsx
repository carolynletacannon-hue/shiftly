import { availabilityWarning } from "@/lib/time-off/conflicts";
import type { Availability } from "@/lib/time-off/types";
import { Frame, Message } from "@/app/components";
import { requireWorkspace } from "@/lib/auth";
import { shiftLabel } from "@/lib/scheduling/time";
import { requestAction } from "./actions";
export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ shift?: string; message?: string }>;
}) {
  const { id } = await params;
  const query = await searchParams;
  const { db, user, role } = await requireWorkspace(id);
  const manager = role !== "employee";
  const [org, policy, roster, shifts, requests] = await Promise.all([
    db.from("organizations").select("name,timezone").eq("id", id).single(),
    db
      .from("shift_coverage_policies")
      .select("*")
      .eq("organization_id", id)
      .maybeSingle(),
    db
      .from("employees")
      .select("id,user_id,display_name")
      .eq("organization_id", id),
    db
      .from("published_shifts")
      .select("*,published_schedules(timezone)")
      .eq("organization_id", id)
      .gt("starts_at", new Date().toISOString())
      .order("starts_at"),
    db
      .from("shift_requests")
      .select("*")
      .eq("organization_id", id)
      .order("created_at", { ascending: false })
      .limit(100),
  ]);
  if ([org, policy, roster, shifts, requests].some((x) => x.error))
    throw Error(
      "Unable to load shift requests. Verify the Phase 4 migration is installed.",
    );
  const { data: availability, error: availabilityError } = await db
    .from("employee_availability")
    .select("employee_id,weekday,unavailable,start_time,end_time")
    .eq("organization_id", id);
  if (availabilityError) throw Error("Unable to load availability");
  const me = roster.data?.find((e) => e.user_id === user.id)?.id;
  const previews = new Map<
    string,
    {
      eligible: boolean;
      conflict?: string;
      weekly_hours: number;
      availability_warning: boolean;
      hours_warning: boolean;
    }
  >();
  await Promise.all(
    (requests.data || [])
      .filter(
        (r) =>
          ["open", "pending"].includes(r.status) &&
          (manager ? r.replacement_employee : me),
      )
      .map(async (r) => {
        const { data, error } = await db.rpc("transfer_preview", {
          org: id,
          shift_id: r.shift_id,
          employee_id: manager ? r.replacement_employee : me,
          other_shift_id: r.other_shift_id,
        });
        if (error) throw Error("Unable to check transfer eligibility");
        data.availability_warning = availabilityWarning(
          {
            employee_id: manager ? r.replacement_employee : me,
            starts_at: r.source_snapshot.starts_at,
            ends_at: r.source_snapshot.ends_at,
          },
          (availability || []) as Availability[],
          r.source_timezone,
        );
        previews.set(r.id, data);
      }),
  );

  const name = (employee: string) =>
    roster.data?.find((e) => e.id === employee)?.display_name || "Open shift";
  const label = (s: any) =>
    `${name(s.employee_id)} · ${new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeZone: s.published_schedules?.timezone || org.data!.timezone }).format(new Date(s.starts_at))} · ${shiftLabel(s.starts_at, s.ends_at, s.published_schedules?.timezone || org.data!.timezone)}`;
  const hidden = (command: string, extra: Record<string, string> = {}) => (
    <>
      <input type="hidden" name="organization_id" value={id} />
      <input type="hidden" name="command" value={command} />
      {Object.entries(extra).map(([k, v]) => (
        <input key={k} type="hidden" name={k} value={v} />
      ))}
    </>
  );
  const action = (command: string, title: string, request_id: string) => (
    <form action={requestAction}>
      {hidden(command, { request_id })}
      <button className="button secondary">{title}</button>
    </form>
  );
  const eligibleSwaps = new Set<string>();
  if (query.shift && me)
    await Promise.all(
      (shifts.data || [])
        .filter(
          (s) =>
            s.employee_id &&
            s.employee_id !== me &&
            roster.data?.some((e) => e.id === s.employee_id && e.user_id),
        )
        .map(async (s) => {
          const { data, error } = await db.rpc("transfer_preview", {
            org: id,
            shift_id: s.id,
            employee_id: me,
            other_shift_id: query.shift,
          });
          if (error) throw Error("Unable to check swap eligibility");
          if (data?.eligible) eligibleSwaps.add(s.id);
        }),
    );
  const source = shifts.data?.find(
    (s) => s.id === query.shift && s.employee_id === me,
  );
  return (
    <Frame workspace={{ id, role, name: org.data?.name }}>
      <div className="page-heading">
        <div>
          <p className="eyebrow">{org.data?.name}</p>
          <h1>Shift Requests</h1>
          <p>
            {policy.data?.require_manager !== false
              ? "Transfers require manager approval."
              : "Agreed transfers complete automatically when eligible. Older requests may still need manager review."}{" "}
            You remain responsible until the status is completed.
          </p>
        </div>
      </div>
      <Message text={query.message} />
      {source && (
        <section className="panel workspace-card">
          <h2>{label(source)}</h2>
          <form action={requestAction}>
            {hidden("coverage", { shift_id: source.id })}
            <button className="button primary">Request Coverage</button>
          </form>
          <form action={requestAction} className="account-form">
            {hidden("swap", { shift_id: source.id })}
            <label>
              Trade for
              <select name="other_shift_id" required>
                <option value="">Choose a coworker shift</option>
                {shifts.data
                  ?.filter((s) => eligibleSwaps.has(s.id))
                  .map((s) => (
                    <option key={s.id} value={s.id}>
                      {label(s)}
                    </option>
                  ))}
              </select>
            </label>
            <button className="button secondary">Request Swap</button>
          </form>
        </section>
      )}
      {manager && (
        <section className="panel workspace-card">
          <h2>Placeholder coverage</h2>
          <p>
            Reassign a published placeholder shift now, or open it for employee
            volunteers.
          </p>
          <form action={requestAction} className="account-form">
            <input type="hidden" name="organization_id" value={id} />
            <label>
              Placeholder shift
              <select name="shift_id" required>
                {shifts.data
                  ?.filter((s) =>
                    roster.data?.some(
                      (e) => e.id === s.employee_id && !e.user_id,
                    ),
                  )
                  .map((s) => (
                    <option key={s.id} value={s.id}>
                      {label(s)}
                    </option>
                  ))}
              </select>
            </label>
            <label>
              Replacement
              <select name="employee_id">
                {roster.data
                  ?.filter((e) => e.user_id)
                  .map((e) => (
                    <option key={e.id} value={e.id}>
                      {e.display_name}
                    </option>
                  ))}
              </select>
            </label>
            <button className="button primary" name="command" value="manual">
              Assign employee
            </button>
            <button className="button secondary" name="command" value="open">
              Ask for volunteers
            </button>
          </form>
        </section>
      )}
      <section className="panel workspace-card">
        <h2>Open published shifts</h2>
        {shifts.data
          ?.filter((s) => !s.employee_id)
          .map((s) => (
            <article className="template-card" key={s.id}>
              <p>{label(s)}</p>
              <form action={requestAction}>
                {hidden("open", { shift_id: s.id })}
                <button className="button secondary">Request to cover</button>
              </form>
            </article>
          ))}
      </section>
      <section className="panel workspace-card">
        <h2>
          {manager ? "Requests and volunteers" : "Requests and open coverage"}
        </h2>
        {!requests.data?.length && <p>No requests yet.</p>}
        {requests.data?.map((r) => (
          <article className="template-card" id={`request-${r.id}`} key={r.id}>
            <h3>
              {r.kind} · {r.status}
            </h3>
            <p>
              {name(r.original_employee)} →{" "}
              {r.replacement_employee
                ? name(r.replacement_employee)
                : "Seeking volunteer"}
            </p>
            <p>
              {shiftLabel(
                r.source_snapshot.starts_at,
                r.source_snapshot.ends_at,
                r.source_timezone,
              )}
            </p>
            {r.other_snapshot && (
              <p>
                In exchange for{" "}
                {shiftLabel(
                  r.other_snapshot.starts_at,
                  r.other_snapshot.ends_at,
                  r.other_timezone,
                )}
              </p>
            )}
            {previews.has(r.id) && (
              <p>
                {previews.get(r.id)!.eligible
                  ? "No hard conflicts"
                  : previews.get(r.id)!.conflict}{" "}
                · {Number(previews.get(r.id)!.weekly_hours).toFixed(1)}{" "}
                projected hours
                {previews.get(r.id)!.hours_warning
                  ? " · Weekly hours warning"
                  : ""}
                {previews.get(r.id)!.availability_warning
                  ? " · Outside weekly availability"
                  : ""}
              </p>
            )}
            <div className="schedule-tools">
              {r.status === "open" &&
                previews.get(r.id)?.eligible &&
                me !== r.original_employee &&
                (r.kind !== "swap" || me === r.replacement_employee) && (
                  <>
                    {action("accept", "Accept", r.id)}
                    {action("decline", "Decline", r.id)}
                  </>
                )}
              {["open", "pending"].includes(r.status) &&
                r.requester === user.id &&
                action("cancel", "Cancel request", r.id)}
              {r.status === "pending" &&
                r.accepted_by === user.id &&
                action("withdraw", "Withdraw offer", r.id)}
              {manager &&
                r.status === "pending" &&
                previews.get(r.id)?.eligible &&
                action("approve", "Approve", r.id)}
              {manager &&
                ["open", "pending"].includes(r.status) &&
                action("deny", "Deny", r.id)}
            </div>
            {r.completed_at && (
              <p>
                Completed{" "}
                {new Intl.DateTimeFormat("en-US", {
                  dateStyle: "medium",
                  timeStyle: "short",
                  timeZone: org.data!.timezone,
                }).format(new Date(r.completed_at))}{" "}
                · {r.manager_required ? "Manager approved" : "Employee managed"}
              </p>
            )}
          </article>
        ))}
      </section>
    </Frame>
  );
}
