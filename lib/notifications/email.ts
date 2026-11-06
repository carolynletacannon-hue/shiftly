const escape = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
export function notificationEmail(message: string, url: string) {
  return {
    subject: "Meadowmark · Scheduling update",
    text: `${message}\n\nView details: ${url}\n\nManage email preferences in your workplace notification center.`,
    html: `<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;padding:24px;color:#273c32;background:#f7f9f5"><h1 style="font-size:22px">Meadowmark</h1><p style="line-height:1.6;white-space:pre-line">${escape(message)}</p><p><a style="display:inline-block;background:#355f4b;color:white;padding:12px 20px;border-radius:8px" href="${escape(url)}">View details</a></p><p style="font-size:13px">Manage email preferences in your workplace notification center.</p></div>`,
  };
}
