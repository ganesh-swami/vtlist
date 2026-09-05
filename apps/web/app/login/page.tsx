"use client";

/**
 * Sign-in. The only page reachable without a session.
 *
 * Accounts are provisioned by an operator (`create-user.ts`); there is no
 * sign-up link, because this data should not be self-serve.
 */
import { useState } from "react";
import { createClient } from "@/utils/supabase/client";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);

    const supabase = createClient();
    const { error: authError } = await supabase.auth.signInWithPassword({ email, password });

    if (authError) {
      setError(
        authError.message === "Invalid login credentials"
          ? "ईमेल या पासवर्ड ग़लत है — email or password is incorrect."
          : authError.message,
      );
      setBusy(false);
      return;
    }

    // A full navigation, not a client-side push: the proxy has to see the new
    // session cookie, and it only runs on a real request.
    const next = new URLSearchParams(window.location.search).get("next");
    window.location.assign(next && next.startsWith("/") ? next : "/");
  }

  return (
    <main className="flex min-h-svh items-center justify-center px-4">
      <form onSubmit={onSubmit} className="bg-card w-full max-w-sm rounded-lg border p-6 shadow-sm">
        <h1 className="text-xl font-semibold tracking-tight">मतदाता खोज</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          बीकानेर नगर निगम · वार्ड 1
          <span className="mx-1.5 opacity-40">·</span>
          sign in to continue
        </p>

        <label className="mt-5 block text-sm font-medium" htmlFor="email">
          ईमेल
        </label>
        <input
          id="email"
          type="email"
          autoComplete="username"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="border-input bg-background focus-visible:ring-ring mt-1 w-full rounded-md border px-3 py-2 text-sm outline-none focus-visible:ring-2"
        />

        <label className="mt-3 block text-sm font-medium" htmlFor="password">
          पासवर्ड
        </label>
        <input
          id="password"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="border-input bg-background focus-visible:ring-ring mt-1 w-full rounded-md border px-3 py-2 text-sm outline-none focus-visible:ring-2"
        />

        {error && (
          <p className="mt-3 rounded-md border border-red-300 bg-red-50 p-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200">
            {error}
          </p>
        )}

        <button
          type="submit"
          disabled={busy}
          className="bg-primary text-primary-foreground mt-5 w-full rounded-md px-3 py-2 text-sm font-medium disabled:opacity-60"
        >
          {busy ? "साइन इन हो रहे हैं…" : "साइन इन"}
        </button>

        <p className="text-muted-foreground mt-4 text-xs">
          यह सूची निजी है। पहुँच के लिए व्यवस्थापक से संपर्क करें.
          <br />
          Access is granted by the administrator; there is no public sign-up.
        </p>
      </form>
    </main>
  );
}
