// AccountIQ — Credits Edge Function
// File: supabase/functions/credits/index.ts
// Deploy:  supabase functions deploy credits --no-verify-jwt
// Returns live Serper remaining credits and Groq rate-limit quota for admin dashboard.

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
    // ── 1. Auth: must be a logged-in admin ─────────────────
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return new Response(JSON.stringify({ error: "Missing authorization" }), {
        status: 401, headers: { ...CORS, "Content-Type": "application/json" },
      });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const anonKey    = Deno.env.get("SUPABASE_ANON_KEY")!;

    const callerClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: authErr } = await callerClient.auth.getUser();
    if (authErr || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401, headers: { ...CORS, "Content-Type": "application/json" },
      });
    }

    const { data: profile } = await callerClient
      .from("profiles").select("role").eq("id", user.id).single();
    if (profile?.role !== "admin") {
      return new Response(JSON.stringify({ error: "Admin access required" }), {
        status: 403, headers: { ...CORS, "Content-Type": "application/json" },
      });
    }

    const groqKey   = Deno.env.get("GROQ_API_KEY");
    const serperKey = Deno.env.get("SERPER_API_KEY");

    // ── 2. Serper credits ───────────────────────────────────
    // GET /account returns:
    //   { "email":"...", "credits":2450, "creditsLimit":2500, "plan":"Starter" }
    // IMPORTANT: "credits" field = REMAINING credits, not used.
    let serper: Record<string, unknown> = { configured: false };

    if (serperKey) {
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 8_000);
        const res = await fetch("https://google.serper.dev/account", {
          method: "GET",
          headers: { "X-API-KEY": serperKey },
          signal: ctrl.signal,
        });
        clearTimeout(t);

        if (res.ok) {
          const data = await res.json();
          const creditsRemaining = data.credits ?? null;
          const creditsLimit     = data.creditsLimit ?? null;
          const creditsUsed      = (creditsLimit != null && creditsRemaining != null)
            ? creditsLimit - creditsRemaining : null;
          serper = {
            configured: true,
            creditsRemaining,
            creditsUsed,
            creditsLimit,
            plan:  data.plan  ?? null,
            email: data.email ?? null,
          };
        } else {
          const body = await res.text();
          serper = { configured: true, error: `HTTP ${res.status}: ${body.slice(0, 120)}` };
        }
      } catch (e) {
        serper = {
          configured: true,
          error: (e as Error).name === "AbortError" ? "Request timed out" : "Request failed",
        };
      }
    }

    // ── 3. Groq rate limits ─────────────────────────────────
    // /models does NOT return rate-limit headers — only actual API calls do.
    // We make a minimal completion (max_tokens:1, ~0 cost) to get live quota.
    let groq: Record<string, unknown> = { configured: false };

    if (groqKey) {
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 12_000);
        const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${groqKey}`,
          },
          body: JSON.stringify({
            model: "llama-3.3-70b-versatile",
            max_tokens: 1,
            temperature: 0,
            messages: [{ role: "user", content: "hi" }],
          }),
          signal: ctrl.signal,
        });
        clearTimeout(t);

        // Rate-limit headers are present on all responses including 429
        const limitReq        = res.headers.get("x-ratelimit-limit-requests");
        const remainingReq    = res.headers.get("x-ratelimit-remaining-requests");
        const limitTokens     = res.headers.get("x-ratelimit-limit-tokens");
        const remainingTokens = res.headers.get("x-ratelimit-remaining-tokens");
        const resetReq        = res.headers.get("x-ratelimit-reset-requests");
        const resetTokens     = res.headers.get("x-ratelimit-reset-tokens");

        if (res.ok || res.status === 429) {
          groq = {
            configured:        true,
            status:            res.status === 429 ? "rate_limited" : "connected",
            requestLimit:      limitReq        ? parseInt(limitReq)        : null,
            requestsRemaining: remainingReq    ? parseInt(remainingReq)    : null,
            tokenLimit:        limitTokens     ? parseInt(limitTokens)     : null,
            tokensRemaining:   remainingTokens ? parseInt(remainingTokens) : null,
            resetsRequestsIn:  resetReq    ?? null,
            resetsTokensIn:    resetTokens ?? null,
          };
        } else {
          const errData = await res.json().catch(() => ({}));
          groq = {
            configured:        true,
            status:            "error",
            error:             errData?.error?.message || `HTTP ${res.status}`,
            requestLimit:      limitReq        ? parseInt(limitReq)        : null,
            requestsRemaining: remainingReq    ? parseInt(remainingReq)    : null,
            tokenLimit:        limitTokens     ? parseInt(limitTokens)     : null,
            tokensRemaining:   remainingTokens ? parseInt(remainingTokens) : null,
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