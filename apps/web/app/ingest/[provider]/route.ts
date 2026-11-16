import { hub } from "@/lib/server/hub";

const PROVIDERS = ["claude", "opencode"] as const;

/** Agents post their hook events here. Always answers with an empty body. */
export async function POST(request: Request, ctx: { params: Promise<{ provider: string }> }) {
  const { provider } = await ctx.params;
  if (!(PROVIDERS as readonly string[]).includes(provider)) return new Response(null, { status: 404 });
  return hub().ingest(provider as (typeof PROVIDERS)[number], request);
}
