unfiled-window-title = Attanger Plus — 已不在任何 collection 中的条目
unfiled-heading = 下面的条目刚被移出了它们所在的最后一个 collection，文件还留在原来的文件夹里，别处没有副本。逐条选择怎么处理，然后点「执行」。直接关闭窗口等于全部取消。
unfiled-item = 「{ $title }」刚从「{ $collections }」移除，有 { $files } 个文件。
unfiled-cancel = 取消：加回「{ $collections }」
unfiled-trash-item = 把条目移进回收站（文件随之进插件回收站；还原时回到原来的 collection）
unfiled-trash-files =
    { $annotations ->
        [0] 保留条目，删除文件（附件移进回收站，清空回收站时删除）
       *[other] 保留条目，删除文件（附件移进回收站，含 { $annotations } 条批注，清空回收站时删除）
    }
unfiled-cancel-all = 全部取消
unfiled-apply = 执行
