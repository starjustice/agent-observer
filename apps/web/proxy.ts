import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE } from "@ao/shared";
import { sessionSecret, verifySessionValue } from "@ao/shared/session";

/**
 * Runs before every page and /api request.
 * - /api/* is forwarded to the hub API, which does its own cookie check.
 * - Every page except /login needs a valid viewer cookie.
 */
export function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;

  if (pathname.startsWith("/api/")) {
    const host = process.env.BIND_ADDRESS || "127.0.0.1";
    const port = process.env.API_PORT || "4317";
    const target = host.includes(":") ? `[${host}]` : host;
    return NextResponse.rewrite(new URL(`http://${target}:${port}${pathname}${search}`));
  }

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
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
