const fs = require('fs');
const path = require('path');
const { ipcRenderer, clipboard, shell } = require('electron');


// ===== Logging / Error handling configuration =====
const LOG_DIR = path.join(__dirname, '..', 'data', 'logs');
const LOG_FILE = path.join(LOG_DIR, 'renderer.log');
const LOG_MAX_BYTES = 200 * 1024; // 200KB simple rotation threshold

function ensureLogDir() {
    try {
        if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
    } catch (err) {
        console.warn('Could not create log dir', err);
    }
}

function writeLog(level, msg, meta) {
    const time = new Date().toISOString();
    const metaStr = meta ? (typeof meta === 'string' ? meta : JSON.stringify(meta)) : '';
    const entry = `${time} [${level.toUpperCase()}] ${msg}${metaStr ? ' | ' + metaStr : ''}\n`;
    try {
        ensureLogDir();
        fs.appendFileSync(LOG_FILE, entry, 'utf8');
        // simple rotation
        try {
            const stats = fs.statSync(LOG_FILE);
            if (stats.size > LOG_MAX_BYTES) {
                const archive = LOG_FILE + '.' + Date.now();
                fs.renameSync(LOG_FILE, archive);
            }
        } catch (_) {}
    } catch (e) {
        // fallback to console if file write fails
        console[level === 'error' ? 'error' : (level === 'warn' ? 'warn' : 'log')](entry, e);
    }
    // mirror to console
    console[level === 'error' ? 'error' : (level === 'warn' ? 'warn' : 'log')](entry);
}

function logDebug(msg, meta) { writeLog('debug', msg, meta); }
function logInfo(msg, meta) { writeLog('info', msg, meta); }
function logWarn(msg, meta) { writeLog('warn', msg, meta); }
function logError(msg, meta) { writeLog('error', msg, meta); }

// Global error handlers
window.addEventListener('error', (ev) => {
    try {
        logError('Uncaught error', { message: ev.message, filename: ev.filename, lineno: ev.lineno, colno: ev.colno, stack: ev.error && ev.error.stack });
    } catch (e) {
        console.error('Error while logging uncaught error', e);
    }
});

window.addEventListener('unhandledrejection', (ev) => {
    try {
        logError('Unhandled promise rejection', { reason: ev.reason && (ev.reason.stack || ev.reason) });
    } catch (e) {
        console.error('Error while logging unhandled rejection', e);
    }
});

// Small user toast for non-blocking notifications
function showToast(text, type = 'info') {
    try {
        let t = document.getElementById('app-toast');
        if (!t) {
            t = document.createElement('div');
            t.id = 'app-toast';
            t.style.position = 'fixed';
            t.style.right = '12px';
            t.style.top = '12px';
            t.style.zIndex = '10000';
            t.style.minWidth = '200px';
            t.style.padding = '8px 12px';
            t.style.borderRadius = '6px';
            t.style.boxShadow = '0 2px 6px rgba(0,0,0,0.15)';
            t.style.fontSize = '0.9rem';
            t.style.transition = 'opacity 0.3s ease';
            document.body.appendChild(t);
        }
        t.textContent = text;
        t.style.background = type === 'error' ? '#ffdddd' : (type === 'warn' ? '#fff8e1' : '#e6ffed');
        t.style.border = type === 'error' ? '1px solid #f44336' : (type === 'warn' ? '1px solid #ffb74d' : '1px solid #8bc34a');
        t.style.color = '#222';
        t.style.opacity = '1';
        // hide after 4s
        setTimeout(() => { if (t) t.style.opacity = '0'; }, 4000);
    } catch (e) {
        logWarn('showToast failed', e);
    }
}

// Helper wrapper for IPC with logging
async function safeInvoke(channel, ...args) {
    try {
        logDebug(`ipc invoke ${channel}`, args);
        const res = await ipcRenderer.invoke(channel, ...args);
        logDebug(`ipc response ${channel}`, res);
        return res;
    } catch (err) {
        logError(`IPC ${channel} failed`, err && (err.stack || err.message || err));
        showToast('Ett fel uppstod internt. Se loggfil.', 'error');
        throw err;
    }
}


// Path to notes.json in /data directory (relative to project root)
const NOTES_FILE = path.join(__dirname, '..', 'data', 'notes.json');
const SAVE_DELAY = 500; // milliseconds

let saveTimeout = null;
let currentComp = null;
let notesData = {};
let searchQuery = '';
let activeTagFilter = '';
let toolbarResizeObserver = null; // added: observer to keep toolbar/log button layout in sync

// System messages (Swedish only)
const SYSTEM_MESSAGES = {
    noResults: 'Inga resultat hittades',
    noCompsMatch: 'Inga kompositioner matchar dina items.',
    enterItems: 'Ange items för att se matchande kompositioner.',
    addCompExists: 'En komposition med det namnet finns redan.',
    deleteLastComp: 'Du kan inte ta bort den sista kompositionen.',
    deleteConfirm: (comp) => `Är du säker på att du vill ta bort "${capitalizeCompName(comp)}"?`,
    saved: 'Sparat!'
};

// Get comp order from notesData keys, sorted alphabetically
function getCompOrder() {
    const comps = Object.keys(notesData);
    const sorted = comps.sort((a, b) => a.localeCompare(b));
    return sorted;
}

// Format ISO date to locale string (safe)
function formatDate(iso) {
    if (!iso) return '';
    try {
        return new Date(iso).toLocaleString();
    } catch {
        return iso;
    }
}

// Ensure a comp entry is an object with notes, items and lastEdited
function normalizeNotesData() {
    const keys = Object.keys(notesData);
    keys.forEach(k => {
        const val = notesData[k];
        if (val && typeof val === 'object') {
            if (!('notes' in val)) val.notes = '';
            if (!Array.isArray(val.items)) val.items = [];
            if (!Array.isArray(val.tags)) val.tags = [];
            if (!val.lastEdited) val.lastEdited = new Date().toISOString();
        } else {
            notesData[k] = {
                notes: typeof val === 'string' ? val : '',
                items: [],
                tags: [],
                lastEdited: new Date().toISOString()
            };
        }
    });
}

// Load notes from JSON file
function loadNotes() {
    try {
        const dataDir = path.dirname(NOTES_FILE);
        if (!fs.existsSync(dataDir)) {
            fs.mkdirSync(dataDir, { recursive: true });
        }
        
        if (fs.existsSync(NOTES_FILE)) {
            const data = fs.readFileSync(NOTES_FILE, 'utf8');
            notesData = JSON.parse(data);
            if (!notesData || typeof notesData !== 'object') notesData = {};
            normalizeNotesData();
        } else {
            notesData = {};
            fs.writeFileSync(NOTES_FILE, JSON.stringify(notesData, null, 2), 'utf8');
        }
    } catch (error) {
        logError('Error loading notes:', error);
        notesData = {};
    }
}

