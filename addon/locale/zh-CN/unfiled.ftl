unfiled-window-title = Attanger Plus — 已不在任何 collection 中的条目
unfiled-heading = 下面的条目已不在任何 collection 中：刚被移出了最后一个 collection，或者它们唯一的 collection 被彻底删除了。它们的文件别处没有副本。逐条选择怎么处理，然后点「执行」。直接关闭窗口等于全部按默认选项处理。
unfiled-erased-item = 「{ $title }」所在的 collection「{ $collection }」已被彻底删除，它的 { $files } 个文件暂存在插件回收站里。
unfiled-erased-trash-item = 把条目移进回收站（文件随之进它自己的插件回收站文件夹）
unfiled-erased-erase-item = 彻底删除条目和文件（不经过回收站，不能恢复）
unfiled-erased-keep =保留条目和文件（文件放到 literature 根目录，与 Attanger 对不在任何 collection 中的条目的放法一致）
unfiled-item = 「{ $title }」刚从「{ $collections }」移除，有 { $files } 个文件。
unfiled-cancel = 取消：加回「{ $collections }」
unfiled-trash-item = 把条目移进回收站（文件随之进插件回收站；还原时回到原来的 collection）
unfiled-trash-files =
    { $annotations ->
        [0] 保留条目，删除文件（附件移进回收站，清空回收站时删除）
       *[other] 保留条目，删除文件（附件移进回收站，含 { $annotations } 条批注，清空回收站时删除）
    }
unfiled-cancel-all = 全部按默认处理
unfiled-apply = 执行
