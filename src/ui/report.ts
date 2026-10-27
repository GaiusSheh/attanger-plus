import type { FluentMessageId } from "../../typings/i10n";
import { runCheck } from "../check";
import { toAbsolute } from "../check/paths";
import { CHECK_IDS, IGNORABLE_CHECKS, issueID, type CheckId, type CheckReport, type Issue } from "../check/types";
import { repairsOf } from "../sync/repair";
import { showChanges } from "./changes";
import { l10nID } from "./l10n";

const REPORT_URL = "chrome://attangerplus/content/report.xhtml";
/** Matches the windowtype attribute in report.xhtml. */
const REPORT_WINDOW_TYPE = "attanger-plus:report";

/** Checks whose `related` holds item keys rather than paths or names. */
const RELATED_ITEMS: CheckId[] = ["C10", "C11"];

type L10nArgs = Record<string, string | number>;

/** Open the report window (or bring the open one forward) and run a check. */
export async function openReport(): Promise<Window> {
  const existing = Services.wm.getMostRecentWindow(REPORT_WINDOW_TYPE) as Window | null;
  if (existing) {
    existing.focus();
    return existing;
  }
  const win = Zotero.getMainWindow().openDialog(
    REPORT_URL,
    "",
    "chrome,centerscreen,resizable,dialog=no,width=900,height=700",
  ) as Window | null;
  if (!win) {
    throw new Error(`Could not open ${REPORT_URL}`);
  }
  await new Promise<void>((resolve) => win.addEventListener("load", () => resolve(), { once: true }));
  await new ReportView(win).run();
  return win;
}

export function closeReports(): void {
  const windows = Services.wm.getEnumerator(REPORT_WINDOW_TYPE) as unknown as Iterable<Window>;
  for (const win of windows) {
    win.close();
  }
}

class ReportView {
  private readonly doc: Document;
  private report: CheckReport | null = null;

  constructor(private readonly win: Window) {
    this.doc = win.document;
    this.element("rerun").addEventListener("click", () => void this.run());
    this.element("changes").addEventListener("click", () => {
      this.handleChanges().catch((e) => this.fail(e));
    });
    this.element("export").addEventListener("click", () => {
      this.exportMarkdown().catch((e) => this.fail(e));
    });
  }

  async run(): Promise<void> {
    this.report = null;
    this.setBusy(true);
    this.element("root").textContent = "";
    this.element("config").hidden = true;
    this.element("results").replaceChildren();
    this.localize(this.element("status"), "report-running");
    try {
      this.report = await runCheck();
      this.render(this.report);
    } catch (e) {
      this.fail(e);
    } finally {
      this.setBusy(false);
    }
  }

  // ---------------------------------------------------------- rendering

  private render(r: CheckReport): void {
    if (r.root) {
      this.localize(this.element("root"), "report-root", { root: r.root });
    }
    this.localize(this.element("status"), "report-summary", summaryArgs(r));

    const configList = this.element("config-list");
    configList.replaceChildren(
      ...r.config.map((notice) => {
        const li = this.create("li");
        this.localize(li, `config-${notice.kind}` as FluentMessageId, { detail: notice.detail });
        return li;
      }),
    );
    this.element("config").hidden = r.config.length === 0;

    const results = this.element("results");
    const sections = CHECK_IDS.map((check) => r.issues.filter((i) => i.check === check))
      .filter((list) => list.length)
      .map((list) => this.section(list));
    if (!r.issues.some((i) => !i.ignored)) {
      const p = this.create("p");
      p.className = "clean";
      this.localize(p, "report-clean");
      sections.unshift(p);
    }
    results.replaceChildren(...sections);
  }

  /** One check's issues; ignored ones (§F1.1, C12) listed apart at the end, not counted. */
  private section(issues: Issue[]): HTMLElement {
    const { check, severity } = issues[0];
    const active = issues.filter((i) => !i.ignored);
    const ignored = issues.filter((i) => i.ignored);
    const details = this.create("details");
    details.open = active.length > 0;
    const summary = this.create("summary");
    const title = this.create("span");
    this.localize(title, `check-${check}` as FluentMessageId);
    const badge = this.create("span");
    badge.className = `badge ${severity}`;
    this.localize(badge, `report-severity-${severity}`);
    summary.append(`${check} · `, title, ` (${active.length})`, badge);
    const list = this.create("ul");
    list.append(...active.map((issue) => this.row(issue)));
    details.append(summary, list);
    if (ignored.length) {
      const heading = this.create("p");
      heading.className = "ignored-heading";
      this.localize(heading, "report-ignored", { count: ignored.length });
      const rest = this.create("ul");
      rest.append(...ignored.map((issue) => this.row(issue)));
      details.append(heading, rest);
    }
    return details;
  }

