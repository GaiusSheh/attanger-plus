changes-window-title = Attanger Plus — Changes Made Outside Zotero
changes-heading = These files were changed or deleted outside Zotero. Choose what to do with each, then click Apply (available once something is changed). “Handle manually”: nothing now, asked again next time; “Ignore”: no more automatic prompts, though the check report and this window still list it.
changes-section-differ = Copies with different content ({ $count })
changes-section-missing = Deleted copies ({ $count })
changes-section-all-missing = All copies gone ({ $count })
changes-ignored-tag = (ignored)
changes-manual = Handle manually
changes-ignore = Ignore
changes-differ-item = The { $count } copies of “{ $title }” are not the same.
changes-differ-sync = Sync: keep the selected copy and overwrite the checked ones (old versions go to the plugin trash and are removed when Zotero’s trash would be)
changes-col-source = Keep
changes-col-target = Overwrite
changes-col-file = File
changes-col-modified = Modified
changes-col-size = Size
changes-missing-item = The file of “{ $title }” in “{ $collection }” is gone (expected at: { $file }). It can be restored from: { $source }
changes-missing-remove = Remove from “{ $collection }”
changes-missing-restore = Restore from Another Copy
changes-all-missing-item = The file of “{ $title }” is in none of its collection folders (Zotero expected it at: { $file }). The item stays; the check reports its file as missing.
changes-relocate = Locate…
changes-trash-attachment =
    { $annotations ->
        [0] Delete this attachment (to the trash)
        [one] Delete this attachment (to the trash, with 1 annotation)
       *[other] Delete this attachment (to the trash, with { $annotations } annotations)
    }
changes-trash-item = Delete the whole item (to the trash)
changes-relocate-title = Choose the file of “{ $title }”
changes-relocate-picked = Will copy: { $file } (the original stays)
changes-close = Close
changes-apply = Apply
