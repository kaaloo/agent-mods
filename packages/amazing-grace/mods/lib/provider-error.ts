import { handlesMatch } from "./ladder.ts";
import type { ModProviderErrorEvent } from "../types.ts";

export function providerErrorText(event: ModProviderErrorEvent): string {
  return [event.error?.message, event.error?.detail, event.detail]
    .filter((value): value is string => Boolean(value))
    .join(" ");
}

export function canRetryProviderErrorWith(
  event: ModProviderErrorEvent,
  model: string | null | undefined,
): model is string {
  return Boolean(
    model &&
      !(event.triedModels ?? []).some((attempted) =>
        handlesMatch(attempted, model),
      ),
  );
}