// Save notes to JSON file (also updates lastEdited for current comp)
function saveNotes() {
    if (!currentComp) return;
    try {
        const editorDiv = document.getElementById('comp-notes-editor');
        const notesContent = editorDiv ? editorDiv.innerHTML : '';
        
        if (notesData[currentComp] && typeof notesData[currentComp] === 'object') {
            notesData[currentComp].notes = notesContent;
            notesData[currentComp].lastEdited = new Date().toISOString();
        } else {
            notesData[currentComp] = {
                notes: notesContent,
                items: [],
                lastEdited: new Date().toISOString()
            };
        }

        const dataDir = path.dirname(NOTES_FILE);
        if (!fs.existsSync(dataDir)) {
            fs.mkdirSync(dataDir, { recursive: true });
        }
        fs.writeFileSync(NOTES_FILE, JSON.stringify(notesData, null, 2), 'utf8');

        createNavigation();

        const mainMeta = document.getElementById('current-comp-meta');
        if (mainMeta) {
            mainMeta.textContent = `Last edited: ${formatDate(notesData[currentComp].lastEdited)}`;
        }
    } catch (error) {
        logError('Error saving notes:', error);
    }
}

// Debounced save function
function debouncedSave() {
    if (saveTimeout) {
        clearTimeout(saveTimeout);
    }
    
    saveTimeout = setTimeout(() => {
        saveNotes();
    }, SAVE_DELAY);
}

// Capitalize first letter of each word
function capitalizeCompName(comp) {
    return comp.split(' ').map(word => 
        word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()
    ).join(' ');
}

// Strip HTML tags for searching plain text inside saved notes
function stripHtml(html) {
    if (!html || typeof html !== 'string') return '';
    return html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
}

// Split search query into tokens (ignore empty tokens)
function getSearchTokens(query) {
    if (!query || typeof query !== 'string') return [];
    return query
        .toLowerCase()
        .split(/\s+/)
        .map(t => t.trim())
        .filter(Boolean);
}

// Check if a composition matches the search query (all tokens must match somewhere)
function compMatchesSearch(comp, query) {
    if (!query || query.trim() === '') return true;
    const tokens = getSearchTokens(query);
    if (tokens.length === 0) return true;

    const compName = (comp || '').toLowerCase();
    const compData = notesData[comp] && typeof notesData[comp] === 'object' ? notesData[comp] : null;
    const notesText = compData ? stripHtml(compData.notes || '') : (notesData[comp] || '').toLowerCase();
    const items = compData && Array.isArray(compData.items) ? compData.items.map(i => (i || '').toLowerCase()) : [];
    const tags = compData && Array.isArray(compData.tags) ? compData.tags.map(t => (t || '').toLowerCase()) : [];

    return tokens.every(token => {
        if (compName.includes(token)) return true;
        if (notesText.includes(token)) return true;
        if (items.some(i => i.includes(token))) return true;
        if (tags.some(t => t.includes(token))) return true;
        return false;
    });
}

// Highlight all search tokens in a given text (returns HTML with <mark class="search-highlight">)
function highlightSearchMatches(text, query) {
    if (!query || query.trim() === '') return escapeHtml(text);
    const tokens = getSearchTokens(query);
    if (tokens.length === 0) return escapeHtml(text);

    const escaped = tokens.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    const re = new RegExp(`(${escaped.join('|')})`, 'gi');

    return escapeHtml(text).replace(re, '<mark class="search-highlight">$1</mark>');
}

// Small helper to escape HTML when inserting text into innerHTML (prevents accidental HTML injection)
function escapeHtml(unsafe) {
    return (unsafe || '').toString()
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

// Setup search input behaviour (wire it to createNavigation and allow Enter to select first match)
function setupSearch() {
    const searchInput = document.getElementById('search-input');
    if (!searchInput) return;

    searchInput.addEventListener('input', (e) => {
        searchQuery = e.target.value || '';
        createNavigation();
    });

    searchInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            const compOrder = getCompOrder();
            const first = compOrder.find(c => compMatchesSearch(c, searchQuery));
            if (first) {
                const notesInterface = document.getElementById('notes-interface');
                const plannerInterface = document.getElementById('planner-interface');
                if (notesInterface && plannerInterface) {
                    notesInterface.style.display = '';
                    plannerInterface.style.display = 'none';
                }
                switchToComp(first);
                const editorDiv = document.getElementById('comp-notes-editor');
                if (editorDiv) editorDiv.focus();
            }
        } else if (e.key === 'Escape') {
            if (searchQuery && searchQuery.length > 0) {
                searchQuery = '';
                searchInput.value = '';
                createNavigation();
            }
        }
    });
}

// --- PLANNER UI LOGIC ---
function setupPlannerInterface() {
    const plannerInterface = document.getElementById('planner-interface');
    if (!plannerInterface) return;

    plannerInterface.innerHTML = `
        <div class="tab-content-container">
            <div class="tab-content">
                <div class="tab-header">
                    <h2>Planner</h2>
                </div>
                <div class="planner-controls">
                    <label for="planner-items-input"><strong>Vilka items har du?</strong></label>
                    <input id="planner-items-input" class="planner-items-input" type="text" placeholder="t.ex. Sword, Bow">
                </div>
                <div id="planner-results" class="planner-results"></div>
            </div>
        </div>
    `;

    const itemsInput = document.getElementById('planner-items-input');
    const resultsDiv = document.getElementById('planner-results');

    function updatePlannerResults() {
        const input = itemsInput.value.trim().toLowerCase();
        if (!input) {
            resultsDiv.innerHTML = `<div class="planner-empty-message">${SYSTEM_MESSAGES.enterItems}</div>`;
            return;
        }
        const selectedItems = input.split(',').map(s => s.trim()).filter(Boolean);
        const matchingComps = Object.entries(notesData).filter(([comp, data]) => {
            if (!data || typeof data !== 'object' || !Array.isArray(data.items)) return false;
            return selectedItems.every item => data.items.map(i => i.toLowerCase()).includes(item));
        });
        if (matchingComps.length === 0) {
            resultsDiv.innerHTML = `<div class="planner-empty-message">${SYSTEM_MESSAGES.noCompsMatch}</div>`;
            return;
        }
        resultsDiv.innerHTML = matchingComps.map(([comp, data]) =>
            `<div class="planner-comp-result" data-comp="${comp}">
                <div class="planner-comp-title" style="cursor:pointer; color:#4a9eff; text-decoration:underline;" data-comp="${comp}">${capitalizeCompName(comp)}</div>
                <div class="planner-comp-items">Items: ${data.items.join(', ')}</div>
                <div class="planner-comp-notes">${data.notes.replace(/\n/g, '<br>')}</div>
            </div>`
        ).join('');
        resultsDiv.querySelectorAll('.planner-comp-title').forEach(el => {
            el.addEventListener('click', (e) => {
                const comp = e.target.getAttribute('data-comp');
                if (comp) {
                    document.getElementById('planner-interface').style.display = 'none';
                    document.getElementById('notes-interface').style.display = '';
                    switchToComp(comp);
                }
            });
        });
    }

    itemsInput.addEventListener('input', updatePlannerResults);
    updatePlannerResults();
}

