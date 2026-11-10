export function clockButtonLabel(command: string, pending = false) {
  const labels: Record<string, [string, string]> = {
    approve: ["Approve Timecard", "Approving…"],
    void: ["Void Timecard", "Voiding…"],
    pin: ["Generate New PIN", "Generating…"],
    enroll: ["Activate Kiosk & Sign Out", "Activating…"],
    settings: ["Save Settings", "Saving Settings…"],
    bulk_approve: ["Approve All Eligible", "Approving…"],
    correct: ["Save Correction", "Saving Correction…"],
    request: ["Request Correction", "Submitting…"],
    review: ["Review Request", "Reviewing…"],
    revoke: ["Revoke Kiosk", "Revoking…"],
  };
  return (labels[command] || ["Save", "Saving…"])[pending ? 1 : 0];
}
