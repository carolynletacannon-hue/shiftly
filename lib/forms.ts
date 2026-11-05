export function field(form: FormData, key: string, max = 100) {
  const value = form.get(key);
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw new Error("Please check " + key);
  return key === "password" ? value : value.trim();
}
export function safeNext(value: string | null | undefined) {
  if (!value || !value.startsWith("/") || /[\\\x00-\x20\x7f]/.test(value))
    return "/workspaces";
  try {
    const destination = new URL(value, "https://shiftly.invalid");
    if (destination.origin !== "https://shiftly.invalid") return "/workspaces";
    return destination.pathname + destination.search + destination.hash;
  } catch {
    return "/workspaces";
  }
}
