import { LucidEvolution } from '@lucid-evolution/lucid';
import { PartialCommitSchema } from '../../shared';

export async function handlePartialCommit(
  lucid: LucidEvolution,
  partialCommitSchema: PartialCommitSchema
): Promise<{ a: string }> {
  const {} = partialCommitSchema;
  const adminAddress = await lucid.wallet().address();
  return {
    a: adminAddress,
  };
}
