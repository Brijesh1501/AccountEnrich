// AccountIQ — Credits Edge Function
// File: supabase/functions/credits/index.ts
// Deploy:  supabase functions deploy credits --no-verify-jwt
// Returns Serper remaining credits and Groq connectivity/model info for admin dashboard.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }

  try {
    // ── 1. Verify caller is authenticated ──────────────────
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return new Response(JSON.stringify({ error: "Missing authorization" }), {
        status: 401, headers: { ...CORS, "Content-Type": "application/json" },
      });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;

    const callerClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });

    const { data: { user }, error: authErr } = await callerClient.auth.getUser();
    if (authErr || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401, headers: { ...CORS, "Content-Type": "application/json" },
      });
    }

    // ── 2. Verify caller is admin ───────────────────────────
    const { data: profile } = await callerClient
      .from("profiles")
      .select("role")
      .eq("id", user.id)
      .single();

    if (profile?.role !== "admin") {
      return new Response(JSON.stringify({ error: "Admin access required" }), {
        status: 403, headers: { ...CORS, "Content-Type": "application/json" },
      });
    }

    const groqKey = Deno.env.get("GROQ_API_KEY");
    const serperKey = Deno.env.get("SERPER_API_KEY");

    // ── 3. Fetch Serper credits ─────────────────────────────
    // Serper /account endpoint returns creditsUsed and creditsLimit.
    let serper: Record<string, unknown> = { configured: false };
    if (serperKey) {
      try {
        const res = await fetch("https://google.serper.dev/account", {
          method: "GET",
          headers: { "X-API-KEY": serperKey },
        });
        if (res.ok) {
          const data = await res.json();
          serper = {
            configured: true,
            creditsUsed: data.credits ?? data.creditsUsed ?? null,
            creditsLimit: data.creditsLimit ?? null,
            creditsRemaining:
              data.creditsLimit != null && data.credits != null
                ? data.creditsLimit - data.credits
                : (data.creditsRemaining ?? null),
            plan: data.plan ?? null,
          };
        } else {
          serper = { configured: true, error: `API returned ${res.status}` };
        }
      } catch (e) {
        serper = { configured: true, error: "Request failed" };
      }
    }

    // ── 4. Fetch Groq info ──────────────────────────────────
    // Groq does not expose a public credits/quota endpoint.
    // We call /openai/v1/models which is lightweight and returns
    // rate-limit headers (x-ratelimit-limit-requests, etc.) that
    // tell us the quota tier. We also return the available models list.
    let groq: Record<string, unknown> = { configured: false };
    if (groqKey) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 8_000);
        const res = await fetch("https://api.groq.com/openai/v1/models", {
          method: "GET",
          headers: { Authorization: `Bearer ${groqKey}` },
          signal: controller.signal,
        });
        clearTimeout(timer);

        // Extract rate limit headers Groq sends back
        const limitReq = res.headers.get("x-ratelimit-limit-requests");
        const remainingReq = res.headers.get("x-ratelimit-remaining-requests");
        const limitTokens = res.headers.get("x-ratelimit-limit-tokens");
        const remainingTokens = res.headers.get("x-ratelimit-remaining-tokens");
        const resetReq = res.headers.get("x-ratelimit-reset-requests");

        if (res.ok) {
          const data = await res.json();
          const modelIds: string[] = (data?.data || [])
            .map((m: { id: string }) => m.id)
            .filter((id: string) => id.includes("llama") || id.includes("mixtral") || id.includes("gemma"));

          groq = {
            configured: true,
            status: "connected",
            requestLimit: limitReq ? parseInt(limitReq) : null,
            requestsRemaining: remainingReq ? parseInt(remainingReq) : null,
            tokenLimit: limitTokens ? parseInt(limitTokens) : null,
            tokensRemaining: remainingTokens ? parseInt(remainingTokens) : null,
            resetsAt: resetReq ?? null,
            availableModels: modelIds,
          };
        } else {
          const errData = await res.json().catch(() => ({}));
          groq = {
            configured: true,
            status: "error",
            error: errData?.error?.message || `API returned ${res.status}`,
            requestLimit: limitReq ? parseInt(limitReq) : null,
            requestsRemaining: remainingReq ? parseInt(remainingReq) : null,
          };
        }
      } catch (e) {
        groq = {
          configured: true,
          status: "error",
          error: (e as Error).name === "AbortError" ? "Request timed out" : "Request failed",
        };
      }
    }

    return new Response(JSON.stringify({ serper, groq }), {
      status: 200,
      headers: { ...CORS, "Content-Type": "application/json" },
    });

  } catch (err) {
    console.error("credits function error:", err);
    return new Response(JSON.stringify({ error: "Internal server error" }), {
      status: 500, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
});