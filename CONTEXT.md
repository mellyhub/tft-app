# Project: Set 16 – Minimal Electron App

## Purpose
Lightweight desktop app for taking and organizing notes and planning compositions for Teamfight Tactics (TFT) Set 16. Uses local JSON storage and a simple renderer (vanilla HTML/CSS/JS).

## Requirements
- Electron + Node.js.
- Renderer: plain HTML/CSS/JS with nodeIntegration (for fs, path, clipboard, ipcRenderer).
- Local storage: /data/notes.json and /data/images for pasted/imported images.
- Keep UI minimal and easy to modify.

## Core Functionality (current)
- Single BrowserWindow (approx. 1000x700).
- Sidebar with searchable list of compositions (comps).
- Main notes editor per comp (contenteditable), and an items input per comp.
- Planner view to match user items to comps.
- Auto-save edits (debounced, 500ms).
- Image support: paste images into editor → saved to /data/images via IPC; editor stores image tags with relative paths.
- Clipboard export/import: copy current or all comps to clipboard as a single JSON blob that embeds images as base64, and import from such JSON (writes images to /data/images, renames on collision, merges comps into notes.json).
- Each comp includes a lastEdited ISO timestamp; timestamps shown in sidebar and main view and updated on changes.

## Data format (current)
notes.json stores comps as a plain object keyed by comp name. Example:
```json
{
  "blade-ace": {
    "notes": "<p>Some HTML notes with images using ../data/images/img.png</p>",
    "items": ["Sword", "Bow"],
    "lastEdited": "2025-11-24T00:00:00.000Z"
  },
  "mage-lane": {
    "notes": "",
    "items": [],
    "lastEdited": "2025-11-24T00:00:00.000Z"
  }
}
```

## File structure
set16/
- package.json
- main.js (provides save-image and export/import IPC handlers)
- /renderer
  - index.html
  - style.css
  - renderer.js (UI logic, clipboard export/import, paste handling, lastEdited handling)
- /data
  - notes.json (auto-created)
  - /images (saved pasted/imported images)

## Developer notes
- Clipboard JSON export/import embeds images as base64; convenient for single copy/paste flows but can create large clipboard payloads.
- Imported images are written to /data/images; names are collision-safe (renamed if needed) and notes HTML is updated best-effort to point to the new filenames.
- The renderer expects a main process IPC handler 'save-image' to persist pasted images; ensure main.js implements this.
- Restart the app after pulling changes so IPC handlers and renderer changes are active.

## Running
- npm install (if dependencies added)
- npm start