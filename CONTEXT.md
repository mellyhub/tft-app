# Project: Set 16 – Minimal Electron App

# Purpose

Create a lightweight desktop application for taking and organizing notes and planning compositions for Teamfight Tactics (TFT) Set 16.

The app is clean, simple, and fast, with no external database. Local JSON files are used for all storage.

# Requirements

- Built with Electron using Node.js.
- Use only vanilla HTML, CSS, and JavaScript in the renderer.
- Use JSON file storage located in /data/notes.json.
- No external state libraries, frameworks, or databases.

# Core Functionality

1. Launch a single BrowserWindow (approx. 1000x700).
2. UI Layout:
   - Sidebar with a list of compositions (comps) and navigation buttons.
   - Main view for editing notes and comp details.
   - Planner interface for searching and matching item compositions.
3. Notes and Compositions:
   - Automatically load notes and comps from notes.json on app start.
   - Auto-save edits with each input event.
   - Each comp supports a title, notes, and an editable list of items.
4. JSON file format:
   ```json
   {
     "comps": [
       {
         "title": "...",
         "notes": "...",
         "items": ["Sword", "Bow", ...]
       },
       ...
     ]
   }
   ```
5. If notes.json doesn't exist, create it using default values.

# File Structure

set16/
 ├─ package.json
 ├─ main.js
 ├─ /renderer
 │    ├─ index.html
 │    ├─ style.css
 │    └─ renderer.js
 └─ /data
      └─ notes.json (auto-created)

# Coding Rules

- Enable nodeIntegration and disable contextIsolation for simplicity in the renderer.
- Use fs and path from Node.js for reading/writing JSON.
- Keep all code easy to modify and beginner-friendly.
- Prefer simplicity over optimization in this phase.
- Avoid unnecessary abstractions or splitting files further.

# Deliverables

- Fully generate or update all files needed for the project.
- Ensure the app is runnable via `npm start`.
- Keep UI minimal, clean, and functional.
- Ensure no missing imports, paths, or config issues.

# Features Added (Current Iteration)

- Sidebar navigation for compositions.
- Search functionality for compositions.
- Planner interface for matching item sets to comps.
- Editable item lists for each comp.
- Responsive and scrollable UI for both sidebar and main content.
- All changes persist to disk in notes.json.

# Future Expansion (Not needed now, just for agent awareness)

- Tabs, hotkeys, richer UI, drag-and-drop images, integration with TFT data.

