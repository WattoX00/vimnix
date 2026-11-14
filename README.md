# vnotes

A tiny desktop-only notes site with vim keys. Notes are plain `.txt` files in a **private GitHub repo**; the site itself is static and runs on GitHub Pages. No server, no build step.

## Setup

1. **Notes repo (private).** Create e.g. `notes` and initialise it with a README so the branch exists.
2. **Token.** GitHub → Settings → Developer settings → Fine-grained tokens → Generate.
   Repository access: *Only select repositories* → your notes repo.
   Permissions: **Contents: Read and write** (Metadata: read is added automatically).
3. **Site repo.** Put `index.html`, `style.css`, `vim.js`, `app.js` in a repo (e.g. `vnotes`), then Settings → Pages → deploy from the `main` branch, `/ (root)`.
   Pages on the free plan needs this repo to be public — that's fine, it holds no secrets; your notes live in the other, private repo.
4. Open the site, enter `owner/notes` and the token. They are saved in this browser's localStorage, so you only do this once. *Log out* wipes them.

## How it behaves

- Notes are saved to GitHub **only** when you save (`:w` or `Ctrl-S`). One API call per save, one per opened note (cached afterwards), one for the list.
- Switching notes or logging out with unsaved changes asks: Save / Discard / Cancel.
- Closing the tab with unsaved changes triggers the browser's own "Leave site?" prompt (browsers don't allow custom dialogs there).
- If a note was changed on GitHub since you opened it, saving fails with a conflict message; `:e!` reloads it.
- New notes exist locally until the first save. `Refresh` (↻) re-reads the list.
- Optional **Folder** on the login form keeps notes in a subfolder of the repo.

## Keys

Everything works from the keyboard, with or without a note open (`:help` lists the keys).

- `Space Space` — fuzzy note picker (`↑↓` or `Ctrl-n/p`, `Enter` opens; if nothing matches, `Enter` creates that note).
- `Space e` — show the sidebar and focus it; press again to hide it. The file list is cached in memory, so toggling never re-fetches (use ↻ to re-read it).
- In the sidebar: `j k g G` move, `Enter` open, `a` new note, `d` delete, `Esc` back to the editor.
- `:new name` / `:e name` create (or open) `name.txt`; `:ls` opens the picker.

Editor keys, short version: `h j k l w b e 0 ^ $ gg G { }`, `i a I A o O`, `x X D C s S J r`, `d y c` + motion (`dw`, `d$`, `cw`, `ciw`, `3dd`, `yy`), `p P`, `u` / `Ctrl-r`, `v V` + `d y c`, `/text` `n N`, `:w :q :wq :q! :e! :12`.

## Security notes

The token lives in localStorage, so use it only on your own machine and keep it scoped to the one notes repo with just Contents access. If it leaks, revoke it in GitHub settings.
