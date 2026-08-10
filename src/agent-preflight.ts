import { Effect } from "effect";
import { parseModelReference } from "./options.ts";
import type { Interface as IntegrationService } from "./integration.ts";
import type { Interface as ModelCatalogService } from "./model-catalog.ts";

export type PreflightResult = { readonly providerID: string; readonly modelID: string };

export type PreflightError =
  | { readonly _tag: "InvalidModel"; readonly value: string }
  | { readonly _tag: "NoCredential"; readonly providerID: string }
  | { readonly _tag: "ModelUnavailable"; readonly providerID: string; readonly modelID: string };

export function agentPreflight(
  modelReference: string,
  integrations?: IntegrationService,
  modelCatalog?: ModelCatalogService,
): Effect.Effect<PreflightResult, PreflightError> {
  return Effect.gen(function* () {
    const parsed = parseModelReference(modelReference);
    if (!parsed) {
      return yield* Effect.fail({ _tag: "InvalidModel" as const, value: modelReference });
    }
    const { providerID, modelID } = parsed;
    if (integrations) {
      const info = yield* integrations.get(providerID);
      if (!info || info.connections.length === 0) {
        return yield* Effect.fail({ _tag: "NoCredential" as const, providerID });
      }
    }
    if (modelCatalog) {
      const model = yield* modelCatalog.model(providerID, modelID);
      if (!model) {
        return yield* Effect.fail({
          _tag: "ModelUnavailable" as const,
          providerID,
          modelID,
        });
      }
    }
    return { providerID, modelID };
  });
}