  private row(issue: Issue): HTMLElement {
    const li = this.create("li");
    li.classList.toggle("ignored", !!issue.ignored);
    li.dataset.issue = issueID(issue);
    if (issue.itemKey) {
      li.append(this.link(issue.itemTitle || issue.itemKey, "item-link", () => selectItem(issue.itemKey!)), " — ");
    } else if (issue.collectionKey) {
      li.append(
        this.link(issue.collectionPath ?? issue.collectionKey, "item-link", () => selectCollection(issue.collectionKey!)),
        " — ",
      );
    }
    const text = this.create("span");
    this.localize(text, issueMessage(issue), issueArgs(issue));
    li.append(text);
    if (issue.path) {
      const show = this.link("", "show-link", () => reveal(this.report?.root ?? null, issue.path!));
      this.localize(show, "report-show");
      li.append(show);
    }
    if (IGNORABLE_CHECKS.includes(issue.check)) {
      const toggle = this.link("", "ignore-link", () => this.setIgnored(issue, !issue.ignored));
      this.localize(toggle, issue.ignored ? "report-unignore" : "report-ignore");
      li.append(toggle);
    }
    return li;
  }

  /** Ignore a notice for good (§F1.1, C12), or stop ignoring it; then check again. */
  private async setIgnored(issue: Issue, ignored: boolean): Promise<void> {
    const sync = Zotero.AttangerPlus?.sync;
    if (!sync) {
      throw new Error("Attanger Plus is not running");
    }
    await sync.setIssueIgnored(issueID(issue), ignored);
    await this.run();
  }

  // ------------------------------------------------------------- export

  /**
   * Look for file-manager changes (§F3.6–F3.8), add the repairs this report
   * allows (§F1.3), and open the window to decide on them; check again once
   * something was done.
   */
  private async handleChanges(): Promise<void> {
    const sync = Zotero.AttangerPlus?.sync;
    if (!sync) {
      throw new Error("Attanger Plus is not running");
    }
    if (!this.report) {
      await this.run();
    }
    const repairs = this.report ? repairsOf(this.report) : [];
    const findings = await sync.inspect();
    if (!findings.length && !repairs.length) {
      Services.prompt.alert(this.win as unknown as mozIDOMWindowProxy, "Attanger Plus", await this.format("report-changes-none"));
      return;
    }
    const { done } = await showChanges(findings, { repairs });
    if (await done) {
      await this.run();
    }
  }

  private async exportMarkdown(): Promise<void> {
    if (!this.report) {
      return;
    }
    const { FilePicker } = ChromeUtils.importESModule("chrome://zotero/content/modules/filePicker.mjs") as {
      FilePicker: new () => FilePickerLike;
    };
    const fp = new FilePicker();
    fp.init(this.win, await this.format("report-export-title"), fp.modeSave);
    fp.appendFilter("Markdown", "*.md");
    fp.defaultExtension = "md";
    fp.defaultString = `attanger-plus-check-${this.report.startedAt.slice(0, 10)}.md`;
    const result = await fp.show();
    if (result !== fp.returnOK && result !== fp.returnReplace) {
      return;
    }
    await IOUtils.writeUTF8(fp.file, await buildMarkdown(this.doc, this.report));
  }

  // ------------------------------------------------------------ helpers

  private element(id: string): HTMLElement {
    const el = this.doc.getElementById(id);
    if (!el) {
      throw new Error(`#${id} is missing from report.xhtml`);
    }
    return el;
  }

  private create<K extends keyof HTMLElementTagNameMap>(tag: K): HTMLElementTagNameMap[K] {
    return this.doc.createElementNS("http://www.w3.org/1999/xhtml", tag) as HTMLElementTagNameMap[K];
  }

  private link(text: string, className: string, onClick: () => Promise<void>): HTMLAnchorElement {
    const a = this.create("a");
    a.className = className;
    a.textContent = text;
    a.addEventListener("click", () => {
      onClick().catch((e) => Zotero.logError(e));
    });
    return a;
  }

  private localize(el: Element, id: FluentMessageId, args?: L10nArgs): void {
    this.doc.l10n!.setAttributes(el, l10nID(id), args);
  }

  private format(id: FluentMessageId, args?: L10nArgs): Promise<string> {
    return format(this.doc, id, args);
  }

  private setBusy(busy: boolean): void {
    (this.element("rerun") as HTMLButtonElement).disabled = busy;
    (this.element("export") as HTMLButtonElement).disabled = busy || !this.report;
  }

  private fail(e: unknown): void {
    Zotero.logError(e as Error);
    this.localize(this.element("status"), "report-failed", { message: String((e as Error)?.message ?? e) });
  }
}

