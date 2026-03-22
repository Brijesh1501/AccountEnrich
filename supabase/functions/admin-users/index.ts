// AccountIQ — Admin Users Edge Function
// File: supabase/functions/admin-users/index.ts
// Deploy:  supabase functions deploy admin-users --no-verify-jwt

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// Allowed actions — any value not in this set is rejected immediately.
// Adding a new action requires it to be listed here first.
const ALLOWED_ACTIONS = new Set(["create", "update", "delete"]);

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  }

  try {
    // ── 1. Verify caller is authenticated ──────────────────
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return new Response(JSON.stringify({ error: "Missing authorization" }), {
        status: 401,
        headers: { ...CORS, "Content-Type": "application/json" },
      });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    const callerClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const {
      data: { user: caller },
      error: authErr,
    } = await callerClient.auth.getUser();
    if (authErr || !caller) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...CORS, "Content-Type": "application/json" },
      });
    }

    // ── 2. Verify caller is admin ───────────────────────────
    const { data: callerProfile } = await callerClient
      .from("profiles")
      .select("role")
      .eq("id", caller.id)
      .single();

    if (callerProfile?.role !== "admin") {
      return new Response(JSON.stringify({ error: "Admin access required" }), {
        status: 403,
        headers: { ...CORS, "Content-Type": "application/json" },
      });
    }

    // ── 3. Admin client with service role ──────────────────
    const adminClient = createClient(supabaseUrl, serviceKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const body = await req.json();
    const { action } = body;

    // ── 4. Validate action against allowlist ───────────────
    // Rejects unknown actions before any logic runs, preventing accidental
    // code paths from being exploitable.
    if (!action || !ALLOWED_ACTIONS.has(action)) {
      return new Response(JSON.stringify({ error: "Unknown action" }), {
        status: 400,
        headers: { ...CORS, "Content-Type": "application/json" },
      });
    }

    // ── 5. CREATE USER ──────────────────────────────────────
    // FIX 4: If profile upsert fails after auth user is created, we now roll
    // back by deleting the auth user so there are no orphaned records.
    // Note: email_confirm: true intentionally skips email verification for
    // admin-created accounts. Users can change their password on first login.
    if (action === "create") {
      const { email, password, fullName, role } = body;
      if (!email || !password) {
        return new Response(JSON.stringify({ error: "Email and password required" }), {
          status: 400,
          headers: { ...CORS, "Content-Type": "application/json" },
        });
      }
      if (password.length < 8) {
        return new Response(
          JSON.stringify({ error: "Password must be at least 8 characters" }),
          { status: 400, headers: { ...CORS, "Content-Type": "application/json" } }
        );
      }

      // Step A: Create auth user
      const { data: newUser, error: createErr } =
        await adminClient.auth.admin.createUser({
          email,
          password,
          email_confirm: true,
          user_metadata: { full_name: fullName || "" },
        });

      if (createErr) {
        return new Response(JSON.stringify({ error: createErr.message }), {
          status: 400,
          headers: { ...CORS, "Content-Type": "application/json" },
        });
      }

      // Step B: Create profile — rollback auth user if this fails
      const { error: profileErr } = await adminClient.from("profiles").upsert({
        id: newUser.user.id,
        email,
        full_name: fullName || "",
        role: role || "user",
      });

      if (profileErr) {
        // Roll back: delete the auth user so no orphan is left behind
        console.error("Profile creation failed, rolling back auth user:", profileErr);
        await adminClient.auth.admin.deleteUser(newUser.user.id);
        return new Response(
          JSON.stringify({
            error: "Failed to create user profile. User was not created.",
          }),
          { status: 500, headers: { ...CORS, "Content-Type": "application/json" } }
        );
      }

      return new Response(
        JSON.stringify({
          success: true,
          user: {
            id: newUser.user.id,
            email,
            full_name: fullName || "",
            role: role || "user",
            created_at: newUser.user.created_at,
            last_sign_in_at: null,
          },
        }),
        { status: 200, headers: { ...CORS, "Content-Type": "application/json" } }
      );
    }

    // ── 6. UPDATE USER ──────────────────────────────────────
    if (action === "update") {
      const { userId, email, password, fullName, role } = body;
      if (!userId) {
        return new Response(JSON.stringify({ error: "userId required" }), {
          status: 400,
          headers: { ...CORS, "Content-Type": "application/json" },
        });
      }

      const authUpdate: Record<string, unknown> = {};
      if (email) authUpdate.email = email;
      if (password && password.length >= 8) authUpdate.password = password;
      if (fullName !== undefined) authUpdate.user_metadata = { full_name: fullName };

      // Map profile role → Supabase Auth ban state.
      // ban_duration="876600h" blocks new logins (~100 years = permanent).
      // ban_duration="none" lifts the ban so the user can log in again.
      const isSuspending = role === "suspended" || role === "banned";
      const isReactivating = role === "user" || role === "admin";
      if (isSuspending) authUpdate.ban_duration = "876600h";
      if (isReactivating) authUpdate.ban_duration = "none";

      if (Object.keys(authUpdate).length > 0) {
        const { error: updateErr } = await adminClient.auth.admin.updateUserById(
          userId,
          authUpdate
        );
        if (updateErr) {
          return new Response(JSON.stringify({ error: updateErr.message }), {
            status: 400,
            headers: { ...CORS, "Content-Type": "application/json" },
          });
        }
      }

      // Kill existing sessions immediately when suspending.
      // ban_duration blocks NEW logins but live JWT tokens stay valid
      // until expiry — signOut "global" revokes them right now.
      if (isSuspending) {
        await adminClient.auth.admin.signOut(userId, "global");
      }

      const profileUpdate: Record<string, unknown> = {};
      if (fullName !== undefined) profileUpdate.full_name = fullName;
      if (email) profileUpdate.email = email;
      if (role) profileUpdate.role = role;

      if (Object.keys(profileUpdate).length > 0) {
        await adminClient.from("profiles").update(profileUpdate).eq("id", userId);
      }

      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { ...CORS, "Content-Type": "application/json" },
      });
    }

    // ── 7. DELETE USER ──────────────────────────────────────
    // Deletion order: accounts → profile → auth user.
    // Each step is attempted independently. If the auth user deletion fails,
    // we return an error but the profile/accounts have already been cleaned up
    // (acceptable — a profileless user is invisible to the app).
    if (action === "delete") {
      const { userId } = body;
      if (!userId) {
        return new Response(JSON.stringify({ error: "userId required" }), {
          status: 400,
          headers: { ...CORS, "Content-Type": "application/json" },
        });
      }

      // Deletion order matters — must remove all FK-referencing rows before
      // deleting from auth.users, otherwise the auth deletion fails with a
      // foreign key violation and the email stays permanently blocked in Auth
      // even though the profile appears gone from the UI.
      //
      // Order: activity_logs → accounts → profiles → auth.users
      //
      // activity_logs references auth.users(id) without ON DELETE CASCADE,
      // so it must be deleted first. Even if CASCADE is later added to the DB,
      // explicit deletion here is safer and works regardless of migration state.

      // 1. Delete activity logs
      const { error: logErr } = await adminClient
        .from("activity_logs")
        .delete()
        .eq("user_id", userId);
      if (logErr) console.error("Error deleting activity_logs for user:", logErr);

      // 2. Delete accounts
      const { error: accErr } = await adminClient
        .from("accounts")
        .delete()
        .eq("user_id", userId);
      if (accErr) console.error("Error deleting accounts for user:", accErr);

      // 3. Delete profile
      const { error: profErr } = await adminClient
        .from("profiles")
        .delete()
        .eq("id", userId);
      if (profErr) console.error("Error deleting profile for user:", profErr);

      // 4. Delete from auth.users — this is now safe because all FK references
      //    have been removed above.
      const { error: delErr } = await adminClient.auth.admin.deleteUser(userId);
      if (delErr) {
        return new Response(JSON.stringify({ error: delErr.message }), {
          status: 400,
          headers: { ...CORS, "Content-Type": "application/json" },
        });
      }

      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { ...CORS, "Content-Type": "application/json" },
      });
    }

    // This line is unreachable due to the allowlist check above,
    // but kept as a safety net.
    return new Response(JSON.stringify({ error: "Unknown action" }), {
      status: 400,
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("admin-users error:", err);
    return new Response(JSON.stringify({ error: "Internal server error" }), {
      status: 500,
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
});