import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "./database.types";

let cachedClient: SupabaseClient<Database> | null = null;

export function getSupabaseAdmin() {
  const url = process.env.SUPABASE_URL ?? "";
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

  if (!url || !serviceRoleKey) {
    return null;
  }

  if (!cachedClient) {
    cachedClient = createClient<Database>(url, serviceRoleKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    });
  }

  return cachedClient;
}

export function getSupabaseConfigStatus() {
  return {
    hasUrl: Boolean(process.env.SUPABASE_URL),
    hasServiceRoleKey: Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY),
  };
}