interface FilePickerLike {
  modeSave: number;
  returnOK: number;
  returnReplace: number;
  defaultExtension: string;
  defaultString: string;
  file: string;
  init(win: Window, title: string, mode: number): void;
  appendFilter(title: string, filter: string): void;
  show(): Promise<number>;
}

/** The report as Markdown, in the language of `doc` (a report window). */
export async function buildMarkdown(doc: Document, r: CheckReport): Promise<string> {
  const lines = [
    `# ${await format(doc, "report-heading")}`,
    "",
    await format(doc, "report-generated", { date: r.startedAt }),
    "",
  ];
  if (r.root) {
    lines.push(await format(doc, "report-root", { root: r.root }), "");
  }
  lines.push(await format(doc, "report-summary", summaryArgs(r)), "");
  if (r.config.length) {
    lines.push(`## ${await format(doc, "report-config")}`, "");
    for (const notice of r.config) {
      lines.push(`- ${await format(doc, `config-${notice.kind}` as FluentMessageId, { detail: notice.detail })}`);
    }
    lines.push("");
  }
  if (!r.issues.some((i) => !i.ignored)) {
    lines.push(await format(doc, "report-clean"), "");
  }
  for (const check of CHECK_IDS) {
    const issues = r.issues.filter((i) => i.check === check);
    if (!issues.length) {
      continue;
    }
    const active = issues.filter((i) => !i.ignored);
    const ignored = issues.filter((i) => i.ignored);
    const title = await format(doc, `check-${check}` as FluentMessageId);
    const severity = await format(doc, `report-severity-${issues[0].severity}`);
    lines.push(`## ${check} · ${title} (${active.length}) — ${severity}`, "");
    const list = async (group: Issue[]) => {
      for (const issue of group) {
        const subject = issue.itemKey ? issue.itemTitle || issue.itemKey : issue.collectionPath;
        const text = await format(doc, issueMessage(issue), issueArgs(issue));
        lines.push(subject ? `- **${subject}** — ${text}` : `- ${text}`);
      }
    };
    await list(active);
    if (ignored.length) {
      lines.push("", await format(doc, "report-ignored", { count: ignored.length }), "");
      await list(ignored);
    }
    lines.push("");
  }
  return lines.join("\n");
}

/** Fails loudly on a missing message instead of exporting its ID. */
async function format(doc: Document, id: FluentMessageId, args?: L10nArgs): Promise<string> {
  const value = await doc.l10n!.formatValue(l10nID(id), args);
  if (value === null || value === undefined) {
    throw new Error(`Missing localization: ${l10nID(id)}`);
  }
  return value;
}

function summaryArgs(r: CheckReport): L10nArgs {
  const active = r.issues.filter((i) => !i.ignored);
  return {
    problems: active.filter((i) => i.severity === "problem").length,
    notices: active.filter((i) => i.severity === "notice").length,
    items: r.stats.items,
    files: r.stats.files,
    seconds: (r.durationMs / 1000).toFixed(1),
  };
}

function issueMessage(issue: Issue): FluentMessageId {
  return `issue-${issue.check}-${issue.kind}` as FluentMessageId;
}

function issueArgs(issue: Issue): L10nArgs {
  const related = RELATED_ITEMS.includes(issue.check)
    ? (issue.related ?? []).map(itemTitle)
    : (issue.related ?? []);
  return {
    path: issue.path ?? "",
    collection: issue.collectionPath ?? "",
    related: related.join(", "),
    count: issue.count ?? 0,
  };
}

function itemTitle(key: string): string {
  const item = Zotero.Items.getByLibraryAndKey(Zotero.Libraries.userLibraryID, key);
  return item ? String(item.getField("title")) || key : key;
}

async function selectItem(key: string): Promise<void> {
  const id = Zotero.Items.getIDFromLibraryAndKey(Zotero.Libraries.userLibraryID, key);
  const pane = Zotero.getActiveZoteroPane();
  if (!id || !pane) {
    return;
  }
  Zotero.getMainWindow().focus();
  await pane.selectItem(id);
}

async function selectCollection(key: string): Promise<void> {
  const collection = Zotero.Collections.getByLibraryAndKey(Zotero.Libraries.userLibraryID, key);
  const pane = Zotero.getActiveZoteroPane();
  if (!collection || !pane || !pane.collectionsView) {
    return;
  }
  Zotero.getMainWindow().focus();
  await pane.collectionsView.selectCollection(collection.id);
}

/** Show a file or folder in the file manager; for a missing one, its nearest existing parent. */
async function reveal(root: string | null, path: string): Promise<void> {
  let target: string | null = PathUtils.isAbsolute(path) || !root ? path : toAbsolute(root, path);
  while (target && !(await IOUtils.exists(target))) {
    target = PathUtils.parent(target);
  }
  if (target) {
    await Zotero.File.reveal(target);
  }
}
