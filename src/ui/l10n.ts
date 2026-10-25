import type { FluentMessageId } from "../../typings/i10n";

/**
 * Message ID as it exists at runtime: scaffold prefixes every message in the
 * FTL files (and data-l10n-id in .xhtml) with the plugin namespace, but not
 * IDs written in TypeScript.
 */
export function l10nID(id: FluentMessageId): string {
  return `attanger-plus-${id}`;
}
