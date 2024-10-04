import { LucidEvolution } from "@lucid-evolution/lucid";
import { ManageHeadSchema } from "../../shared";

async function handleCloseHead(
  lucid: LucidEvolution,
  params: ManageHeadSchema
): Promise<void> {
  const { auth_token } = params;
  if (!validateAdmin(auth_token)) {
    throw new Error("Unauthorized");
  }
  return;
}

function validateAdmin(auth_token: string): boolean {
  return true;
}

export { handleCloseHead };