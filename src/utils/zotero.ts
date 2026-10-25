/**
 * The base file name Zotero's rename template gives an attachment of `item`
 * (the same call Attanger uses when it renames new attachments).
 *
 * zotero-types still declares the old `(item, formatString)` form; Zotero 10
 * takes an options object.
 */
export function templateBaseName(item: Zotero.Item, attachmentTitle = ""): string {
  const getName = Zotero.Attachments.getFileBaseNameFromItem as unknown as (
    item: Zotero.Item,
    options: { attachmentTitle?: string },
  ) => string;
  return getName.call(Zotero.Attachments, item, { attachmentTitle });
}
