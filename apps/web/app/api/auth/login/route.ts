import { hub } from "@/lib/server/hub";

export async function POST(request: Request) {
  return hub().login(request);
}