// Setup image paste handler
function setupImagePaste() {
    const editorDiv = document.getElementById('comp-notes-editor');
    if (!editorDiv) return;

    editorDiv.addEventListener('paste', async (e) => {
        e.preventDefault();

        const items = e.clipboardData.items;
        let imageFound = false;

        for (let i = 0; i < items.length; i++) {
            if (items[i].type.indexOf('image') !== -1) {
                imageFound = true;
                const blob = items[i].getAsFile();
                const reader = new FileReader();

                reader.onload = async (event) => {
                    const base64data = event.target.result.split(',')[1];
                    const timestamp = Date.now();
                    const filename = `image-${timestamp}.png`;

                    try {
                        const result = await safeInvoke('save-image', base64data, filename);
                        if (result && result.success) {
                            const imgPath = `../data/images/${filename}`;
                            const imgTag = `<img src="${imgPath}" alt="pasted-image" style="max-width:100%; border-radius:4px; margin:0.5rem 0;">`;
                            document.execCommand('insertHTML', false, imgTag);
                            debouncedSave();
                        } else {
                            logWarn('save-image responded with failure', result);
                            alert('Could not save image.');
                        }
                    } catch (error) {
                        logError('Error saving image via IPC', error);
                        alert('Failed to save image: ' + (error && error.message ? error.message : String(error)));
                    }
                };

                reader.readAsDataURL(blob);
            }
        }

        if (!imageFound) {
            const text = e.clipboardData.getData('text/plain');
            document.execCommand('insertText', false, text);
        }
    });
}

// ===== Clipboard export/import (JSON with embedded base64 images) =====

// Export comps (all or current) to clipboard as JSON including images
async function exportCompsToClipboard(all = true) {
    try {
        const exportObj = { comps: {}, images: {} };
        const comps = all ? notesData : (currentComp ? { [currentComp]: notesData[currentComp] } : {});
        exportObj.comps = comps;

        const imagesDir = path.join(__dirname, '..', 'data', 'images');
        if (fs.existsSync(imagesDir) && fs.statSync(imagesDir).isDirectory()) {
            const files = fs.readdirSync(imagesDir);
            for (const f of files) {
                try {
                    const buf = fs.readFileSync(path.join(imagesDir, f));
                    exportObj.images[f] = buf.toString('base64');
                } catch (err) {
                    logWarn('Failed to read image for clipboard export:', f);
                }
            }
        }

        clipboard.writeText(JSON.stringify(exportObj));
        alert('Kompositioner kopierade till urklipp (inkl. bilder).');
    } catch (error) {
        logError('Clipboard export failed', error);
        alert('Export misslyckades: ' + (error && error.message ? error.message : String(error)));
    }
}

// Import comps (and images) from clipboard JSON
async function importCompsFromClipboard() {
    try {
        const txt = clipboard.readText();
        if (!txt) {
            alert('Urklipp tomt eller innehåller inte giltig data.');
            return;
        }

        let obj;
        try {
            obj = JSON.parse(txt);
        } catch (err) {
            alert('Innehållet i urklipp är inte giltig JSON.');
            return;
        }

        const comps = obj.comps || {};
        const images = obj.images || {};

        const imagesDir = path.join(__dirname, '..', 'data', 'images');
        if (!fs.existsSync(imagesDir)) fs.mkdirSync(imagesDir, { recursive: true });

        const writtenImages = {};
        for (const [name, b64] of Object.entries(images)) {
            try {
                const buf = Buffer.from(b64, 'base64');
                let outName = name;
                let outPath = path.join(imagesDir, outName);
                if (fs.existsSync(outPath)) {
                    const ext = path.extname(name);
                    const base = path.basename(name, ext);
                    outName = `${base}-imported-${Date.now()}${ext}`;
                    outPath = path.join(imagesDir, outName);
                }
                fs.writeFileSync(outPath, buf);
                writtenImages[name] = outName;
            } catch (err) {
                logWarn('Failed to write imported image', name);
            }
        }

        const importedNames = [];
        Object.entries(comps).forEach(([name, data]) => {
            let target = name;
            if (target in notesData) {
                const base = target;
                let i = 1;
                while ((`${base}-imported${i > 1 ? '-' + i : ''}`) in notesData) i++;
                target = `${base}-imported${i > 1 ? '-' + i : ''}`;
            }
            if (data && typeof data === 'object' && data.notes && Object.keys(writtenImages).length) {
                let notesHtml = data.notes;
                Object.entries(writtenImages).forEach(([orig, newName]) => {
                    notesHtml = notesHtml.split(`../data/images/${orig}`).join(`../data/images/${newName}`);
                    notesHtml = notesHtml.split(`data/images/${orig}`).join(`../data/images/${newName}`);
                    notesHtml = notesHtml.split(orig).join(newName);
                });
                data.notes = notesHtml;
            }
            if (!data || typeof data !== 'object') {
                data = { notes: typeof data === 'string' ? data : '', items: [], lastEdited: new Date().toISOString() };
            } else {
                if (!('notes' in data)) data.notes = '';
                if (!Array.isArray(data.items)) data.items = [];
                if (!data.lastEdited) data.lastEdited = new Date().toISOString();
            }
            notesData[target] = data;
            importedNames.push(target);
        });

        try {
            const dataDir = path.dirname(NOTES_FILE);
            if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
            fs.writeFileSync(NOTES_FILE, JSON.stringify(notesData, null, 2), 'utf8');
        } catch (err) {
            logError('Failed to save notes after import', err);
            alert('Fel vid sparande efter import: ' + (err && err.message ? err.message : String(err)));
            return;
        }

        loadNotes();
        createNavigation();

        alert('Import klart. Kompositioner importerade: ' + (importedNames.length ? importedNames.join(', ') : '0'));
    } catch (error) {
        logError('Clipboard import failed', error);
        alert('Import misslyckades: ' + (error && error.message ? error.message : String(error)));
    }
}

// Small clipboard toolbar UI (copy/paste)
function createClipboardToolbar() {
    if (document.getElementById('clipboard-toolbar')) return;

    const toolbar = document.createElement('div');
    toolbar.id = 'clipboard-toolbar';
    toolbar.setAttribute('aria-label', 'Clipboard tools');
    toolbar.style.position = 'fixed';
    toolbar.style.right = '12px';
    toolbar.style.left = 'auto';
    toolbar.style.bottom = '12px';
    toolbar.style.zIndex = '9999';
    toolbar.style.display = 'flex';
    toolbar.style.flexDirection = 'column'; // stack vertically to avoid overlap
    toolbar.style.alignItems = 'stretch';
    toolbar.style.gap = '8px';
    toolbar.style.maxWidth = '240px';
    toolbar.style.boxSizing = 'border-box';
    toolbar.style.padding = '6px';

    const btnStyle = 'width:100%;padding:8px 10px;border-radius:6px;border:1px solid #ccc;background:#fff;cursor:pointer;font-size:0.9rem;text-align:center;box-sizing:border-box;';

    const copyAll = document.createElement('button');
    copyAll.textContent = 'Kopiera alla (urklipp)';
    copyAll.style.cssText = btnStyle;
    copyAll.addEventListener('click', () => exportCompsToClipboard(true));

    const copyCurrent = document.createElement('button');
    copyCurrent.textContent = 'Kopiera aktuell (urklipp)';
    copyCurrent.style.cssText = btnStyle;
    copyCurrent.addEventListener('click', () => exportCompsToClipboard(false));

    const pasteBtn = document.createElement('button');
    pasteBtn.textContent = 'Klistra in från urklipp';
    pasteBtn.style.cssText = btnStyle;
    pasteBtn.addEventListener('click', () => importCompsFromClipboard());

    toolbar.appendChild(copyAll);
    toolbar.appendChild(copyCurrent);
    toolbar.appendChild(pasteBtn);
    document.body.appendChild(toolbar);
}

