report-window-title = Attanger Plus — Library Check
report-heading = Library check
report-running = Checking the library…
report-failed = The check failed: { $message }
report-rerun = Check again
report-changes = Handle File Changes…
report-changes-none = No file changes to handle (deleted copies, copies with different content).
report-export = Export as Markdown…
report-export-title = Export the check report
report-root = Files root: { $root }
report-summary = { $problems } problems · { $notices } notices · { $items } items · { $files } files · { $seconds } s
report-clean = Everything matches. No problems found.
report-config = Settings
report-severity-problem = Problem
report-severity-notice = Notice
report-show = Show
report-generated = Generated { $date }

config-root-unset = Zotero’s base directory for linked files is not set (Settings → Advanced → Files and Folders), so only the library was checked.
config-root-missing = The files root { $detail } does not exist, so only the library was checked.
config-attanger-not-linked = Attanger is not in “linked” mode ({ $detail }); its folders may not follow the collections.
config-attanger-subfolder-format = Attanger’s subfolder format is “{ $detail }” rather than “{ "{{collection}}" }”; its folders may not follow the collections.
config-attanger-dest-differs = Attanger’s destination folder { $detail } is not the files root.

check-C1 = Items in no collection
check-C2 = Items directly in a collection that has subcollections
check-C3 = Missing files
check-C4 = Missing or differing copies
check-C5 = Files outside the item’s collection folders
check-C6 = Files stored inside Zotero
check-C7 = Orphan files
check-C8 = Folders without a collection
check-C9 = Empty collections and collections without a folder
check-C10 = Possible duplicate items
check-C11 = Web page items of articles already in the library
check-C12 = Unusual file names
check-C14 = Plugin trash out of step with Zotero’s trash

issue-C1-unfiled = Not in any collection
issue-C2-in-parent-collection = In “{ $collection }”, which has subcollections
issue-C3-no-path = The attachment has no file path
issue-C3-all-missing = { $path } is missing, and no copy is left
issue-C3-pointed-missing = { $path } is missing; copies remain: { $related }
issue-C4-copy-missing = No copy in “{ $collection }”: { $path }
issue-C4-copy-differs = The copy in “{ $collection }” differs from { $related }: { $path }
issue-C5-misplaced = { $path } is not in the item’s collection folders ({ $related })
issue-C5-outside-root = { $path } is outside the files root
issue-C6-stored = Stored file “{ $related }”
issue-C6-snapshot = Web snapshot “{ $related }”
issue-C7-orphan-copy = { $path } — a copy of { $related }
issue-C7-orphan-unique = { $path } — not a copy of any attachment
issue-C8-stray-folder = { $path } ({ $count ->
        [one] 1 file
       *[other] { $count } files
    })
issue-C9-empty = “{ $collection }” has no items
issue-C9-no-folder = “{ $collection }” has no folder ({ $path })
issue-C10-same-doi = Same DOI as: { $related }
issue-C10-same-title = Same title as: { $related }
issue-C11-webpage-of-article = The article is in the library: { $related }
issue-C12-download-suffix = { $path } looks like a repeated download
issue-C12-name-template = { $path } does not follow the naming template (expected “{ $related }”)
issue-C14-trash-without-item = { $path } ({ $count ->
        [one] 1 file
       *[other] { $count } files
    }) belongs to no item in Zotero’s trash
issue-C14-trashed-file-outside-trash = { $path } belongs to an item in Zotero’s trash
