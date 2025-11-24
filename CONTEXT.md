# Project: Set 16 – Minimal Electron App

## Purpose
Lightweight desktop app for taking and organizing notes and planning compositions for Teamfight Tactics (TFT) Set 16. Uses local JSON storage and a simple renderer (vanilla HTML/CSS/JS).

## Recent changes
- Native confirmation dialogs for destructive actions:
  - Deletion now prompts a native OS dialog (via Electron dialog.showMessageBox).
  - If the native dialog fails, the in-app confirmation modal is used as a fallback.
  - Deletion logic preserved (prevents deleting the last comp, saves before delete, merges UI updates).
- (Other features retained: lastEdited timestamps, image paste/save, clipboard export/import, tag system.)

## Running
- npm start
- Deleting a comp will show a native confirmation dialog; confirm to proceed.