// Add a small log-folder button in the UI (near clipboard toolbar)
function createLogButtonUI() {
    if (document.getElementById('open-log-btn')) return;

    const btn = document.createElement('button');
    btn.id = 'open-log-btn';
    btn.title = 'Open logs folder';
    btn.style.position = 'fixed';
    btn.style.right = '12px';
    btn.style.left = 'auto';
    // bottom is set dynamically below to avoid overlap with toolbar
    btn.style.zIndex = '10000';
    btn.style.padding = '6px 8px';
    btn.style.borderRadius = '6px';
    btn.style.border = '1px solid #ccc';
    btn.style.background = '#fff';
    btn.style.cursor = 'pointer';
    btn.style.fontSize = '0.85rem';
    btn.textContent = 'Logs';

    btn.addEventListener('click', async () => {
        try {
            ensureLogDir();
            const opened = await shell.openPath(LOG_DIR);
            if (opened && opened.length) {
                try {
                    await safeInvoke('open-log-folder', LOG_DIR);
                } catch (e) {
                    logWarn('open-log-folder ipc failed', e);
                    showToast('Kunde inte öppna loggmappen automatiskt. Se loggfil i data/logs.', 'warn');
                }
            }
        } catch (err) {
            logError('Failed to open log folder', err);
            showToast('Kunde inte öppna loggmappen. Se loggfil.', 'error');
        }
    });

    document.body.appendChild(btn);

    // position function — places button above the clipboard toolbar (if present)
    function positionLogBtn() {
        const toolbar = document.getElementById('clipboard-toolbar');
        let offset = 12; // default bottom offset
        try {
            if (toolbar) {
                const rect = toolbar.getBoundingClientRect();
                // place the log button above the toolbar with a 12px gap
                offset = Math.max(12, Math.ceil(rect.height) + 20);
            }
        } catch (e) {
            // ignore measurement errors
        }
        btn.style.bottom = `${offset}px`;
        btn.style.right = '12px';
        btn.style.left = 'auto';
    }

    // initial position
    setTimeout(positionLogBtn, 20);

    // observe toolbar size changes so we can reposition the log button
    const toolbarEl = document.getElementById('clipboard-toolbar');
    if (toolbarEl) {
        try {
            if (toolbarResizeObserver) {
                try { toolbarResizeObserver.disconnect(); } catch (e) {}
                toolbarResizeObserver = null;
            }
            toolbarResizeObserver = new ResizeObserver(() => {
                positionLogBtn();
            });
            toolbarResizeObserver.observe(toolbarEl);
        } catch (e) {
            // ResizeObserver may not be available in some environments — fallback to window resize
            window.addEventListener('resize', positionLogBtn);
        }
    } else {
        // if toolbar not present yet, still respond to window resize (in case toolbar appears)
        window.addEventListener('resize', positionLogBtn);
    }
}

// Create navigation buttons for all comps and tag filter UI
function getAllTags() {
    const set = new Set();
    Object.values(notesData).forEach(v => {
        if (v && Array.isArray(v.tags)) {
            v.tags.forEach(t => {
                if (t && typeof t === 'string') set.add(t);
            });
        }
    });
    return Array.from(set).sort((a,b) => a.localeCompare(b));
}

function setTagFilter(tag) {
    if (!tag) {
        activeTagFilter = '';
    } else if (activeTagFilter === tag) {
        activeTagFilter = '';
    } else {
        activeTagFilter = tag;
    }
    createNavigation();
    const input = document.getElementById('tag-filter-input');
    if (input) input.value = activeTagFilter || '';
}

function createTagFilterUI() {
    const nav = document.getElementById('comp-nav');
    if (!nav) return;

    let container = document.getElementById('tag-filter-container');
    if (!container) {
        container = document.createElement('div');
        container.id = 'tag-filter-container';
        container.style.padding = '8px';
        container.style.borderBottom = '1px solid #eee';
        nav.parentNode.insertBefore(container, nav);
    }

    const tags = getAllTags();
    container.innerHTML = `
        <div style="display:flex;gap:8px;align-items:center;margin-bottom:6px;">
            <input id="tag-filter-input" placeholder="Filter by tag" style="flex:1;padding:6px;border-radius:4px;border:1px solid #ccc;" value="${activeTagFilter || ''}">
            <button id="tag-filter-clear" title="Clear filter" style="padding:6px;border-radius:4px;border:1px solid #ccc;background:#fff;">Rensa</button>
        </div>
        <div id="tag-list" style="display:flex;gap:6px;flex-wrap:wrap;"></div>
    `;

    const input = document.getElementById('tag-filter-input');
    const clearBtn = document.getElementById('tag-filter-clear');
    const tagList = document.getElementById('tag-list');

    if (input) {
        input.addEventListener('input', (e) => {
            activeTagFilter = e.target.value.trim();
            createNavigation();
        });
    }
    if (clearBtn) {
        clearBtn.addEventListener('click', () => {
            activeTagFilter = '';
            if (input) input.value = '';
            createNavigation();
        });
    }

    tagList.innerHTML = tags.map(t => {
        const active = (t === activeTagFilter) ? 'background:#e6f4ff;border-color:#9ad1ff;' : '';
        return `<button class="tag-chip" data-tag="${escapeHtml(t)}" style="padding:4px 8px;border-radius:12px;border:1px solid #ccc;${active};cursor:pointer;font-size:0.85rem">${escapeHtml(t)}</button>`;
    }).join('');

    tagList.querySelectorAll('.tag-chip').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const tag = btn.getAttribute('data-tag');
            setTagFilter(tag);
            createTagFilterUI();
        });
    });
}

