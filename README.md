# Set 16 Notes

A simple Electron desktop application for taking and organizing Teamfight Tactics (TFT) Set 16 notes and planning compositions.

## Features

- Clean, responsive UI with sidebar navigation
- Add, edit, and delete custom compositions (comps)
- Each comp supports a title, notes, and an editable list of items
- Powerful search for comps and notes
- Planner interface: input your items to find matching comps
- Auto-saves notes and comp changes to a local JSON file as you type
- All data is stored locally (no cloud or external database)

## Setup

1. Install dependencies:
```bash
npm install
```

2. Run the app:
```bash
npm start
```

## Project Structure

```
set16/
 ├─ package.json
 ├─ main.js
 ├─ /renderer
 │    ├─ index.html
 │    ├─ style.css
 │    └─ renderer.js
 └─ /data
      └─ notes.json (auto-created)
```

## Notes Storage

Notes and comps are automatically saved to `/data/notes.json`. The file structure is:
```json
{
  "comp1": {
    "notes": "...",
    "items": ["Sword", "Bow", ...]
  },
  "comp2": {
    "notes": "...",
    "items": ["Sword", "Rod", ...]
  }
  // ...
}
```

## Tech Stack

- Electron
- Vanilla JavaScript
- HTML/CSS
- Node.js fs module for file storage

## Building an Executable

To package the app as an installer or executable, use a tool like `electron-builder`. See the project context or ask for instructions if needed.


