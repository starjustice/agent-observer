import { connection } from "next/server";
import { hub } from "@/lib/server/hub";

/** Vercel Cron calls this once a day with `Authorization: Bearer $CRON_SECRET`. */
export async function GET(request: Request) {
  await connection();
  return hub().cleanup(request);
}
