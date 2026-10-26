startup-loaded = { $name } { $version } loaded
menu-check =
    .label = Attanger Plus: Check Library…
menu-reveal =
    .label = Show File in Current Collection Folder
reveal-missing-copy = There is no copy of “{ $file }” in the folder of “{ $collection }”.
reveal-missing-file = The file does not exist: { $file }
reveal-restore-prompt =
    { $count ->
        [one] It can be restored from another copy of the file.
       *[other] { $count } of them can be restored from another copy of the file.
    }
reveal-restore-button = Restore from Another Copy
reveal-restore-dry-run = Dry-run mode: nothing was restored; the operations were written to the operation log.
reveal-restore-failed = Could not restore “{ $file }”; see the operation log for why.
changes-dry-run = Dry-run mode: the file operations (restore, sync, locate) were not carried out but written to the operation log; changes in Zotero (removal from a collection, moving to the trash, ignoring) took effect.
changes-done = Done: { $restored } copies restored, { $removed } removed from a collection, { $synced } copies synced, { $relocated } files located, { $trashed } moved to the trash, { $ignored } ignored.
changes-failed =
    { $count ->
        [one] One step could not be completed; see the operation log for why.
       *[other] { $count } steps could not be completed; see the operation log for why.
    }
menu-remove-current =
    .label = Remove from Current Collection
menu-remove-all =
    .label = Remove from All Collections
menu-remove-chosen =
    .label = Remove from Chosen Collections…
remove-confirm-current =
    { $count ->
        [one] Remove the item from “{ $collection }”? Its copy in that folder is deleted; if it is in no other collection, its file stays where it is for now.
       *[other] Remove { $count } items from “{ $collection }”? Their copies in that folder are deleted; items in no other collection keep their files where they are for now.
    }
remove-confirm-all =
    { $count ->
        [one] Remove the item from all its collections? It will be in no collection; its files stay where they are for now.
       *[other] Remove { $count } items from all their collections? They will be in no collection; their files stay where they are for now.
    }
