/**
 * Serve roll scans and elector photos — but only to a signed-in user.
 *
 * These files deliberately do NOT live under `public/`. Anything in `public/`
 * is served by the static handler before any application code runs, so a page
 * scan showing 27 people's names, ages and photographs would have been fetchable
 * by anyone who guessed the URL, login or no login. Reading them from a
 * directory outside the web root and gating on the session is what actually
 * makes "only logged-in users can access it" true for the images too.
 */
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";

/** Repo-root data/images — outside apps/web/public on purpose. */
const ROOT = path.resolve(process.cwd(), "../../data/images");

const CONTENT_TYPE: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
};

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ path: string[] }> },
) {
  const cookieStore = await cookies();
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      cookies: {
        getAll: () => cookieStore.getAll(),
        setAll: () => {
          // Read-only route; nothing to write back.
        },
      },
    },
  );

  const { data } = await supabase.auth.getUser();
  if (!data.user) {
    return NextResponse.json({ error: "not signed in" }, { status: 401 });
  }

  const segments = (await params).path;
  // Resolve, then confirm the result is still inside ROOT — this is what stops
  // `../../.env.local` from being served.
  const file = path.resolve(ROOT, ...segments);
  if (!file.startsWith(ROOT + path.sep)) {
    return NextResponse.json({ error: "bad path" }, { status: 400 });
  }

  const type = CONTENT_TYPE[path.extname(file).toLowerCase()];
  if (!type) return NextResponse.json({ error: "unsupported type" }, { status: 400 });

  let size: number;
  try {
    const info = await stat(file);
    if (!info.isFile()) throw new Error("not a file");
    size = info.size;
  } catch {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  return new NextResponse(Readable.toWeb(createReadStream(file)) as ReadableStream, {
    headers: {
      "Content-Type": type,
      "Content-Length": String(size),
      // Private: cacheable by the one browser that fetched it, never by a proxy.
      "Cache-Control": "private, max-age=3600",
    },
  });
}
