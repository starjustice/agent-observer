import { hub } from "@/lib/server/hub";

export async function POST() {
  return hub().logout();
}
