import { Effect } from "effect";
import { CommandError } from "../../../commands.ts";
import { parseModelReference } from "./options.ts";
import { Service as Integration } from "../../../integration.ts";
import { Service as ModelCatalog } from "../../../model-catalog.ts";

/**
 * Refuse to open a chat pane this harness cannot serve, and say why.
 *
 * The worker checks the same three things when it starts, because it is the one
 * that needs the answer. This runs first so the refusal reaches the user as a
 * sentence instead of as a pane that opens and dies — the model reference is
 * config, and a typo in it is the common case.
 *
 * The services come from context rather than from arguments: a preflight given
 * no catalog would pass everything, which is the one thing a preflight must
 * never do.
 */
export const agentPreflight = (
  modelReference: string,
): Effect.Effect<void, CommandError, Integration | ModelCatalog> =>
  Effect.gen(function* () {
    const parsed = parseModelReference(modelReference);
    if (!parsed)
      return yield* new CommandError({
        message: `invalid agent.model '${modelReference}', expected provider/model`,
      });
    const { providerID, modelID } = parsed;

    const integrations = yield* Integration;
    const info = yield* integrations.get(providerID);
    if (!info || info.connections.length === 0)
      return yield* new CommandError({ message: `no credential stored for ${providerID}` });

    const catalog = yield* ModelCatalog;
    if (!(yield* catalog.model(providerID, modelID)))
      return yield* new CommandError({
        message: `model ${providerID}/${modelID} is not available`,
      });
  });
