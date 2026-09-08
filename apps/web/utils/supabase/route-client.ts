import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

/**
 * A Supabase client for an API route, built from that request's own cookies.
 *
 * Per request rather than a module-level singleton, so every query runs as the
 * signed-in user and row-level security applies: a request with no session
 * gets nothing back from the database even if a route's own check were somehow
 * bypassed.
 */
export async function routeClient() {
  const cookieStore = await cookies();
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      cookies: {
        getAll: () => cookieStore.getAll(),
        setAll: () => {
          // Read-only as far as auth goes; the proxy already refreshed the session.
        },
      },
    },
  );
}
