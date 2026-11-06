export function timeOffEmail(event: string, workspaceUrl: string) {
  const subject =
    event === "submitted"
      ? "New time-off request in Shiftly"
      : `Your time-off request was ${event === "approved" ? "approved" : "denied"}`;
  // Deliberately omit names, dates and private notes from email previews.
  const text = `${subject}. Open your private workspace to view details: ${workspaceUrl}`;
  const escaped = text.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
  return { subject, text, html: `<p>${escaped}</p>` };
}