function createNavigation() {
    const nav = document.getElementById('comp-nav');
    if (!nav) return;
    nav.innerHTML = '';

    createTagFilterUI();

    const compOrder = getCompOrder();
    const filteredComps = compOrder.filter(comp => {
        if (searchQuery && searchQuery.trim() !== '' && !compMatchesSearch(comp, searchQuery)) return false;
        if (activeTagFilter && activeTagFilter.trim() !== '') {
            const compData = notesData[comp] && typeof notesData[comp] === 'object' ? notesData[comp] : null;
            const tags = compData && Array.isArray(compData.tags) ? compData.tags.map(t => (t || '').toLowerCase()) : [];
            if (!tags.includes(activeTagFilter.toLowerCase())) return false;
        }
        return true;
    });

    if (filteredComps.length === 0 && searchQuery) {
        const noResults = document.createElement('div');
        noResults.className = 'no-search-results';
        noResults.textContent = SYSTEM_MESSAGES.noResults;
        noResults.style.padding = '1rem';
        noResults.style.color = '#707070';
        noResults.style.textAlign = 'center';
        nav.appendChild(noResults);
        return;
    }

    filteredComps.forEach(comp => {
        const button = document.createElement('button');
        button.className = 'nav-button';
        button.style.position = 'relative';
        button.setAttribute('data-comp', comp);

        const compData = notesData[comp] && typeof notesData[comp] === 'object' ? notesData[comp] : null;
        const tags = compData && Array.isArray(compData.tags) ? compData.tags : [];

        const titleHtml = searchQuery
            ? highlightSearchMatches(capitalizeCompName(comp), searchQuery)
            : capitalizeCompName(comp);

        const tagsHtml = tags.length ? `<div class="nav-tags">${tags.map(t => `<span class="nav-tag" data-tag="${escapeHtml(t)}" style="display:inline-block;padding:2px 6px;margin:4px 4px 0 0;border-radius:10px;background:#f1f1f1;border:1px solid #e0e0e0;cursor:pointer;font-size:0.75rem;">${escapeHtml(t)}</span>`).join('')}</div>` : '';

        // Do not show last-edited in the nav; it's displayed inside the comp view instead
        button.innerHTML = `<div class="nav-title">${titleHtml}</div>${tagsHtml}`;

        // left accent color
        const derivedColor = getCompColor(comp);
        const colorAccent = document.createElement('div');
        colorAccent.className = 'nav-color-accent';
        colorAccent.style.position = 'absolute';
        colorAccent.style.left = '0';
        colorAccent.style.top = '0';
        colorAccent.style.bottom = '0';
        colorAccent.style.width = '4px';
        colorAccent.style.borderTopLeftRadius = '4px';
        colorAccent.style.borderBottomLeftRadius = '4px';
        colorAccent.style.background = derivedColor;
        button.appendChild(colorAccent);

        // apply left accent from comp color
        try {
            const accent = getCompColor(comp);
            button.style.borderLeft = `4px solid ${accent}`;
            button.style.paddingLeft = '10px';
        } catch (e) {
            // ignore accent errors
        }

        button.addEventListener('click', () => {
            const notesInterface = document.getElementById('notes-interface');
            const plannerInterface = document.getElementById('planner-interface');
            if (notesInterface && plannerInterface) {
                notesInterface.style.display = '';
                plannerInterface.style.display = 'none';
            }
            switchToComp(comp);
        });

        nav.appendChild(button);
    });

    nav.querySelectorAll('.nav-tag').forEach(el => {
        el.addEventListener('click', (e) => {
            e.stopPropagation();
            const tag = el.getAttribute('data-tag');
            setTagFilter(tag);
            createTagFilterUI();
        });
    });
}

// Switch to a specific comp
function switchToComp(comp) {
    logDebug('Switching to comp:', comp);
    document.querySelectorAll('.nav-button').forEach(btn => {
        btn.classList.remove('active');
        if (btn.getAttribute('data-comp') === comp) {
            btn.classList.add('active');
        }
    });
    
    const deleteBtn = document.getElementById('delete-current-comp-btn');
    if (deleteBtn) {
        const newDeleteBtn = deleteBtn.cloneNode(true);
        deleteBtn.parentNode.replaceChild(newDeleteBtn, deleteBtn);
        newDeleteBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            showDeleteCompModal(comp);
        });
    }
    
    if (currentComp) {
        saveNotes();
    }
    
    currentComp = comp;
    
    const noSelEl = document.getElementById('no-selection');
    const tabContentEl = document.getElementById('tab-content');
    if (noSelEl) noSelEl.classList.add('hidden');
    if (tabContentEl) tabContentEl.classList.remove('hidden');
    
    const titleEl = document.getElementById('current-comp-title');
    if (titleEl) titleEl.textContent = capitalizeCompName(comp);
    
    let notesText = '';
    let itemsArr = [];
    let compObj = null;
    if (notesData[comp] && typeof notesData[comp] === 'object') {
        compObj = notesData[comp];
        notesText = compObj.notes || '';
        itemsArr = compObj.items || [];
    } else {
        notesText = notesData[comp] || '';
        itemsArr = [];
    }
    
    const mainMeta = document.getElementById('current-comp-meta');
    if (mainMeta) {
        const lastEdited = compObj && compObj.lastEdited ? compObj.lastEdited : null;
        mainMeta.textContent = lastEdited ? `Last edited: ${formatDate(lastEdited)}` : '';
    }

    // render color strip + picker for this comp
    try { renderColorPicker(comp); } catch (e) { logWarn('renderColorPicker failed', e); }

    logDebug('Comp data', { comp, notesText: notesText.substring(0, 50), itemsArr });

    let itemsDiv = document.getElementById('comp-items');
    if (!itemsDiv) {
        itemsDiv = document.createElement('div');
        itemsDiv.id = 'comp-items';
        itemsDiv.className = 'comp-items';
        const tabContent = document.getElementById('tab-content');
        const tabHeader = tabContent ? tabContent.querySelector('.tab-header') : null;
        if (tabHeader) {
            tabHeader.insertAdjacentElement('afterend', itemsDiv);
        } else if (tabContent) {
            tabContent.appendChild(itemsDiv);
        }
    }
    
    itemsDiv.innerHTML = `
        <strong>Items:</strong>
        <input id="comp-items-input" class="comp-items-input" type="text" value="${itemsArr.join(', ')}" placeholder="Sword, Bow, Rod">
        <button id="save-items-btn" class="save-items-btn" title="Spara items">💾</button>
        <span id="items-saved-msg" class="items-saved-msg" style="display:none; margin-left:8px; color:#4caf50; font-size:0.95em;">${SYSTEM_MESSAGES.saved}</span>
    `;
    
    const itemsInput = document.getElementById('comp-items-input');
    const saveBtn = document.getElementById('save-items-btn');
    const savedMsg = document.getElementById('items-saved-msg');
    if (itemsInput && saveBtn) {
        saveBtn.addEventListener('click', () => {
            const newItems = itemsInput.value.split(',').map(s => s.trim()).filter(Boolean);
            if (notesData[comp] && typeof notesData[comp] === 'object') {
                notesData[comp].items = newItems;
                notesData[comp].lastEdited = new Date().toISOString();
            } else {
                notesData[comp] = { notes: notesText, items: newItems, lastEdited: new Date().toISOString() };
            }
            try {
                fs.writeFileSync(NOTES_FILE, JSON.stringify(notesData, null, 2), 'utf8');
            } catch (error) {
                logError('Error saving items:', error);
            }
            createNavigation();
            if (savedMsg) {
                savedMsg.textContent = SYSTEM_MESSAGES.saved;
                savedMsg.style.display = 'inline';
                setTimeout(() => { savedMsg.style.display = 'none'; }, 1200);
            }
            const mainMeta2 = document.getElementById('current-comp-meta');
            if (mainMeta2) mainMeta2.textContent = `Last edited: ${formatDate(notesData[comp].lastEdited)}`;
        });
        itemsInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                saveBtn.click();
                itemsInput.blur();
            }
        });
    }

    const editorDiv = document.getElementById('comp-notes-editor');
    if (editorDiv) {
        logDebug('Setting editor HTML, length: ' + (notesText ? notesText.length : 0));
        editorDiv.innerHTML = notesText || '';
        editorDiv.style.display = '';
    }

    const headerDeleteBtn = document.getElementById('delete-current-comp-btn');
    if (headerDeleteBtn) {
        headerDeleteBtn.style.display = 'flex';
    }

    renderTagEditor(comp);
}

