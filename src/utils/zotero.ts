/**
 * The base file name Zotero's rename template gives an attachment of `item`
 * (the same call Attanger uses when it renames new attachments).
 *
 * zotero-types still declares the old `(item, formatString)` form; Zotero 10
 * takes an options object.
 */
/** Names from the top-level collection down to `collection`. */
export function collectionNames(collection: Zotero.Collection): string[] {
  const names: string[] = [];
  for (let c: Zotero.Collection | false = collection; c; c = c.parentID ? Zotero.Collections.get(c.parentID) : false) {
    names.unshift(c.name);
  }
  return names;
}

export function templateBaseName(item: Zotero.Item, attachmentTitle = ""): string {
  const getName = Zotero.Attachments.getFileBaseNameFromItem as unknown as (
    item: Zotero.Item,
    options: { attachmentTitle?: string },
  ) => string;
  return getName.call(Zotero.Attachments, item, { attachmentTitle });
}
