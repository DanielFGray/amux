/**
 * Pane-type descriptor codecs — daemon-side half of `PaneContent.descriptor`.
 *
 * Built as closed-over decode→encode→size-check closures. The daemon collects
 * them from plugin registrations into {@link WorkspaceTransactionPlugins};
 * there is no module-level registry.
 */
import { Result, Schema as S } from "effect";
import { DescriptorSchema } from "./layout.ts";
import { errorMessage } from "./error-message.ts";
import { ownerJsonCodec, WorkspaceChangeError, type OwnerJsonCodec } from "./workspace-changes.ts";

export type PaneDescriptorCodec = OwnerJsonCodec;

export type PaneDescriptorRegistration = {
  readonly type: string;
  readonly codec: PaneDescriptorCodec;
};

/** Close over `type`'s descriptor Schema (plus DescriptorSchema size check). */
export function paneDescriptorCodec<A>(
  type: string,
  schema: S.Codec<A>,
): PaneDescriptorRegistration {
  const base = ownerJsonCodec(schema, `plugin.place descriptor for '${type}'`);
  const codec: PaneDescriptorCodec = (raw) => {
    const encoded = base(raw);
    if (Result.isFailure(encoded)) return encoded;
    const sized = S.decodeUnknownResult(DescriptorSchema)(encoded.success);
    if (Result.isFailure(sized)) {
      return Result.fail(
        new WorkspaceChangeError({
          message: `plugin.place descriptor size for '${type}': ${errorMessage(sized.failure)}`,
        }),
      );
    }
    return Result.succeed(sized.success);
  };
  return { type, codec };
}
