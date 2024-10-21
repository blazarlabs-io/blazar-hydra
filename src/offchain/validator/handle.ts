import { applyDoubleCborEncoding, applyParamsToScript, Data, SpendingValidator, ValueGuard } from "@lucid-evolution/lucid";
import plutusBlueprint from "../../onchain/hydra-pay/plutus.json" assert { type: "json" };
import { CredentialSchema, CredentialT } from "../lib/types";

const hydraPayValidator = plutusBlueprint.validators.find(
  ({ title }) => title === "main.main.spend",
);
if (!hydraPayValidator) {
  throw new Error("Hydra validator indexed with 'main.main.spend' failed!");
}
const hydraScript: SpendingValidator["script"] = hydraPayValidator.compiledCode;
const VerificationKey = Data.Bytes();
const ValidatorParam = Data.Tuple([VerificationKey, CredentialSchema]);
type ValidatorParamT = Data.Static<typeof ValidatorParam>;

function buildValidator(
  admin_key: string,
  hydra_script: CredentialT,
): SpendingValidator {
  const appliedValidator = applyParamsToScript<ValidatorParamT>(
    applyDoubleCborEncoding(hydraScript),
    [admin_key, hydra_script],
    ValidatorParam as unknown as ValidatorParamT,
  );
  return {
    type: "PlutusV3",
    script: appliedValidator,
  };
}

export { buildValidator };