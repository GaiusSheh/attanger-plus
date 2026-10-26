import { collectionNames } from "../utils/zotero";
import { l10nID } from "./l10n";

/*
 * "Remove from Current / All / Chosen Collections…" (requirements §F6).
 * These only change collection membership; the copies follow through the
 * same events as Zotero's own "Remove Item from Collection…" (§F3.2).
 */

const TITLE = "Attanger Plus";
const DIALOG_URL = "chrome://attangerplus/content/remove.xhtml";
const XHTML = "http://www.w3.org/1999/xhtml";

/** Items whose membership changes: the parents of selected attachments and notes, user library only. */
export function topLevelItems(items: Zotero.Item[]): Zotero.Item[] {
  const seen = new Set<number>();
  const result: Zotero.Item[] = [];
  for (const item of items) {
    const top = (item.parentItemID ? Zotero.Items.get(item.parentItemID) : item) as Zotero.Item | false;
    if (top && !seen.has(top.id) && top.libraryID === Zotero.Libraries.userLibraryID) {
      seen.add(top.id);
      result.push(top);
    }
  }
  return result;
}

export interface CollectionChoice {
  id: number;
  /** e.g. "Physics/Optics" */
  path: string;
  checked: boolean;
}

/** All collections any of the items is in, by path; the current one checked. */
export function removalChoices(items: Zotero.Item[], current: Zotero.Collection | null): CollectionChoice[] {
  const ids = new Set<number>();
  for (const item of topLevelItems(items)) {
    item.getCollections().forEach((id) => ids.add(id));
  }
  return [...ids]
    .map((id) => Zotero.Collections.get(id))
    .filter((c): c is Zotero.Collection => !!c)
    .map((c) => ({ id: c.id, path: collectionNames(c).join("/"), checked: c.id === current?.id }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

/** Remove the items from these collections in one transaction; returns the number of memberships removed. */
export async function removeFromCollections(items: Zotero.Item[], collectionIDs: number[]): Promise<number> {
  const top = topLevelItems(items);
  let removed = 0;
  await Zotero.DB.executeTransaction(async () => {
    for (const id of collectionIDs) {
      const collection = Zotero.Collections.get(id);
      const members = top.filter((i) => i.inCollection(id)).map((i) => i.id);
      if (collection && members.length) {
        await collection.removeItems(members);
        removed += members.length;
      }
    }
  });
  return removed;
}

export function canRemoveFromCurrent(items: Zotero.Item[], current: Zotero.Collection | null): boolean {
  return !!current && topLevelItems(items).some((i) => i.inCollection(current.id));
}

export function canRemoveFromAny(items: Zotero.Item[]): boolean {
  return topLevelItems(items).some((i) => i.getCollections().length > 0);
}

export async function removeFromCurrent(items: Zotero.Item[], current: Zotero.Collection | null): Promise<void> {
  if (!current) {
    return;
  }
  const members = topLevelItems(items).filter((i) => i.inCollection(current.id));
  if (!members.length) {
    return;
  }
  const ok = await confirm("remove-confirm-current", {
    count: members.length,
    collection: collectionNames(current).join("/"),
  });
  if (ok) {
    await removeFromCollections(members, [current.id]);
  }
}

export async function removeFromAll(items: Zotero.Item[]): Promise<void> {
  const members = topLevelItems(items).filter((i) => i.getCollections().length > 0);
  if (!members.length) {
    return;
  }
  if (await confirm("remove-confirm-all", { count: members.length })) {
    await removeFromCollections(members, removalChoices(members, null).map((c) => c.id));
  }
}

export async function removeFromChosen(items: Zotero.Item[], current: Zotero.Collection | null): Promise<void> {
  const choices = removalChoices(items, current);
  if (!choices.length) {
    return;
  }
  const chosen = await chooseCollections(choices);
  if (chosen?.length) {
    await removeFromCollections(items, chosen);
  }
}

/** The "Remove from Chosen Collections" dialog; resolves to the checked IDs, or null when cancelled. */
export async function chooseCollections(choices: CollectionChoice[]): Promise<number[] | null> {
  const win = Zotero.getMainWindow().openDialog(
    DIALOG_URL,
    "",
    "chrome,centerscreen,dialog=no,resizable,width=480,height=420",
  ) as Window | null;
  if (!win) {
    throw new Error(`Could not open ${DIALOG_URL}`);
  }
  await new Promise<void>((resolve) => win.addEventListener("load", () => resolve(), { once: true }));
  const doc = win.document;
  const list = doc.getElementById("collections")!;
  const ok = doc.getElementById("ok") as HTMLButtonElement;
  const boxes: HTMLInputElement[] = [];
  for (const choice of choices) {
    const item = doc.createElementNS(XHTML, "li");
    const label = doc.createElementNS(XHTML, "label");
    const box = doc.createElementNS(XHTML, "input") as HTMLInputElement;
    box.type = "checkbox";
    box.value = String(choice.id);
    box.checked = choice.checked;
    box.addEventListener("change", () => (ok.disabled = !boxes.some((b) => b.checked)));
    boxes.push(box);
    label.append(box, ` ${choice.path}`);
    item.append(label);
    list.append(item);
  }
  ok.disabled = !boxes.some((b) => b.checked);

  return new Promise((resolve) => {
    let answered = false;
    const answer = (ids: number[] | null) => {
      if (!answered) {
        answered = true;
        resolve(ids);
      }
    };
    ok.addEventListener("click", () => {
      answer(boxes.filter((b) => b.checked).map((b) => Number(b.value)));
      win.close();
    });
    doc.getElementById("cancel")!.addEventListener("click", () => {
      answer(null);
      win.close();
    });
    win.addEventListener("unload", () => answer(null));
  });
}

/** Matches the windowtype attribute in remove.xhtml. */
const DIALOG_TYPE = "attanger-plus:remove";

export function closeRemoveDialogs(): void {
  const windows = Services.wm.getEnumerator(DIALOG_TYPE) as unknown as Iterable<Window>;
  for (const win of windows) {
    win.close();
  }
}

async function confirm(id: "remove-confirm-current" | "remove-confirm-all", args: Record<string, string | number>) {
  const win = Zotero.getMainWindow();
  const message = (await win.document.l10n!.formatValue(l10nID(id), args)) as string;
  return Services.prompt.confirm(win as unknown as mozIDOMWindowProxy, TITLE, message);
}