// Show add composition modal
function showAddCompModal() {
    const modal = document.getElementById('add-comp-modal');
    const input = document.getElementById('comp-name-input');
    modal.classList.remove('hidden');
    input.value = '';
    input.focus();
}

// Hide add composition modal
function hideAddCompModal() {
    const modal = document.getElementById('add-comp-modal');
    modal.classList.add('hidden');
}

// Add a new composition
function addComp() {
    const input = document.getElementById('comp-name-input');
    const compName = input.value.trim();
    
    if (!compName || compName === '') {
        return;
    }
    
    const trimmedName = compName.toLowerCase();
    
    if (trimmedName in notesData) {
        alert(SYSTEM_MESSAGES.addCompExists);
        input.focus();
        return;
    }
    
    if (currentComp) {
        saveNotes();
    }
    
    notesData[trimmedName] = {
        notes: '',
        items: [],
        tags: [],
        lastEdited: new Date().toISOString()
    };
    
    try {
        const dataDir = path.dirname(NOTES_FILE);
        if (!fs.existsSync(dataDir)) {
            fs.mkdirSync(dataDir, { recursive: true });
        }
        fs.writeFileSync(NOTES_FILE, JSON.stringify(notesData, null, 2), 'utf8');
    } catch (error) {
        logError('Error saving notes:', error);
        alert('Ett fel uppstod vid sparande: ' + error.message);
        return;
    }
    
    hideAddCompModal();
    createNavigation();
    switchToComp(trimmedName);
}

// Show delete confirmation modal (now uses native dialog via main process, falls back to in-app modal)
async function showDeleteCompModal(comp) {
    try {
        const confirmed = await safeInvoke('confirm-delete', comp);
        if (confirmed) {
            deleteComp(comp);
        }
    } catch (err) {
        logWarn('Native confirm failed, falling back to modal', err);
        const modal = document.getElementById('delete-comp-modal');
        const message = document.getElementById('delete-comp-message');
        if (message) message.textContent = SYSTEM_MESSAGES.deleteConfirm(comp);
        if (modal) {
            modal.setAttribute('data-comp-to-delete', comp);
            modal.classList.remove('hidden');
        }
    }
}

// Delete a composition (called after confirmation)
function deleteComp(comp) {
    const modal = document.getElementById('delete-comp-modal');
    if (!comp && modal) {
        comp = modal.getAttribute('data-comp-to-delete');
    }

    if (!comp) {
        logError('No comp to delete specified');
        hideDeleteCompModal();
        return;
    }

    logDebug('Deleting comp:', comp);

    const compOrder = getCompOrder();

    if (compOrder.length <= 1) {
        alert(SYSTEM_MESSAGES.deleteLastComp);
        hideDeleteCompModal();
        return;
    }

    if (currentComp) {
        saveNotes();
    }

    let switchTo = null;
    if (currentComp === comp) {
        const currentIndex = compOrder.indexOf(comp);
        if (currentIndex < compOrder.length - 1) {
            switchTo = compOrder[currentIndex + 1];
        } else if (currentIndex > 0) {
            switchTo = compOrder[currentIndex - 1];
        }
    }

    if (!(comp in notesData)) {
        logError('Comp not found in notesData: ' + comp);
        hideDeleteCompModal();
        return;
    }

    const compData = notesData[comp];
    delete notesData[comp];

    try {
        fs.writeFileSync(NOTES_FILE, JSON.stringify(notesData, null, 2), 'utf8');
    } catch (error) {
        logError('Error saving notes:', error);
        notesData[comp] = compData;
        alert('Ett fel uppstod vid borttagning: ' + error.message);
        hideDeleteCompModal();
        return;
    }

    hideDeleteCompModal();

    const wasCurrentComp = (currentComp === comp);
    if (wasCurrentComp) {
        currentComp = null;
    }

    createNavigation();

    if (wasCurrentComp) {
        if (switchTo && switchTo in notesData) {
            setTimeout(() => { switchToComp(switchTo); }, 10);
        } else {
            const noSelectionEl = document.getElementById('no-selection');
            const tabContentEl = document.getElementById('tab-content');
            if (noSelectionEl) noSelectionEl.classList.remove('hidden');
            if (tabContentEl) tabContentEl.classList.add('hidden');
            const headerDeleteBtn = document.getElementById('delete-current-comp-btn');
            if (headerDeleteBtn) headerDeleteBtn.style.display = 'none';
        }
    }
}

// Hide delete confirmation modal
function hideDeleteCompModal() {
    const modal = document.getElementById('delete-comp-modal');
    if (!modal) return;
    // clear stored target and hide
    modal.removeAttribute('data-comp-to-delete');
    modal.classList.add('hidden');
}

// Setup textarea auto-save
function setupAutoSave() {
    const editorDiv = document.getElementById('comp-notes-editor');
    if (editorDiv) {
        editorDiv.addEventListener('input', debouncedSave);
    }
}

