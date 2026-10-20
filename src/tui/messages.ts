// Dialog wording, verbatim. Short titles stay next to the dialog that shows them.

export const MAIN_MENU_TEXT = {
  noneSelected: "Manage saved definitions; only explicit selection activates a workspace.",
  stoppedHint:
    "Reopen the menu to reconcile saved state; do not blindly repeat a timed-out mutation.",
} as const

export const CHOOSE_TEXT = {
  noFoldersToRemove: "No saved workspace has folders to remove.",
  createFirst: "Create a workspace first, then add folders.",
} as const

export const ATTACH_TEXT = {
  cannotAttach:
    "This session has started or cannot be safely attached. Its context stays unchanged; open the saved workspace in a new empty session.",
  explicitSelection:
    "Explicitly select this workspace in an empty session. No prompt will be sent.",
} as const

export const CREATE_TEXT = {
  invalidName: "Use a printable name of 1–100 characters, without reserved object-property names.",
} as const

export const ADD_FOLDER_TEXT = {
  addCurrentFolder: "Its AGENTS.md may guide the agent; this is not tool approval",
  pastePath: "Server filesystem; supports spaces, ~ and $HOME. Browsing does not add a folder.",
  alreadyAdded: "This canonical folder is already registered in the saved workspace.",
  alias: "Lowercase letters, digits, - or _. Saved edits do not retarget existing sessions.",
  invalidAlias: "Use lowercase letters, digits, - or _. The folder path has been preserved.",
  folderSaved:
    "Existing session roots are unchanged until you explicitly apply the saved definition.",
} as const

export const REMOVE_FOLDER_TEXT = {
  confirm: "Remove this saved folder registration only. Existing sessions and files are unchanged.",
} as const

export const DELETE_TEXT = {
  confirm:
    "Only the saved definition is removed. Existing sessions retain their pinned roots. No files are deleted.",
} as const

export const STATUS_TEXT = {
  instructionsReady: "Ready at the last model request.",
  instructionsBlocked: "Blocked at the last request; check source/budget or permission errors.",
  instructionsNotLoaded: "Not loaded yet; the next request uses session permissions.",
  selectionFixed: "Selection is fixed. Switch or apply saved changes in a new session.",
  selectionEditable: "Saved changes can be applied before starting work.",
  savedDeleted: "Saved definition was deleted; this session retains its pinned folders.",
  noneSelected:
    "No workspace selected. Native OpenCode behavior remains unchanged. Creating or editing a saved definition does not activate it; explicitly select one in an empty or new session.",
} as const

export function savedRevisionText(saved: number, pinned: number) {
  return `Saved definition is revision ${saved}; this session retains revision ${pinned}.`
}
