/** Copy this dependency-free v1 contract into Connect; breaking changes require v2. */
export const CONNECT_CONTRACT_VERSION = "1" as const;
export type ConnectRole = "member" | "moderator";
export type ConnectCapability =
  | "directory:read"
  | "communication:participate"
  | "communication:moderate";
export const connectCapabilities: Record<
  ConnectRole,
  readonly ConnectCapability[]
> = {
  member: ["directory:read", "communication:participate"],
  moderator: [
    "directory:read",
    "communication:participate",
    "communication:moderate",
  ],
};
export interface ConnectContextV1 {
  version: "1";
  account_id: string;
  organization_id: string;
  organization_name: string;
  timezone: string;
  employee_id: string | null;
  role: ConnectRole;
}
export interface ConnectDirectoryEntryV1 {
  organization_id: string;
  employee_id: string;
  display_name: string;
}
