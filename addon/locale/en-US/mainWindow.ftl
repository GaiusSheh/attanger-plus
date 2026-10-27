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
# Shown after the unfiled window has closed, so it lives here (src/ui/unfiled.ts).
unfiled-done = Put back: { $cancelled } item(s); moved to the trash: { $trashedItems } item(s); files deleted: { $trashedFiles } item(s); deleted for good: { $erasedItems } item(s); kept with their files in the root: { $kept } item(s).
unfiled-dry-run = Dry-run mode is on: the changes in Zotero were made, but files were only logged, not moved.
menu-remove-current =
    .label = Remove from Current Collection
menu-remove-all =
    .label = Remove from All Collections
menu-remove-chosen =
    .label = Remove from Chosen Collections…
remove-confirm-current =
    { $count ->
        [one] Remove the item from “{ $collection }”? Its copy in that folder is deleted; if it is in no other collection, you are asked next what to do with its files.
       *[other] Remove { $count } items from “{ $collection }”? Their copies in that folder are deleted; for items in no other collection, you are asked next what to do with their files.
    }
remove-confirm-all =
    { $count ->
        [one] Remove the item from all its collections? It will be in no collection; you are asked next what to do with its files.
       *[other] Remove { $count } items from all their collections? They will be in no collection; you are asked next what to do with their files.
    }
# Notifications after copy maintenance (src/ui/toast.ts).
toast-headline = Attanger Plus
toast-headline-dry-run = Attanger Plus (dry run, nothing done)
toast-line = { $title }: { $actions }
toast-separator = { ", " }
toast-item-copied =
    { $count ->
        [one] copied to 1 folder
       *[other] copied to { $count } folders
    }
toast-item-deleted =
    { $count ->
        [one] 1 copy deleted
       *[other] { $count } copies deleted
    }
toast-item-renamed =
    { $count ->
        [one] 1 copy renamed
       *[other] { $count } copies renamed
    }
toast-item-trashed =
    { $count ->
        [one] 1 file moved to the plugin trash
       *[other] { $count } files moved to the plugin trash
    }
toast-item-restored =
    { $count ->
        [one] 1 file back from the plugin trash
       *[other] { $count } files back from the plugin trash
    }
toast-item-purged = files in the plugin trash deleted
toast-collection-moved = folder moved from { $from }
toast-collection-files-moved =
    { $count ->
        [one] 1 file moved into the folder
       *[other] { $count } files moved into the folder
    }
toast-collection-trashed = folder moved to the plugin trash
toast-collection-restored = folder back from the plugin trash
toast-collection-purged = folder deleted from the plugin trash
toast-gone =
    { $count ->
        [one] 1 item deleted for good: its files in the plugin trash were deleted
       *[other] { $count } items deleted for good: their files in the plugin trash were deleted
    }
toast-more =
    { $count ->
        [one] … and 1 more
       *[other] … and { $count } more
    }
toast-problems =
    { $count ->
        [one] 1 step was not done; see the check report
       *[other] { $count } steps were not done; see the check report
    }
