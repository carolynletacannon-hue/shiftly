export function workplaceMilestones(
  id: string,
  state: {
    timezone: string;
    employees: number;
    schedules: number;
    published: number;
  },
) {
  const base = `/workspaces/${id}`;
  return [
    {
      title: "Create a workplace",
      detail: "A home for your team’s schedules and requests.",
      complete: true,
      href: base,
    },
    {
      title: "Set workplace details",
      detail: `Scheduling time zone: ${state.timezone}. Review it before adding shifts.`,
      complete: !!state.timezone,
      href: `${base}/admin`,
    },
    {
      title: "Add or invite employees",
      detail: "Add your roster now, or come back when you’re ready.",
      complete: state.employees > 0,
      href: `${base}/employees`,
    },
    {
      title: "Create your first weekly schedule",
      detail: "Start with a draft and make it your own.",
      complete: state.schedules > 0,
      href: `${base}/schedule`,
    },
    {
      title: "Publish your schedule",
      detail:
        "Review your draft, then explicitly publish to share it with the team.",
      complete: state.published > 0,
      href: `${base}/schedule`,
    },
  ];
}
