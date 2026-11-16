import { connection } from "next/server";
import { hub } from "@/lib/server/hub";

export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }) {
  await connection();
  const { id } = await ctx.params;
  return hub().agent(request, id);
}
