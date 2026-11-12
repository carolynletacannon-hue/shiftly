import { Card } from "@/app/ui/surfaces";
import { SubmitButton } from "../submit-button";
import { Frame, Input, Message } from "../components";
import { requireUser } from "@/lib/auth";
import { createWorkspace } from "../workspaces/actions";
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ message?: string }>;
}) {
  await requireUser();
  return (
    <Frame>
      <Card className="panel auth-card">
        <p className="eyebrow">A NEW BEGINNING</p>
        <h1>Create your workspace</h1>
        <p>
          Choose your business name and scheduling time zone. Next, explore your
          schedule or add employees at your own pace.
        </p>
        <Message text={(await searchParams).message} />
        <form className="account-form" action={createWorkspace}>
          <Input name="name" label="Business name" />
          <div>
            <label>
              Scheduling time zone
              <input
                name="timezone"
                required
                defaultValue="America/Denver"
                list="workplace-timezones"
                aria-describedby="timezone-help"
                maxLength={100}
              />
            </label>
            <datalist id="workplace-timezones">
              {[
                "America/Denver",
                "America/New_York",
                "America/Chicago",
                "America/Los_Angeles",
                "America/Phoenix",
                "America/Anchorage",
                "Pacific/Honolulu",
                "Europe/London",
                "Europe/Paris",
                "Asia/Tokyo",
                "Australia/Sydney",
                "UTC",
              ].map((zone) => (
                <option key={zone} value={zone} />
              ))}
            </datalist>
            <small id="timezone-help">
              For example, America/Denver or Europe/London. Daylight saving is
              handled by the timezone.
            </small>
          </div>
          <SubmitButton pendingLabel="Creating workspace…">
            Create workspace
          </SubmitButton>
        </form>
      </Card>
    </Frame>
  );
}
