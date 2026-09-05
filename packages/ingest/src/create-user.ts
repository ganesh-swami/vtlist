#!/usr/bin/env node
/**
 * Create (or reset the password of) a site login.
 *
 *   node packages/ingest/src/create-user.ts <email> <password>
 *
 * Uses the service-role key, which is the only credential allowed to mint
 * users. The account is created already-confirmed so there is no verification
 * email to chase — this is an operator provisioning a known person, not a
 * public sign-up, and public sign-ups are disabled on the project.
 */
import { createClient } from "@supabase/supabase-js";

const [email, password] = process.argv.slice(2);
if (!email || !password) {
  throw new Error("usage: create-user <email> <password>");
}

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) throw new Error("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set");

const admin = createClient(url, key, { auth: { persistSession: false } });

const { data: existing } = await admin.auth.admin.listUsers({ perPage: 1000 });
const found = existing?.users.find((u) => u.email?.toLowerCase() === email.toLowerCase());

if (found) {
  const { error } = await admin.auth.admin.updateUserById(found.id, {
    password,
    email_confirm: true,
  });
  if (error) throw new Error(`updating ${email}: ${error.message}`);
  console.log(`${email} already existed — password reset. id ${found.id}`);
} else {
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    app_metadata: { role: "admin" },
  });
  if (error) throw new Error(`creating ${email}: ${error.message}`);
  console.log(`created ${email}. id ${data.user?.id}`);
}

const { data: all } = await admin.auth.admin.listUsers({ perPage: 1000 });
console.log(`\n${all?.users.length ?? 0} account(s) can sign in:`);
for (const u of all?.users ?? []) {
  console.log(`  ${u.email}  ${u.email_confirmed_at ? "confirmed" : "UNCONFIRMED"}`);
}