// --- Tag editor helpers ---
function renderTagEditor(comp) {
    if (!comp) return;
    let tagsContainer = document.getElementById('comp-tags');
    // create container if missing, place it below itemsDiv
    if (!tagsContainer) {
        tagsContainer = document.createElement('div');
        tagsContainer.id = 'comp-tags';
        tagsContainer.className = 'comp-tags';
        const tabContent = document.getElementById('tab-content');
        const itemsDiv = document.getElementById('comp-items');
        if (itemsDiv && itemsDiv.parentNode) {
            itemsDiv.parentNode.insertBefore(tagsContainer, itemsDiv.nextSibling);
        } else if (tabContent) {
            tabContent.appendChild(tagsContainer);
        }
    }

    const compData = notesData[comp] && typeof notesData[comp] === 'object' ? notesData[comp] : { tags: [] };
    const tags = Array.isArray(compData.tags) ? compData.tags : [];

    tagsContainer.innerHTML = `
        <div style="display:flex;align-items:center;gap:8px;margin-top:8px;">
            <strong>Tags:</strong>
            <div id="tag-chip-list" style="display:flex;gap:6px;flex-wrap:wrap;"></div>
            <input id="tag-input" placeholder="Add tag and press Enter" style="margin-left:8px;padding:4px;border-radius:4px;border:1px solid #ccc;" />
        </div>
    `;

    const chipList = document.getElementById('tag-chip-list');
    const input = document.getElementById('tag-input');

    // render chips
    chipList.innerHTML = tags.map(t => {
        const safe = escapeHtml(t);
        return `<span class="tag-chip-edit" data-tag="${safe}" style="display:inline-flex;align-items:center;gap:6px;padding:4px 8px;border-radius:12px;border:1px solid #ccc;background:#fafafa;"><span>${safe}</span><button class="tag-remove-btn" data-tag="${safe}" title="Remove" style="border:none;background:transparent;cursor:pointer;font-weight:700;line-height:1;">×</button></span>`;
    }).join('');

    // bind remove buttons
    chipList.querySelectorAll('.tag-remove-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const tag = btn.getAttribute('data-tag');
            removeTagFromComp(comp, tag);
        });
    });

    // autocomplete simple suggestion dropdown
    let suggestions = [];
    const suggestBoxId = 'tag-suggest-box';
    function updateSuggestBox() {
        let box = document.getElementById(suggestBoxId);
        if (!box) {
            box = document.createElement('div');
            box.id = suggestBoxId;
            box.style.position = 'absolute';
            box.style.background = '#fff';
            box.style.border = '1px solid #ccc';
            box.style.padding = '6px';
            box.style.borderRadius = '4px';
            box.style.boxShadow = '0 2px 6px rgba(0,0,0,0.12)';
            box.style.zIndex = 10000;
            document.body.appendChild(box);
        }
        if (!suggestions.length) {
            box.style.display = 'none';
            return;
        }
        box.style.display = '';
        box.innerHTML = suggestions.map(s => `<div class="tag-suggest-item" data-val="${escapeHtml(s)}" style="padding:4px 8px;cursor:pointer;">${escapeHtml(s)}</div>`).join('');
        // position under input
        const rect = input.getBoundingClientRect();
        box.style.left = `${rect.left}px`;
        box.style.top = `${rect.bottom + 6}px`;
        box.style.minWidth = `${rect.width}px`;

        box.querySelectorAll('.tag-suggest-item').forEach(it => {
            it.addEventListener('click', (ev) => {
                const val = it.getAttribute('data-val');
                addTagToComp(comp, val);
                input.value = '';
                suggestions = [];
                updateSuggestBox();
            });
        });
    }

    input.addEventListener('input', (e) => {
        const v = e.target.value.trim();
        if (!v) {
            suggestions = [];
            updateSuggestBox();
            return;
        }
        const all = getAllTags().filter(t => t.toLowerCase().includes(v.toLowerCase()) && !tags.map(x => x.toLowerCase()).includes(t.toLowerCase()));
        suggestions = all.slice(0, 8);
        updateSuggestBox();
    });

    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ',') {
            e.preventDefault();
            const val = input.value.trim();
            if (val) {
                addTagToComp(comp, val);
                input.value = '';
                suggestions = [];
                updateSuggestBox();
            }
        } else if (e.key === 'Escape') {
            input.value = '';
            suggestions = [];
            updateSuggestBox();
        }
    });

    // hide suggest box on blur (small delay to allow click)
    input.addEventListener('blur', () => {
        setTimeout(() => {
            const box = document.getElementById(suggestBoxId);
            if (box) box.style.display = 'none';
        }, 150);
    });
}

function addTagToComp(comp, tag) {
    if (!comp || !tag) return;
    const clean = tag.toString().trim();
    if (!clean) return;
    if (!notesData[comp] || typeof notesData[comp] !== 'object') notesData[comp] = { notes: '', items: [], tags: [], lastEdited: new Date().toISOString() };
    if (!Array.isArray(notesData[comp].tags)) notesData[comp].tags = [];
    // avoid duplicates (case-insensitive)
    const exists = notesData[comp].tags.some(t => t.toLowerCase() === clean.toLowerCase());
    if (exists) {
        showToast('Tag already present', 'warn');
        return;
    }
    notesData[comp].tags.push(clean);
    notesData[comp].lastEdited = new Date().toISOString();
    try {
        fs.writeFileSync(NOTES_FILE, JSON.stringify(notesData, null, 2), 'utf8');
        logInfo(`Added tag "${clean}" to ${comp}`);
        createNavigation();
        renderTagEditor(comp);
    } catch (err) {
        logError('Error saving tag addition', err);
        showToast('Fel vid sparande av tag.', 'error');
    }
}

function removeTagFromComp(comp, tag) {
    if (!comp || !tag) return;
    if (!notesData[comp] || !Array.isArray(notesData[comp].tags)) return;
    const before = notesData[comp].tags.length;
    notesData[comp].tags = notesData[comp].tags.filter(t => t.toLowerCase() !== tag.toLowerCase());
    if (notesData[comp].tags.length === before) return;
    notesData[comp].lastEdited = new Date().toISOString();
    try {
        fs.writeFileSync(NOTES_FILE, JSON.stringify(notesData, null, 2), 'utf8');
        logInfo(`Removed tag "${tag}" from ${comp}`);
        createNavigation();
        renderTagEditor(comp);
    } catch (err) {
        logError('Error saving tag removal', err);
        showToast('Fel vid borttagning av tag.', 'error');
    }
}

// ===== comp color helpers (deterministic fallback + picker) =====
function nameToColor(name) {
    let hash = 0;
    for (let i = 0; i < name.length; i++) {
        hash = name.charCodeAt(i) + ((hash << 5) - hash);
        hash |= 0;
    }
    const h = Math.abs(hash) % 360;               // hue
    const s = 55 + (Math.abs(hash) % 20);         // saturation 55-74
    const l = 45 + (Math.abs(hash) % 10);         // lightness 45-54
    return `hsl(${h}, ${s}%, ${l}%)`;
}

