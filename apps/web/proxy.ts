import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE } from "@ao/shared";
import { sessionSecret, verifySessionValue } from "@ao/shared/session";

/**
 * Runs before every page request. Every page except /login needs a valid
 * viewer cookie. /api/* and /ingest/* are not matched: their route handlers
 * check the cookie, the ingest token or the cron secret themselves.
 */
export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  const secret = sessionSecret({
    SESSION_SECRET: process.env.SESSION_SECRET,
    VIEWER_PASSWORD: process.env.VIEWER_PASSWORD,
  });
  const loggedIn =
    Boolean(process.env.VIEWER_PASSWORD) &&
    verifySessionValue(request.cookies.get(SESSION_COOKIE)?.value, secret);

  if (pathname === "/login") {
    return loggedIn ? NextResponse.redirect(new URL("/", request.url)) : NextResponse.next();
  }
  if (!loggedIn) return NextResponse.redirect(new URL("/login", request.url));
  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!api/|ingest/|_next/static|_next/image|favicon.ico).*)"],
};
