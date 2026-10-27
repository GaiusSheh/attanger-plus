# Attanger Plus

A Zotero plugin that keeps your linked-file folders one-to-one with your collections. It works alongside [Attanger](https://github.com/MuiseDestiny/zotero-attanger) and is not affiliated with it.

[中文说明](#中文说明)

## What it does

Attanger files each new attachment into the folder of its collection. Attanger Plus keeps that true afterwards:

- An item in several collections gets an identical copy of its file in each collection's folder. Zotero links to one of them; all are equal.
- Adding an item to a collection, removing it, renaming an attachment, or renaming, moving and deleting a collection is followed on disk.
- Items you move to Zotero's trash take their files to a plugin trash (`.attanger-plus-trash` in the files root); restoring brings them back, emptying the trash deletes them.
- Removing an item from its last collection asks what to do with its files.
- Changes made in the file manager are never overwritten: they are listed in a window where you decide.
- **Tools → Attanger Plus: Check Library…** compares the library with the folders, and repairs what can be repaired in one click.
- A notification in the corner says what was done.

## Requirements

- Zotero 8 or later (tested on Zotero 10, Windows)
- Attanger in *linked* mode, with the subfolder format `{{collection}}`
- Zotero's base directory for linked files (Settings → Advanced → Files and Folders) set to the same folder as Attanger's destination

## Install

Download `attanger-plus.xpi` from the [latest release](https://github.com/GaiusSheh/attanger-plus/releases/latest), then in Zotero open **Tools → Plugins** and drag the file in. Later versions are offered through Zotero's own update check. To upgrade by hand, install over the old version rather than removing it first, then restart Zotero.

Start with **Check Library…** before relying on the plugin: it shows what does not match yet.

## Settings

In **Settings → Attanger Plus**: copy maintenance on or off, dry run (log only, no file changes), notifications, and looking for file-manager changes at startup. Every write is logged in `attanger-plus/` in Zotero's data directory; the pane opens this month's log.

## Safety

- Files are deleted only when you delete or remove something in Zotero, and only once an identical copy is known to remain or you have chosen it in a window.
- Anything else moved out of the way goes to the plugin trash and is removed after Zotero's trash period (30 days by default).
- With several computers, the one where you make a change moves the files; the plugin leaves file syncing to OneDrive, Dropbox and the like.

## Development

`npm install`, copy `.env.example` to `.env` and point it at a separate Zotero profile and data directory, then `npm start` (development Zotero), `npm test -- --no-watch` or `npm run build`.

## License

MIT

---

## 中文说明

让链接文件的文件夹与 Zotero 的 collection 保持一一对应的插件。配合 [Attanger](https://github.com/MuiseDestiny/zotero-attanger) 使用，与 Attanger 无隶属关系。

### 功能

Attanger 在新增附件时把文件放进它所在 collection 的文件夹，Attanger Plus 负责之后一直保持这一点：

- 属于多个 collection 的条目，在每个 collection 文件夹里各有一份内容相同的副本；Zotero 链接其中一份，各份地位平等。
- 加入、移出 collection，附件改名，collection 改名、移动、删除，都会同步到磁盘上。
- 条目移进 Zotero 回收站时，文件随之进入插件回收站（文件根目录下的 `.attanger-plus-trash`）；还原时放回，清空时删除。
- 条目移出最后一个 collection 时，询问怎么处理它的文件。
- 在文件管理器里做的改动不会被覆盖，而是列在一个窗口里由你决定。
- **工具 → Attanger Plus：检查文库…** 对比文库与文件夹，能一键修复的直接修复。
- 每次操作完成后在右下角提示。

### 前提

- Zotero 8 及以上（在 Windows 上的 Zotero 10 测试）
- Attanger 使用 *linked* 模式，子文件夹格式为 `{{collection}}`
- Zotero 的链接附件根目录（设置 → 高级 → 文件和文件夹）与 Attanger 的目标文件夹相同

### 安装

从[最新版本](https://github.com/GaiusSheh/attanger-plus/releases/latest)下载 `attanger-plus.xpi`，在 Zotero 的 **工具 → 插件** 里把文件拖进去。之后的版本会通过 Zotero 自己的更新检查推送。手动升级时直接覆盖安装，不要先移除旧版，装完重启 Zotero。

开始使用前先运行一次 **检查文库…**，看看哪些地方还对不上。

### 设置

**设置 → Attanger Plus**：副本维护开关、试运行（只记日志，不动文件）、操作提示、启动时检查文件管理器中的变化。所有写操作都记在 Zotero 数据目录的 `attanger-plus/` 里，面板上可以直接打开本月日志。

### 安全

- 只在你于 Zotero 中删除或移除时才删文件，并且要么确认还有一份相同的副本，要么是你在窗口里选的。
- 其他需要挪开的文件都进插件回收站，过了 Zotero 回收站的保留期（默认 30 天）自动清除。
- 多台电脑时，由做改动的那台电脑挪文件；文件同步交给 OneDrive、Dropbox 等工具。

### 开发

`npm install`，把 `.env.example` 复制为 `.env` 并指向单独的 Zotero profile 和数据目录，然后 `npm start`（开发用 Zotero）、`npm test -- --no-watch` 或 `npm run build`。

### 许可证

MIT
