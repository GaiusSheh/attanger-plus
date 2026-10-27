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
changes-repair-heading = These problems from the check report can be repaired in one click. “Repair” is chosen; switch to “Handle manually” for any you want to leave. Files moved away go to the plugin trash’s _orphans folder and are removed when Zotero’s trash would be.
changes-section-trash = Plugin trash out of step ({ $count })
changes-section-misplaced = Misplaced files ({ $count })
changes-section-orphan = Orphaned files ({ $count })
changes-section-stray = Stray folders ({ $count })
changes-fix = Repair
changes-repair-trash-outside =
    { $count ->
        [one] “{ $title }” is in the trash, but its file is still in a collection folder. Repair: move it to the plugin trash (as when deleting the item).
       *[other] “{ $title }” is in the trash, but its { $count } files are still in collection folders. Repair: move them to the plugin trash (as when deleting the item).
    }
changes-repair-trash-live = “{ $title }” is out of the trash, but its files are still in the plugin trash ({ $path }, { $count } files). Repair: put them back into its collection folders (as when restoring).
changes-repair-trash-gone = { $path } in the plugin trash ({ $count } files) belongs to no item in the library; the item may have been deleted for good. Repair: move it to _orphans, removed in due course.
changes-repair-collection-live = The collection “{ $collection }” is out of the trash, but its folder is still in the plugin trash ({ $count } files). Repair: move it back (as when restoring).
changes-repair-collection-gone = { $path } in the plugin trash ({ $count } files) belongs to a collection deleted for good. Repair: as when deleting it for good — files other items still use go to them; items only in it are asked about.
changes-repair-misplaced = The file of “{ $title }” is not in its collection folders: { $path }. Repair: move it to { $folder }, relink, and make the other copies; the old one goes to _orphans.
changes-repair-outside = The file of “{ $title }” is outside the files root: { $path }. Repair: copy it to { $folder } (the original stays), relink, and make the other copies.
changes-repair-orphan-copy = { $path }: no attachment uses it; same content as { $copy }. Repair: move it to _orphans.
changes-repair-orphan-unique = { $path }: no attachment uses it, and its content is nowhere else. Repair: move it to _orphans.
changes-repair-stray = { $path } ({ $count } files): no collection has this folder. Repair: remove it once the files in it are dealt with (it stays if any are left).
