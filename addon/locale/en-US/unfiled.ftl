unfiled-window-title = Attanger Plus — Items in No Collection
unfiled-heading = These items are in no collection now: they were just removed from their last one, or their only collection was deleted for good. Their files have no copy anywhere else. Choose what to do with each, then click Apply. Closing the window applies the default choice to all.
unfiled-erased-item = The collection “{ $collection }” of “{ $title }” was deleted for good; its { $files } file(s) wait in the plugin trash.
unfiled-erased-trash-item = Move the item to the trash (its files go to its own plugin trash folder)
unfiled-erased-erase-item = Delete the item and its files for good (not through the trash; cannot be undone)
unfiled-erased-keep =Keep the item and its files (the files go to the root of the files folder, where Attanger puts the files of items in no collection)
unfiled-item = “{ $title }” was just removed from “{ $collections }” and has { $files } file(s).
unfiled-cancel = Cancel: put it back into “{ $collections }”
unfiled-trash-item = Move the item to the trash (its files go to the plugin trash; restoring puts it back into its collections)
unfiled-trash-files =
    { $annotations ->
        [0] Keep the item, delete its files (attachments go to the trash and are deleted when it is emptied)
       *[other] Keep the item, delete its files (attachments, with { $annotations } annotation(s), go to the trash and are deleted when it is emptied)
    }
unfiled-cancel-all = Use Defaults for All
unfiled-apply = Apply