function hslToHex(hsl) {
    // expects "hsl(h, s%, l%)"
    const m = hsl.match(/hsl\(\s*([\d.]+),\s*([\d.]+)%\s*,\s*([\d.]+)%\s*\)/i);
    if (!m) return '#888888';
    let h = Number(m[1]) / 360;
    let s = Number(m[2]) / 100;
    let l = Number(m[3]) / 100;

    function hue2rgb(p, q, t) {
        if (t < 0) t += 1;
        if (t > 1) t -= 1;
        if (t < 1/6) return p + (q - p) * 6 * t;
        if (t < 1/2) return q;
        if (t < 2/3) return p + (q - p) * (2/3 - t) * 6;
        return p;
    }

    let r, g, b;
    if (s === 0) {
        r = g = b = l; // achromatic
    } else {
        const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
        const p = 2 * l - q;
        r = hue2rgb(p, q, h + 1/3);
        g = hue2rgb(p, q, h);
        b = hue2rgb(p, q, h - 1/3);
    }

    const toHex = (x) => {
        const hex = Math.round(x * 255).toString(16).padStart(2, '0');
        return hex;
    };
    return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

function anyColorToHex(colorStr) {
    if (!colorStr) return '#888888';
    if (colorStr.startsWith('#')) return colorStr;
    if (colorStr.startsWith('hsl')) return hslToHex(colorStr);
    return '#888888';
}

function getCompColor(compName) {
    const comp = notesData[compName];
    if (comp && comp.color) return comp.color;
    if (comp && Array.isArray(comp.tags) && comp.tags.length) {
        return nameToColor(comp.tags[0]);
    }
    return nameToColor(compName);
}

// Add a small color-picker in the comp header (saves immediate override)
function renderColorPicker(comp) {
    const titleEl = document.getElementById('current-comp-title');
    if (!titleEl) return;

    let picker = document.getElementById('comp-color-picker');
    let clearBtn = document.getElementById('comp-color-clear');
    let strip = document.getElementById('comp-color-strip');

    if (!strip) {
        strip = document.createElement('div');
        strip.id = 'comp-color-strip';
        strip.style.height = '6px';
        strip.style.width = '100%';
        strip.style.borderRadius = '4px';
        strip.style.marginBottom = '8px';
        const tabContent = document.getElementById('tab-content');
        if (tabContent) tabContent.insertAdjacentElement('afterbegin', strip);
    }

    const derived = getCompColor(comp);
    strip.style.background = derived;

    // create picker if missing, otherwise reuse existing
    if (!picker) {
        picker = document.createElement('input');
        picker.type = 'color';
        picker.id = 'comp-color-picker';
        picker.title = 'Set comp color (override)';
        picker.style.marginLeft = '8px';
        picker.style.verticalAlign = 'middle';
        picker.style.cursor = 'pointer';

        // insert picker after title (place before clear button if it exists)
        if (clearBtn && clearBtn.parentNode === titleEl.parentNode) {
            titleEl.parentNode.insertBefore(picker, clearBtn);
        } else {
            titleEl.insertAdjacentElement('afterend', picker);
        }

        picker.addEventListener('input', () => {
            try {
                if (!notesData[comp] || typeof notesData[comp] !== 'object') notesData[comp] = { notes: '', items: [], tags: [], lastEdited: new Date().toISOString() };
                notesData[comp].color = picker.value;
                notesData[comp].lastEdited = new Date().toISOString();
                fs.writeFileSync(NOTES_FILE, JSON.stringify(notesData, null, 2), 'utf8');
                strip.style.background = picker.value;
                createNavigation();
            } catch (err) {
                logError('Error saving comp color', err);
                showToast('Fel vid sparande av färg.', 'error');
            }
        });
    }

    // create clear button if missing
    if (!clearBtn) {
        clearBtn = document.createElement('button');
        clearBtn.id = 'comp-color-clear';
        clearBtn.title = 'Clear comp color override';
        clearBtn.textContent = '✕';
        clearBtn.style.marginLeft = '6px';
        clearBtn.style.padding = '2px 6px';
        clearBtn.style.border = '1px solid #ddd';
        clearBtn.style.background = '#fff';
        clearBtn.style.cursor = 'pointer';
        clearBtn.style.borderRadius = '4px';
        clearBtn.style.fontSize = '0.85rem';
        titleEl.insertAdjacentElement('afterend', clearBtn);

        clearBtn.addEventListener('click', () => {
            try {
                if (notesData[comp] && notesData[comp].color) delete notesData[comp].color;
                notesData[comp].lastEdited = new Date().toISOString();
                fs.writeFileSync(NOTES_FILE, JSON.stringify(notesData, null, 2), 'utf8');
                const newColor = getCompColor(comp);
                strip.style.background = newColor;
                picker.value = anyColorToHex(newColor);
                createNavigation();
            } catch (err) {
                logError('Error clearing comp color', err);
                showToast('Fel vid återställning av färg.', 'error');
            }
        });
    }

    // set picker value (convert fallback HSL to hex when needed)
    const val = (notesData[comp] && notesData[comp].color) ? notesData[comp].color : derived;
    picker.value = anyColorToHex(val);
}

// Initialize app when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
    loadNotes();
    createNavigation();
    setupAutoSave();
    setupImagePaste();

    createClipboardToolbar();
    setTimeout(createLogButtonUI, 50);

    const addBtn = document.getElementById('add-comp-btn');
    if (addBtn) {
        addBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            showAddCompModal();
        });
    }
    
    const modalCancelBtn = document.getElementById('modal-cancel-btn');
    const modalAddBtn = document.getElementById('modal-add-btn');
    const compNameInput = document.getElementById('comp-name-input');
    
    if (modalCancelBtn) {
        modalCancelBtn.addEventListener('click', () => {
            hideAddCompModal();
        });
    }
    
    if (modalAddBtn) {
        modalAddBtn.addEventListener('click', () => {
            addComp();
        });
    }
    
    if (compNameInput) {
        compNameInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                addComp();
            } else if (e.key === 'Escape') {
                e.preventDefault();
                hideAddCompModal();
            }
        });
    }
    
    const addModal = document.getElementById('add-comp-modal');
    if (addModal) {
        addModal.addEventListener('click', (e) => {
            if (e.target === addModal) {
                hideAddCompModal();
            }
        });
    }
    
    const deleteModal = document.getElementById('delete-comp-modal');
    const deleteCancelBtn = document.getElementById('delete-modal-cancel-btn');
    const deleteConfirmBtn = document.getElementById('delete-modal-confirm-btn');
    
    if (deleteCancelBtn) {
        deleteCancelBtn.addEventListener('click', () => {
            hideDeleteCompModal();
        });
    }
    
    if (deleteConfirmBtn) {
        deleteConfirmBtn.addEventListener('click', () => {
            deleteComp();
        });
    }
    
    if (deleteModal) {
        deleteModal.addEventListener('click', (e) => {
            if (e.target === deleteModal) {
                hideDeleteCompModal();
            }
        });
    }
    
    const noSel = document.getElementById('no-selection');
    if (noSel) noSel.classList.remove('hidden');
    const tabCont = document.getElementById('tab-content');
    if (tabCont) tabCont.classList.add('hidden');
    
    setupSearch();

    const plannerTabBtn = document.getElementById('planner-tab-btn');
    const notesInterface = document.getElementById('notes-interface');
    const plannerInterface = document.getElementById('planner-interface');
    if (plannerTabBtn && notesInterface && plannerInterface) {
        plannerTabBtn.addEventListener('click', () => {
            notesInterface.style.display = notesInterface.style.display === 'none' ? '' : 'none';
            plannerInterface.style.display = plannerInterface.style.display === 'none' ? '' : 'none';
            if (plannerInterface.style.display !== 'none') {
                setupPlannerInterface();
            }
        });
    }
});
