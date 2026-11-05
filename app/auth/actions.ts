"use server";
import { redirect } from "next/navigation";
import { supabase } from "@/lib/supabase/server";
import { field, safeNext } from "@/lib/forms";
import { requireUser } from "@/lib/auth";
function origin() {
  const value = process.env.NEXT_PUBLIC_SITE_URL;
  if (!value)
    throw new Error("Set NEXT_PUBLIC_SITE_URL to the canonical app URL");
  return new URL(value).origin;
}
export async function authenticate(form: FormData) {
  const mode = field(form, "mode");
  const next = safeNext(form.get("next") as string);
  const db = await supabase();
  let failed = false;
  try {
    const email = field(form, "email", 254);
    const password = field(form, "password", 128);
    if (password.length < 12 && mode === "signup")
      throw new Error("Use at least 12 characters");
    const { error } =
      mode === "signup"
        ? await db.auth.signUp({
            email,
            password,
            options: {
              emailRedirectTo:
                origin() + "/auth/callback?next=" + encodeURIComponent(next),
              data: { display_name: field(form, "display_name") },
            },
          })
        : await db.auth.signInWithPassword({ email, password });
    failed = !!error;
  } catch {
    failed = true;
  }
  if (failed)
    redirect(
      "/" +
        (mode === "signup" ? "signup" : "login") +
        "?message=Unable+to+sign+in+or+create+account.+Check+your+details.&next=" +
        encodeURIComponent(next),
    );
  if (mode === "signup")
    redirect(
      "/login?message=Check+your+email+to+confirm+your+account.&next=" +
        encodeURIComponent(next),
    );
  redirect(next);
}
export async function logout() {
  const db = await supabase();
  const { error } = await db.auth.signOut();
  if (error) redirect("/workspaces?message=Sign+out+failed.+Please+try+again");
  redirect("/login");
}
export async function requestReset(form: FormData) {
  const db = await supabase();
  try {
    await db.auth.resetPasswordForEmail(field(form, "email", 254), {
      redirectTo: origin() + "/auth/callback?next=/reset-password",
    });
  } catch {
    /* Do not reveal account existence. */
  }
  redirect(
    "/forgot-password?message=If+an+account+exists,+a+reset+link+has+been+sent.",
  );
}
export async function resetPassword(form: FormData) {
  const { db } = await requireUser();
  let failed = false;
  try {
    const password = field(form, "password", 128);
    if (password.length < 12) throw new Error();
    const { error } = await db.auth.updateUser({ password });
    failed = !!error;
  } catch {
    failed = true;
  }
  if (failed)
    redirect(
      "/reset-password?message=Unable+to+update+password.+Use+a+fresh+reset+link+and+at+least+12+characters.",
    );
  await db.auth.signOut();
  redirect("/login?message=Password+updated.+Please+sign+in.");
}
