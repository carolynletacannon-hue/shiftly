export type InvitationEmail = {
  businessName: string;
  role: string;
  invitationUrl: string;
};
const escape = (value: string) => value.replace(/[&<>"']/g, c => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
})[c]!);

export function invitationEmail({ businessName, role, invitationUrl }: InvitationEmail) {
  const business = escape(businessName);
  const assignedRole = escape(role);
  const url = escape(invitationUrl);
  return {
    subject: `You're invited to ${businessName.replace(/[\r\n]/g, ' ')} on Meadowmark`,
    text: `Meadowmark\n\nYou're invited to join ${businessName} as ${role}.\n\nJoin Workspace: ${invitationUrl}\n\nCreate an account or sign in using the email address that received this invitation. This private, single-use invitation expires after seven days.\n\nIf you weren't expecting this invitation, you can ignore this email.`,
    html: `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Join your workspace on Meadowmark</title></head><body style="margin:0;background:#F7F9F7;color:#202C26;font-family:Arial,sans-serif"><table role="presentation" style="width:100%;border-collapse:collapse"><tr><td align="center" style="padding:24px 12px"><table role="presentation" style="width:100%;max-width:560px;border-collapse:collapse;background:#fff;border:1px solid #E2E9E4"><tr><td style="background:#E0EDE5;padding:24px;color:#202C26;font-size:28px;font-weight:bold">Meadowmark</td></tr><tr><td style="padding:28px 24px"><p style="color:#356B52;font-size:12px;font-weight:bold;letter-spacing:1px">YOUR TEAM IS WAITING</p><h1 style="font-size:26px;line-height:1.25">Join ${business}</h1><p style="font-size:16px;line-height:1.6">You've been invited to join <strong>${business}</strong> on Meadowmark as <strong>${assignedRole}</strong>.</p><p style="font-size:16px;line-height:1.6">Create an account or sign in using the email address that received this invitation to join your workspace.</p><p style="margin:28px 0"><a href="${url}" style="display:inline-block;background:#356B52;color:#fff;text-decoration:none;font-size:16px;font-weight:bold;padding:16px 24px;border-radius:9px">Join Workspace</a></p><p style="font-size:14px;line-height:1.6;color:#68786E">This private, single-use invitation expires after <strong>seven days</strong>.</p><p style="font-size:13px;line-height:1.6;color:#68786E">Button not working? Copy this link into your browser:<br><a href="${url}" style="color:#356B52;word-break:break-all">${url}</a></p></td></tr><tr><td style="padding:20px 24px;border-top:1px solid #E2E9E4;color:#68786E;font-size:12px;line-height:1.6">If you weren't expecting this invitation, you can ignore this email.<br>Meadowmark · A simpler way to work together</td></tr></table></td></tr></table></body></html>`,
  };
}
