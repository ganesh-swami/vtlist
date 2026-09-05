/**
 * Route guard. Everything except the login page requires a signed-in session.
 *
 * Next 16 renamed the `middleware` convention to `proxy`; the export must be
 * named `proxy`, and the runtime is always nodejs.
 *
 * Two jobs, in this order:
 *   1. refresh the Supabase session cookie, so a long-lived tab does not get
 *      silently logged out mid-search;
 *   2. bounce anyone without a session to /login, remembering where they were
 *      headed so the redirect after sign-in lands somewhere useful.
 *
 * This is the convenience layer. The real enforcement is row-level security in
 * the database (migration 0004) — a request that somehow slipped past here
 * still gets nothing back.
 */
import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

/** Paths reachable without a session. */
const PUBLIC = ["/login", "/auth"];

export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll: (cookiesToSet) => {
          for (const { name, value } of cookiesToSet) request.cookies.set(name, value);
          response = NextResponse.next({ request });
          for (const { name, value, options } of cookiesToSet) {
            response.cookies.set(name, value, options);
          }
        },
      },
    },
  );

  // getUser() revalidates against Supabase rather than trusting the cookie's
  // claims, which is the difference between a guard and a suggestion.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { pathname } = request.nextUrl;
  const isPublic = PUBLIC.some((p) => pathname === p || pathname.startsWith(p + "/"));

  if (!user && !isPublic) {
    const login = request.nextUrl.clone();
    login.pathname = "/login";
    login.searchParams.set("next", pathname + request.nextUrl.search);
    return NextResponse.redirect(login);
  }

  if (user && pathname === "/login") {
    const home = request.nextUrl.clone();
    home.pathname = "/";
    home.search = "";
    return NextResponse.redirect(home);
  }

  return response;
}

export const config = {
  // Everything except Next's own build output and the favicon. The image route
  // is intentionally NOT excluded — roll scans need the session too.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
