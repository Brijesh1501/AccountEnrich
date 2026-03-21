// AccountIQ — Supabase Edge Function (Groq + Web Search)
// File: supabase/functions/enrich/index.ts
// Deploy:  supabase functions deploy enrich --no-verify-jwt
// Secrets: supabase secrets set GROQ_API_KEY=gsk_...
//          supabase secrets set SERPER_API_KEY=...

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// ── FIX 1: Rate limiting moved to DB (see SQL below).
// In-memory map removed — it reset on every cold start and provided zero real protection.
// SQL to add to your Supabase project:
//
//   create table public.rate_limits (
//     user_id uuid references auth.users primary key,
//     count integer default 0,
//     reset_at timestamptz default now() + interval '1 hour'
//   );
//   alter table public.rate_limits enable row level security;
//   create policy "rate_limits_own" on public.rate_limits
//     for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
//
// The checkRateLimit function below uses this table instead of in-memory state.

const RATE_LIMIT = 100;

async function checkRateLimit(
  supabase: ReturnType<typeof createClient>,
  userId: string
): Promise<{ allowed: boolean; remaining: number }> {
  const now = new Date().toISOString();

  // Fetch existing record
  const { data } = await supabase
    .from("rate_limits")
    .select("count, reset_at")
    .eq("user_id", userId)
    .single();

  // If no record or window expired, reset
  if (!data || new Date(data.reset_at) < new Date()) {
    await supabase.from("rate_limits").upsert({
      user_id: userId,
      count: 1,
      reset_at: new Date(Date.now() + 3_600_000).toISOString(),
    });
    return { allowed: true, remaining: RATE_LIMIT - 1 };
  }

  if (data.count >= RATE_LIMIT) {
    return { allowed: false, remaining: 0 };
  }

  await supabase
    .from("rate_limits")
    .update({ count: data.count + 1 })
    .eq("user_id", userId);

  return { allowed: true, remaining: RATE_LIMIT - data.count - 1 };
}

// ── FIX 6: LinkedIn scrape removed entirely.
// It always returned a 999/CAPTCHA response from LinkedIn, added 2–5s of wasted
// latency to every enrichment, and never produced usable data. The Groq model
// already has good knowledge of most companies from training data + Serper results.

// ── Step 1: Search for LinkedIn URL via Serper ──────────────
async function findLinkedInUrl(
  companyName: string,
  _website: string,
  serperKey: string
): Promise<string> {
  try {
    const query = `${companyName} site:linkedin.com/company`;
    const res = await fetch("https://google.serper.dev/search", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-KEY": serperKey },
      body: JSON.stringify({ q: query, num: 5 }),
    });
    if (!res.ok) {
      console.log("Serper LinkedIn search failed:", res.status);
      return "";
    }
    const data = await res.json();
    for (const item of data?.organic || []) {
      const link: string = item.link || "";
      if (link.includes("linkedin.com/company/")) {
        const match = link.match(
          /(https:\/\/[a-z]+\.linkedin\.com\/company\/[a-zA-Z0-9_-]+)/
        );
        if (match) return match[1];
      }
    }
    const kg = data?.knowledgeGraph;
    if (kg?.website?.includes("linkedin.com/company/")) return kg.website;
    return "";
  } catch (e) {
    console.error("Serper search error:", e);
    return "";
  }
}

// ── Step 2: Search for extra company info ───────────────────
async function searchCompanyInfo(
  companyName: string,
  website: string,
  serperKey: string
): Promise<string> {
  try {
    const query = `${companyName} ${website} company headquarters employees revenue`;
    const res = await fetch("https://google.serper.dev/search", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-KEY": serperKey },
      body: JSON.stringify({ q: query, num: 5 }),
    });
    if (!res.ok) return "";
    const data = await res.json();
    const snippets: string[] = [];
    const kg = data?.knowledgeGraph;
    if (kg?.description) snippets.push("About: " + kg.description);
    if (kg?.attributes) {
      for (const [k, v] of Object.entries(kg.attributes)) {
        snippets.push(`${k}: ${v}`);
      }
    }
    for (const item of (data?.organic || []).slice(0, 4)) {
      if (item.snippet) snippets.push(item.snippet);
    }
    if (data?.answerBox?.answer) snippets.push(data.answerBox.answer);
    if (data?.answerBox?.snippet) snippets.push(data.answerBox.snippet);
    return snippets.join("\n").slice(0, 2000);
  } catch (e) {
    console.error("Company search error:", e);
    return "";
  }
}

