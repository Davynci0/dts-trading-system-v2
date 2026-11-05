import type { NextRequest } from "next/server";

/**
 * Pragmatic guard for mutating endpoints (scan, telegram test, vision QA).
 * Two ways in:
 *  1. `Authorization: Bearer $CRON_SECRET` — used by the cron job and any
 *     operator tooling.
 *  2. A same-origin browser request (the dashboard): the Origin/Referer host
 *     must match the request host, which blocks cross-site form/image abuse
 *     from other websites.
 * Anything else — scripted external POSTs with no credentials — gets a 403.
 */
export function isAuthorizedMutation(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.get("authorization") === `Bearer ${secret}`) return true;

  const origin = req.headers.get("origin") ?? req.headers.get("referer");
  if (!origin) return false;
  try {
    const o = new URL(origin);
    const host = req.headers.get("host");
    return host != null && o.host === host;
  } catch {
    return false;
  }
}
