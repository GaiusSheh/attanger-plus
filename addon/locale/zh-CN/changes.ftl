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
