import "server-only";
import { supabase } from "../supabase/server";
import type { ConnectContextV1, ConnectDirectoryEntryV1 } from "./contracts";

/** Uses the caller session, never a service-role client. Fail closed on RPC errors. */
export async function connectDirectory(organizationId: string): Promise<{
  context: ConnectContextV1;
  directory: ConnectDirectoryEntryV1[];
}> {
  const db = await supabase();
  const {
    data: { user },
    error: authError,
  } = await db.auth.getUser();
  if (authError || !user) throw new Error("Connect access denied");
  const { data: context, error } = await db.rpc("connect_context_v1", {
    org: organizationId,
  });
  if (
    error ||
    !context ||
    context.account_id !== user.id ||
    context.organization_id !== organizationId
  )
    throw new Error("Connect access denied");
  const { data: directory, error: directoryError } = await db.rpc(
    "connect_directory_v1",
    { org: organizationId },
  );
  if (directoryError || !directory) throw new Error("Connect access denied");
  return { context, directory };
}