// ── FIX 1: Groq caller with retry + timeout ─────────────────
// Retries up to MAX_RETRIES times on 429 (rate limit) with exponential backoff.
// Uses AbortController to enforce a hard GROQ_TIMEOUT_MS deadline so the edge
// function never hangs until Supabase's 30s limit kills it.

const GROQ_TIMEOUT_MS = 20_000; // 20 seconds
const MAX_RETRIES = 2;
const RETRY_BASE_DELAY_MS = 1_200; // 1.2s, doubles each retry

async function callGroqWithRetry(
  groqKey: string,
  payload: object
): Promise<Response> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    // Abort controller enforces timeout on each individual attempt
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), GROQ_TIMEOUT_MS);

    try {
      const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${groqKey}`,
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      clearTimeout(timer);

      // 429 = rate limited — wait and retry
      if (res.status === 429 && attempt < MAX_RETRIES) {
        // Honour Retry-After header if present, otherwise use backoff
        const retryAfter = res.headers.get("Retry-After");
        const delayMs = retryAfter
          ? parseInt(retryAfter, 10) * 1000
          : RETRY_BASE_DELAY_MS * Math.pow(2, attempt);
        console.log(`Groq 429 — retrying in ${delayMs}ms (attempt ${attempt + 1})`);
        await new Promise((r) => setTimeout(r, delayMs));
        continue;
      }

      // 503 / 502 from Groq — retry once
      if ((res.status === 503 || res.status === 502) && attempt < MAX_RETRIES) {
        const delayMs = RETRY_BASE_DELAY_MS * Math.pow(2, attempt);
        console.log(`Groq ${res.status} — retrying in ${delayMs}ms`);
        await new Promise((r) => setTimeout(r, delayMs));
        continue;
      }

      return res;
    } catch (err) {
      clearTimeout(timer);
      lastError = err as Error;

      if ((err as Error).name === "AbortError") {
        console.error(`Groq request timed out after ${GROQ_TIMEOUT_MS}ms (attempt ${attempt + 1})`);
        if (attempt < MAX_RETRIES) {
          await new Promise((r) => setTimeout(r, RETRY_BASE_DELAY_MS));
          continue;
        }
        throw new Error("AI service timed out. Please try again.");
      }

      // Network error — retry
      if (attempt < MAX_RETRIES) {
        await new Promise((r) => setTimeout(r, RETRY_BASE_DELAY_MS));
        continue;
      }
    }
  }

  throw lastError ?? new Error("AI service unavailable after retries.");
}

const SYSTEM_PROMPT = `You are an expert B2B account research analyst. Given a company website and research data, return a comprehensive JSON profile. Use the provided real data (LinkedIn, web search) — only fall back to inference when data is missing.

════════════════════════════════════════════
ACCOUNT TYPE — Use exactly ONE
════════════════════════════════════════════
ENTERPRISE: 1000+ employees OR smaller org (~45+) with multiple business lines. ROI mainly from OFFLINE channels (stores, distributors, direct sales). Sells own products via website = Enterprise (not Consumer Portal). Examples: tejasnetworks.com, wforwoman.com, wildcraft.com
ISV: Owns its own software product/platform. Revenue via subscriptions/licensing. INDEPENDENT (not acquired). Core = software product NOT services. Examples: Freshworks, Zoho, Postman
CONSUMER PORTAL: Marketplace connecting buyers and sellers. Revenue from transactions/commissions/ads. If only sells own products → Enterprise. Examples: Amazon, MakeMyTrip, TripJack (OTA marketplace)
AGENCY/SERVICE COMPANY: Provides IT SERVICES only (consulting, app dev, web dev). No proprietary software. Non-IT service → Enterprise.
PE/VC FIRMS: Invests capital only. No products/services.

════════════════════════════════════════════
BUSINESS TYPE
════════════════════════════════════════════
B2B | B2C | B2B and B2C

════════════════════════════════════════════
ACCOUNT SIZE
════════════════════════════════════════════
StartUp (<50) | Small (50-200) | Medium (200-500) | Large (500-1000) | X-Large (1000-5000) | XX-Large (5000+)
Use LinkedIn employee count if provided — it is the most accurate signal.

════════════════════════════════════════════
INDUSTRIES & SUB-INDUSTRIES
════════════════════════════════════════════
Media & Entertainment → Broadcasters | Studios & Content Owners | OTT Platforms | Content Syndicators & Distributors | Publishing | General Entertainment Content | News | Gaming | Radio & Music | Cookery Media
Financial Services → Retail & Commercial Banking | Investment Management | Insurance | Wealth Management | Payments | NBFC / Lending | Accounting | Others (Fintech & Capital Markets)
Healthcare & Life Sciences → Pharmaceuticals | Healthcare Providers | Health Wellness & Fitness | Medical Devices
Travel & Hospitality → Air Travel | Aerospace | Hotels | OTA (Online Travel Agencies)
Business Software / Internet (SaaS) → AdTech & MarTech | ERP & Procurement Platforms | AI Platforms & Chatbots | HRMS & Workforce Management | Data Management & Analytics | Cybersecurity Platforms | Other B2B SaaS
Sports → Leagues | Clubs & Teams | Sports Federations
Wagering → Gambling Facilities & Casinos | Operators | iGaming | Lotteries | Platform Providers
Retail → E-Commerce
Agriculture Resources & Utilities → Oil & Energy | Mining | Power & Utilities | Agriculture & AgriTech
Business Services → IT Services & Consulting | BPM / BPO Companies | Marketing & Advertising | Tax Audit & Legal Services | Translation & Localization
Government & Public Sector → Government & Public Sector | Telecom → Telecom | Industrial & Manufacturing → Industrial & Manufacturing
Automobile → Automobile | Food & Beverage → Food & Beverage | FMCG & CPG → FMCG & CPG | Real Estate → Real Estate
PE / VC Firms → PE / VC Firms | Animation & Gaming → Animation & Gaming | Internet (Digital Platforms) → Internet (Digital Platforms)

════════════════════════════════════════════
REGIONS
════════════════════════════════════════════
North America | EMEA | APAC | LATAM | India

════════════════════════════════════════════
CLOUD PLATFORM
════════════════════════════════════════════
Single: AWS | Azure | GCP | Oracle Cloud | IBM Cloud | Alibaba Cloud | DigitalOcean | Cloudflare | Vercel | Netlify | Heroku | On-premise
Multi-cloud: Multi-cloud (AWS, GCP) pattern — list specific platforms
Infer: Indian startups → AWS/GCP | Travel portals → AWS | Microsoft-stack → Azure

════════════════════════════════════════════
ENGINEERING & DEVOPS FIELD FORMAT
════════════════════════════════════════════
Both engineeringIT and devOps fields must include team size in this format:
  engineeringIT: "[Tech Stack] | Team Size: [number or range]"
  devOps:        "[Tools & Practices] | Team Size: [number or range]"

Engineering team size from total employees:
- Pure tech/SaaS: 50-70% | Travel/e-commerce: 20-40% | IT services: 60-80% | FMCG/Retail: 5-15%
DevOps team size from engineering team:
- Modern SaaS/cloud-native: 10-20% of engineering | Enterprise: 5-10% of engineering

════════════════════════════════════════════
INFERENCE RULES (when real data is missing)
════════════════════════════════════════════
- Location: .in domain = India. Infer city from company type (travel/fintech → Gurugram or Bangalore)
- State from city: Bangalore=Karnataka, Mumbai=Maharashtra, Gurugram=Haryana, Hyderabad=Telangana
- Timezone: India=IST/UTC+5:30, UK=GMT/UTC+0, UAE=GST/UTC+4, Singapore=SGT/UTC+8, US West=PST/UTC-8, US East=EST/UTC-5
- LinkedIn URL: construct as https://www.linkedin.com/company/[company-name-slug] if not provided
- Engineering: travel portals=React/Node.js/Python/Java | fintech=Java/Python/Go | SaaS=React/Node.js
- DevOps: modern startup=GitHub Actions+Docker+Kubernetes | enterprise=Jenkins+Terraform+Kubernetes
- Revenue: use web search data if available, else estimate from company stage

════════════════════════════════════════════
OUTPUT — all 20 keys required
════════════════════════════════════════════
Return ONLY valid JSON:
{
  "accountName": "Official company name",
  "website": "The company domain e.g. tripjack.com.",
  "draInsights": "2-3 sentences: what company does, business model, key products/services, market position",
  "engineeringIT": "[Tech Stack] | Team Size: [number or range]",
  "cloudPlatform": "Cloud platform — single name or Multi-cloud (X, Y) pattern",
  "devOps": "[Tools & Practices] | Team Size: [number or range]",
  "employeeCount": "Use LinkedIn employee count/range if available, else estimate",
  "accountTypeBySize": "One of: StartUp (<50) | Small (50-200) | Medium (200-500) | Large (500-1000) | X-Large (1000-5000) | XX-Large (5000+)",
  "accountType": "One of: Enterprise | ISV | Consumer Portal | Agency/Service Company | PE/VC Firms",
  "accountTypeReason": "1-2 sentences explaining WHY with specific evidence",
  "accountLinkedIn": "Real LinkedIn URL from search if found, else constructed URL",
  "businessType": "One of: B2B | B2C | B2B and B2C",
  "industry": "Exactly one industry from taxonomy",
  "subIndustry": "Exactly one matching sub-industry",
  "revenueUSD": "From web search if available, else estimate in USD millions",
  "billingCity": "From LinkedIn/search if found, else infer",
  "billingState": "Derived from city",
  "billingCountry": "From LinkedIn/search or infer from domain TLD",
  "region": "One of: North America | EMEA | APAC | LATAM | India",
  "timeZone": "Derived from country/city e.g. IST / UTC+5:30"
}`;

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  }

  try {
    // ── 1. Verify JWT ───────────────────────────────────────
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return new Response(JSON.stringify({ error: "Missing authorization header" }), {
        status: 401,
        headers: { ...CORS, "Content-Type": "application/json" },
      });
    }
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();
    if (authError || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized — please log in" }), {
        status: 401,
        headers: { ...CORS, "Content-Type": "application/json" },
      });
    }

    // ── 2. Rate limit (DB-backed) ───────────────────────────
    const { allowed, remaining } = await checkRateLimit(supabase, user.id);
    if (!allowed) {
      return new Response(
        JSON.stringify({ error: "Rate limit exceeded. Max 100 enrichments per hour." }),
        { status: 429, headers: { ...CORS, "Content-Type": "application/json" } }
      );
    }

    // ── 3. Parse request ────────────────────────────────────
    const body = await req.json();
    const website: string = body?.website?.trim();
    if (!website) {
      return new Response(JSON.stringify({ error: "website field is required" }), {
        status: 400,
        headers: { ...CORS, "Content-Type": "application/json" },
      });
    }

    const groqKey = Deno.env.get("GROQ_API_KEY");
    const serperKey = Deno.env.get("SERPER_API_KEY");

    if (!groqKey) {
      return new Response(
        JSON.stringify({ error: "API key not configured. Contact your admin." }),
        { status: 500, headers: { ...CORS, "Content-Type": "application/json" } }
      );
    }

    // ── 4. Extract company name from website ────────────────
    const companyName = website
      .replace(/^https?:\/\//, "")
      .replace(/^www\./, "")
      .split(".")[0]
      .replace(/-/g, " ")
      .trim();

    // ── 5. Web search (Serper) ──────────────────────────────
    // LinkedIn scrape removed — always returned 999/CAPTCHA, added 2–5s latency.
    let linkedInUrl = "";
    let webSearchContext = "";

    if (serperKey) {
      console.log("Running web search for:", website);
      try {
        const [liUrl, webCtx] = await Promise.all([
          findLinkedInUrl(companyName, website, serperKey),
          searchCompanyInfo(companyName, website, serperKey),
        ]);
        linkedInUrl = liUrl;
        webSearchContext = webCtx;
        console.log("LinkedIn URL found:", linkedInUrl || "none");
        console.log("Web context length:", webSearchContext.length);
      } catch (searchErr) {
        console.log("Web search failed — using Groq knowledge only:", searchErr);
      }
    } else {
      console.log("No Serper key configured — using Groq knowledge only");
    }

    // ── 6. Build research context ───────────────────────────
    const researchContext = [
      linkedInUrl ? `LinkedIn URL: ${linkedInUrl}` : "",
      webSearchContext ? `\nWeb Search Results:\n${webSearchContext}` : "",
    ]
      .filter(Boolean)
      .join("\n");

    // ── 7. Call Groq (with retry + timeout) ─────────────────
    const looksLikeDomain = website.includes(".");
    const userMessage = `Research this company and return the complete 20-field JSON profile.

${
  looksLikeDomain
    ? `Website: ${website}`
    : `Company Name: ${website}\nNote: User typed the company name directly. Find the website domain yourself and use it in the website field.`
}
Company Name (extracted): ${companyName}

${
  researchContext
    ? `=== REAL DATA FROM WEB RESEARCH ===\n${researchContext}\n\nUse the above real data to fill fields accurately.`
    : "No web search data available — use your full training knowledge to fill all fields. Make confident inferences based on company type, domain TLD, and industry context."
}

Important:
- The "website" field MUST be exactly: ${website}
- If LinkedIn URL was found above, use it exactly as provided
- For Indian companies: region=India, timezone=IST/UTC+5:30
- Always include devOps field with tools AND team size estimate`;

    let groqRes: Response;
    try {
      groqRes = await callGroqWithRetry(groqKey, {
        model: "llama-3.3-70b-versatile",
        temperature: 0.1,
        max_tokens: 1500,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userMessage },
        ],
      });
    } catch (retryErr) {
      console.error("Groq error after retries:", retryErr);
      return new Response(
        JSON.stringify({
          error:
            retryErr instanceof Error
              ? retryErr.message
              : "AI service error. Please try again.",
        }),
        { status: 502, headers: { ...CORS, "Content-Type": "application/json" } }
      );
    }

    if (!groqRes.ok) {
      const errText = await groqRes.text();
      console.error("Groq non-OK response:", groqRes.status, errText);
      return new Response(
        JSON.stringify({ error: "AI service error. Please try again." }),
        { status: 502, headers: { ...CORS, "Content-Type": "application/json" } }
      );
    }

    const groqData = await groqRes.json();
    let rawText = groqData?.choices?.[0]?.message?.content || "";

    if (!rawText) {
      return new Response(
        JSON.stringify({ error: "Empty AI response. Please try again." }),
        { status: 502, headers: { ...CORS, "Content-Type": "application/json" } }
      );
    }

    // ── 8. Parse JSON ───────────────────────────────────────
    const jsonMatch = rawText.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) rawText = jsonMatch[1];
    else {
      const start = rawText.indexOf("{");
      const end = rawText.lastIndexOf("}");
      if (start !== -1 && end !== -1) rawText = rawText.slice(start, end + 1);
    }

    let enriched: Record<string, string>;
    try {
      enriched = JSON.parse(rawText.trim());
    } catch {
      console.error("JSON parse error. Raw:", rawText);
      return new Response(
        JSON.stringify({ error: "Failed to parse AI response. Please try again." }),
        { status: 502, headers: { ...CORS, "Content-Type": "application/json" } }
      );
    }

    // ── 9. Override with real LinkedIn URL and force website ─
    if (linkedInUrl && linkedInUrl.includes("linkedin.com/company/")) {
      enriched.accountLinkedIn = linkedInUrl;
    }
    enriched.website = website;

    // ── 10. Return ──────────────────────────────────────────
    return new Response(JSON.stringify({ data: enriched, remaining }), {
      status: 200,
      headers: {
        ...CORS,
        "Content-Type": "application/json",
        "X-RateLimit-Remaining": String(remaining),
      },
    });
  } catch (err) {
    console.error("Edge function error:", err);
    return new Response(JSON.stringify({ error: "Internal server error" }), {
      status: 500,
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
});