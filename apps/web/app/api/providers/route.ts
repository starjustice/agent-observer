import { connection } from "next/server";
import { hub } from "@/lib/server/hub";

export async function GET(request: Request) {
  await connection();
  return hub().providers(request);
}
