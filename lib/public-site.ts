/** Only emit public canonical URLs for an explicitly configured HTTPS origin. */
export function publicOrigin(
  value = process.env.NEXT_PUBLIC_SITE_URL,
): string | undefined {
  try {
    const url = new URL(value || "");
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/"
    )
      return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
}
