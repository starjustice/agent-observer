import { connection } from "next/server";
import { hub } from "@/lib/server/hub";

// SSE: the stream hands over to a new connection a little before this limit.
export const maxDuration = 300;

export async function GET(request: Request) {
  await connection();
  return hub().stream(request);
}
