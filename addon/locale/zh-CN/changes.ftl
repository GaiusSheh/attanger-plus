changes-window-title = Attanger Plus — 文件管理器中的变化
changes-heading = 在 Zotero 之外，下面这些文件被改动或删除了。逐条选择怎么处理，然后点「执行」（至少改动一项才能点）。「手动处理」：这次先不管，下次照常提示；「忽略」：以后不再自动弹窗提示，但检查报告和这里仍会列出。
changes-section-differ = 副本内容不一致（{ $count }）
changes-section-missing = 副本被删除（{ $count }）
changes-section-all-missing = 所有副本都不见了（{ $count }）
changes-ignored-tag = （已忽略）
changes-manual = 手动处理
changes-ignore = 忽略
changes-differ-item = 「{ $title }」的 { $count } 份副本内容不一样。
changes-differ-sync = 同步：以选中的那份为准，覆盖勾选的副本（旧版本移进插件回收站，与 Zotero 回收站同样到期清除）
changes-col-source = 以此为准
changes-col-target = 覆盖
changes-col-file = 文件
changes-col-modified = 修改时间
changes-col-size = 大小
changes-missing-item = 「{ $title }」在「{ $collection }」里的文件找不到了（应在：{ $file }）。可从这份恢复：{ $source }
changes-missing-remove = 从「{ $collection }」移除
changes-missing-restore = 从其他副本恢复
changes-all-missing-item = 「{ $title }」的文件在它所有的 collection 文件夹里都找不到了（Zotero 记录的位置：{ $file }）。条目保留，检查会把它标为文件丢失。
changes-relocate = 重新定位…
changes-trash-attachment =
    { $annotations ->
        [0] 删除这个附件（移进回收站）
       *[other] 删除这个附件（移进回收站，含 { $annotations } 条批注）
    }
changes-trash-item = 删除整个条目（移进回收站）
changes-relocate-title = 选择「{ $title }」的文件
changes-relocate-picked = 将复制：{ $file }（原文件不动）
changes-close = 关闭
changes-apply = 执行
changes-repair-heading = 下面是检查报告里可以一键修复的问题，默认已选「修复」，不想修的改成「手动处理」。挪走的文件放进插件回收站的 _orphans 文件夹，与 Zotero 回收站同样到期清除。
changes-section-trash = 插件回收站对不上（{ $count }）
changes-section-misplaced = 放错位置的文件（{ $count }）
changes-section-orphan = 孤儿文件（{ $count }）
changes-section-stray = 多余文件夹（{ $count }）
changes-fix = 修复
changes-repair-trash-outside = 「{ $title }」在回收站里，但它的 { $count } 个文件还在 collection 文件夹中。修复：挪进插件回收站（同删除条目）。
changes-repair-trash-live = 「{ $title }」已不在回收站，它的文件却还在插件回收站（{ $path }，{ $count } 个文件）。修复：放回它所在的 collection 文件夹（同还原）。
changes-repair-trash-gone = 插件回收站里的 { $path }（{ $count } 个文件）不属于任何现有条目，条目可能已彻底删除。修复：挪进 _orphans，到期清除。
changes-repair-collection-live = collection「{ $collection }」已不在回收站，它的文件夹却还在插件回收站（{ $count } 个文件）。修复：挪回原位（同还原）。
changes-repair-collection-gone = 插件回收站里的 { $path }（{ $count } 个文件）属于一个已彻底删除的 collection。修复：同彻底删除——还被其他条目用到的文件放到它们那边，只在其中的条目会询问。
changes-repair-misplaced = 「{ $title }」的文件不在它的 collection 文件夹里：{ $path }。修复：移到 { $folder }，改链接，补齐其他副本；原处那份挪进 _orphans。
changes-repair-outside = 「{ $title }」的文件在文件根目录之外：{ $path }。修复：复制到 { $folder }（原文件不动），改链接，补齐其他副本。
changes-repair-orphan-copy = { $path }：没有附件用它，内容与 { $copy } 相同。修复：挪进 _orphans。
changes-repair-orphan-unique = { $path }：没有附件用它，内容别处没有。修复：挪进 _orphans。
changes-repair-stray = { $path }（{ $count } 个文件）：不对应任何 collection。修复：里面的文件处理完后删掉这个文件夹（还有文件就留着）。
