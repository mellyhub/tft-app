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
// toolbarResizeObserver removed

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
            return selectedItems.every(item => data.items.map(i => (i || '').toLowerCase()).includes(item));
        });
        if (matchingComps.length === 0) {
            resultsDiv.innerHTML = `<div class="planner-empty-message">${SYSTEM_MESSAGES.noCompsMatch}</div>`;
            return;
        }
        resultsDiv.innerHTML = matchingComps.map(([comp, data]) => {
            // strip image tags from notes for planner results
            const notesSafe = (data.notes || '').toString().replace(/<img[^>]*>/gi, '').replace(/\n/g, '<br>');
            return `
            <div class="planner-comp-result" data-comp="${comp}">
                <div class="planner-comp-title" style="cursor:pointer; color:#4a9eff; text-decoration:underline;" data-comp="${comp}">${capitalizeCompName(comp)}</div>
                <div class="planner-comp-items">Items: ${Array.isArray(data.items) ? data.items.join(', ') : ''}</div>
                <div class="planner-comp-notes">${notesSafe}</div>
            </div>`;
        }).join('');
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

// Clipboard toolbar removed

// Floating log button removed

// Open the logs folder (reusable helper). Attempts shell.openPath and
// falls back to IPC if needed — mirrors the previous button behavior.
async function openLogsFolder() {
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
    const selectEl = document.getElementById('tag-filter-select');
    if (selectEl) selectEl.value = activeTagFilter || '';
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
            <select id="tag-filter-select" style="flex:1;padding:6px;border-radius:4px;border:1px solid #ccc;">
                <option value="">Alla taggar</option>
                <option value="Reroll">Reroll</option>
                <option value="Fast-8">Fast-8</option>
            </select>
            <button id="tag-filter-clear" title="Clear filter" style="padding:6px;border-radius:4px;border:1px solid #ccc;background:#fff;">Rensa</button>
        </div>
        <div id="tag-list" style="display:flex;gap:6px;flex-wrap:wrap;"></div>
    `;

    const selectEl = document.getElementById('tag-filter-select');
    const clearBtn = document.getElementById('tag-filter-clear');
    const tagList = document.getElementById('tag-list');

    if (selectEl) {
        selectEl.addEventListener('change', (e) => {
            const v = e.target.value || '';
            activeTagFilter = v.trim();
            createNavigation();
        });
        // initialize value
        selectEl.value = activeTagFilter || '';
    }
    if (clearBtn) {
        clearBtn.addEventListener('click', () => {
            activeTagFilter = '';
            if (selectEl) selectEl.value = '';
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

        // Do not show last-edited in the nav; it's displayed inside the comp view instead
        // Tags are intentionally omitted from the nav list for a cleaner UI
        button.innerHTML = `<div class="nav-title">${titleHtml}</div>`;

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
    
    // add inline edit button next to title for renaming comp
    let editBtn = document.getElementById('comp-edit-btn');
    if (!editBtn) {
        editBtn = document.createElement('button');
        editBtn.id = 'comp-edit-btn';
        editBtn.title = 'Redigera namn';
        editBtn.textContent = '✏️';
        editBtn.style.padding = '2px 6px';
        editBtn.style.border = '1px solid #ddd';
        editBtn.style.background = '#fff';
        editBtn.style.cursor = 'pointer';
        editBtn.style.borderRadius = '4px';
        editBtn.style.fontSize = '0.9rem';
        editBtn.style.verticalAlign = 'middle';
        editBtn.style.marginLeft = '6px';
        // place the edit button inside the title element so it stays on the left
        if (titleEl) {
            titleEl.style.display = 'inline-flex';
            titleEl.style.alignItems = 'center';
            titleEl.style.gap = '6px';
            // append the button inside the title h2 so it stays with the title on the left
            titleEl.appendChild(editBtn);
        }
    } else {
        // ensure existing button has the correct alignment styles
        editBtn.style.verticalAlign = 'middle';
        editBtn.style.marginLeft = '6px';
        if (titleEl) {
            titleEl.style.display = 'inline-flex';
            titleEl.style.alignItems = 'center';
            titleEl.style.gap = '6px';
            // move it inside the title if it's not already
            if (editBtn.parentNode !== titleEl) {
                titleEl.appendChild(editBtn);
            }
        }
    }

    function finishRename(oldKey, newKeyRaw) {
        const newKey = (newKeyRaw || '').toString().trim().toLowerCase();
        if (!newKey) {
            showToast('Ogiltigt namn', 'warn');
            return false;
        }
        if (newKey === oldKey) return true;
        if (newKey in notesData) {
            alert('En komposition med det namnet finns redan.');
            return false;
        }
        // rename in notesData
        try {
            notesData[newKey] = notesData[oldKey];
            // update meta if exists
            notesData[newKey].lastEdited = new Date().toISOString();
            delete notesData[oldKey];
            fs.writeFileSync(NOTES_FILE, JSON.stringify(notesData, null, 2), 'utf8');
            // switch view to new comp key
            switchToComp(newKey);
            return true;
        } catch (err) {
            logError('Error renaming comp', err);
            showToast('Fel vid byta namn.', 'error');
            return false;
        }
    }

    editBtn.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        // hide title and show input
        const inputId = 'comp-title-input';
        if (document.getElementById(inputId)) return;
        const input = document.createElement('input');
        input.id = inputId;
        input.type = 'text';
        input.value = capitalizeCompName(comp);
        input.style.marginLeft = '8px';
        input.style.padding = '4px 6px';
        input.style.fontSize = '1rem';
        input.style.borderRadius = '4px';
        input.style.border = '1px solid #ccc';
        titleEl.style.display = 'none';
        editBtn.style.display = 'none';
        const deleteBtnEl = document.getElementById('delete-current-comp-btn');
        if (deleteBtnEl) deleteBtnEl.style.display = 'none';
        titleEl.parentNode.insertBefore(input, titleEl.nextSibling);
        input.select();

        function cleanupInput() {
            if (input) input.remove();
            titleEl.style.display = '';
            editBtn.style.display = '';
            if (deleteBtnEl) deleteBtnEl.style.display = 'flex';
        }

        input.addEventListener('keydown', (ev) => {
            if (ev.key === 'Enter') {
                ev.preventDefault();
                const newName = input.value.trim();
                const ok = finishRename(comp, newName);
                if (ok) return; // switchToComp already done
                cleanupInput();
            } else if (ev.key === 'Escape') {
                cleanupInput();
            }
        });

        input.addEventListener('blur', () => {
            const newName = input.value.trim();
            if (newName && newName.toLowerCase() !== comp) {
                const ok = finishRename(comp, newName);
                if (!ok) cleanupInput();
            } else {
                cleanupInput();
            }
        });
    };
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
    
    // Added tag selector (single-choice) next to items input
    const currentTag = (compObj && Array.isArray(compObj.tags) && compObj.tags.length > 0) ? compObj.tags[0] : '';
    itemsDiv.innerHTML = `
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
            <div style="flex:1;min-width:220px;">
                <strong>Items:</strong>
                <input id="comp-items-input" class="comp-items-input" type="text" value="${itemsArr.join(', ')}" placeholder="Sword, Bow, Rod" style="width:100%;">
            </div>
            <div style="min-width:160px;">
                <strong>Tag:</strong>
                <select id="comp-tag-select" style="width:100%;padding:6px;border-radius:4px;border:1px solid #ccc;">
                    <option value="">(ingen)</option>
                    <option value="Reroll">Reroll</option>
                    <option value="Fast-8">Fast-8</option>
                </select>
            </div>
            <div style="display:flex;align-items:center;gap:8px;">
                <!-- autosave: no save button -->
            </div>
        </div>
    `;
    
    const itemsInput = document.getElementById('comp-items-input');
    if (itemsInput) {
        // Debounced auto-save for items
        let itemsSaveTimeout = null;
        const saveItemsForComp = () => {
            const newItems = itemsInput.value.split(',').map(s => s.trim()).filter(Boolean);
            const tagSelect = document.getElementById('comp-tag-select');
            const selectedTag = tagSelect && tagSelect.value ? tagSelect.value : '';
            if (notesData[comp] && typeof notesData[comp] === 'object') {
                notesData[comp].items = newItems;
                notesData[comp].tags = selectedTag ? [selectedTag] : [];
                notesData[comp].lastEdited = new Date().toISOString();
            } else {
                notesData[comp] = { notes: notesText, items: newItems, tags: selectedTag ? [selectedTag] : [], lastEdited: new Date().toISOString() };
            }
            try {
                fs.writeFileSync(NOTES_FILE, JSON.stringify(notesData, null, 2), 'utf8');
            } catch (error) {
                logError('Error saving items:', error);
            }
            createNavigation();
            const mainMeta2 = document.getElementById('current-comp-meta');
            if (mainMeta2) mainMeta2.textContent = `Last edited: ${formatDate(notesData[comp].lastEdited)}`;
        };

        itemsInput.addEventListener('input', () => {
            if (itemsSaveTimeout) clearTimeout(itemsSaveTimeout);
            itemsSaveTimeout = setTimeout(saveItemsForComp, SAVE_DELAY);
        });

        itemsInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                if (itemsSaveTimeout) clearTimeout(itemsSaveTimeout);
                saveItemsForComp();
                itemsInput.blur();
            }
        });
        // initialize tag select value and auto-save on change
        const tagSelectInit = document.getElementById('comp-tag-select');
        if (tagSelectInit) {
            tagSelectInit.value = currentTag || '';
            tagSelectInit.addEventListener('change', () => {
                const selectedTag = tagSelectInit.value || '';
                try {
                    if (!notesData[comp] || typeof notesData[comp] !== 'object') {
                        notesData[comp] = { notes: notesText, items: itemsArr, tags: [], lastEdited: new Date().toISOString() };
                    }
                    notesData[comp].tags = selectedTag ? [selectedTag] : [];
                    notesData[comp].lastEdited = new Date().toISOString();
                    fs.writeFileSync(NOTES_FILE, JSON.stringify(notesData, null, 2), 'utf8');
                    createNavigation();
                } catch (err) {
                    logError('Error auto-saving tag', err);
                    // silent failure; no saved popup
                }
            });
        }
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

    // legacy tag editor removed
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

// Legacy tag editor removed. Tag management is now handled via the single-choice dropdown.

// ===== comp color helpers (deterministic fallback + picker) =====
function nameToColor(name) {
    // Return a single default greyscale color for all comps
    return '#bdbdbd';
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
    // Default to a single shared greyscale color for all comps
    return '#bdbdbd';
}

// Add a small color-picker in the comp header (saves immediate override)
function renderColorPicker(comp) {
    const titleEl = document.getElementById('current-comp-title');
    if (!titleEl) return;
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

    // palette of predetermined colors (hex)
    const palette = ['#f44336','#e91e63','#9c27b0','#3f51b5','#03a9f4','#4caf50','#ff9800','#795548','#607d8b','#ffeb3b'];

    // create palette container
    let paletteEl = document.getElementById('comp-color-palette');
    if (!paletteEl) {
        paletteEl = document.createElement('div');
        paletteEl.id = 'comp-color-palette';
        paletteEl.style.display = 'flex';
        paletteEl.style.gap = '6px';
        paletteEl.style.marginLeft = '8px';
        paletteEl.style.marginTop = '6px';
        paletteEl.style.flexWrap = 'wrap';
        // insert after title (hidden by default)
        paletteEl.style.display = 'none';
        titleEl.insertAdjacentElement('afterend', paletteEl);
    }

    // create a toggle button to show/hide palette (to keep UI tidy)
    let toggleBtn = document.getElementById('comp-color-toggle');
    if (!toggleBtn) {
        toggleBtn = document.createElement('button');
        toggleBtn.id = 'comp-color-toggle';
        toggleBtn.textContent = 'Färg';
        toggleBtn.title = 'Visa/dölj färgpalett';
        toggleBtn.style.marginLeft = '8px';
        toggleBtn.style.padding = '2px 6px';
        toggleBtn.style.border = '1px solid #ddd';
        toggleBtn.style.background = '#fff';
        toggleBtn.style.cursor = 'pointer';
        toggleBtn.style.borderRadius = '4px';
        toggleBtn.style.fontSize = '0.85rem';
        titleEl.insertAdjacentElement('afterend', toggleBtn);
        // hide the inline toggle — the unified menu exposes color control
        try { toggleBtn.style.display = 'none'; } catch (e) { /* ignore */ }
        toggleBtn.addEventListener('click', () => {
            try {
                paletteEl.style.display = paletteEl.style.display === 'none' ? 'flex' : 'none';
            } catch (e) { /* ignore */ }
        });
    }

    // render swatches
    paletteEl.innerHTML = '';
    const currentColor = (notesData[comp] && notesData[comp].color) ? anyColorToHex(notesData[comp].color) : anyColorToHex(derived);
    palette.forEach(col => {
        const btn = document.createElement('button');
        btn.className = 'comp-color-swatch';
        btn.setAttribute('data-color', col);
        btn.title = col;
        btn.style.width = '22px';
        btn.style.height = '22px';
        btn.style.borderRadius = '4px';
        btn.style.border = col.toLowerCase() === currentColor.toLowerCase() ? '2px solid #222' : '1px solid #ddd';
        btn.style.background = col;
        btn.style.cursor = 'pointer';
        btn.addEventListener('click', () => {
            try {
                if (!notesData[comp] || typeof notesData[comp] !== 'object') notesData[comp] = { notes: '', items: [], tags: [], lastEdited: new Date().toISOString() };
                notesData[comp].color = col;
                notesData[comp].lastEdited = new Date().toISOString();
                fs.writeFileSync(NOTES_FILE, JSON.stringify(notesData, null, 2), 'utf8');
                strip.style.background = col;
                createNavigation();
                // re-render to update selection border
                renderColorPicker(comp);
            } catch (err) {
                logError('Error saving comp color', err);
                showToast('Fel vid sparande av färg.', 'error');
            }
        });
        paletteEl.appendChild(btn);
    });

    // clear/reset button to remove override
    let clearBtn = document.getElementById('comp-color-clear');
    if (!clearBtn) {
        clearBtn = document.createElement('button');
        clearBtn.id = 'comp-color-clear';
        clearBtn.title = 'Reset color to default';
        clearBtn.textContent = 'Återställ';
        clearBtn.style.marginLeft = '8px';
        clearBtn.style.padding = '2px 6px';
        clearBtn.style.border = '1px solid #ddd';
        clearBtn.style.background = '#fff';
        clearBtn.style.cursor = 'pointer';
        clearBtn.style.borderRadius = '4px';
        clearBtn.style.fontSize = '0.75rem';
        paletteEl.insertAdjacentElement('afterend', clearBtn);
        // hide the inline clear/reset button — use unified menu for restore
        try { clearBtn.style.display = 'none'; } catch (e) { /* ignore */ }
    }
    clearBtn.onclick = () => {
        try {
            if (notesData[comp] && notesData[comp].color) delete notesData[comp].color;
            notesData[comp].lastEdited = new Date().toISOString();
            fs.writeFileSync(NOTES_FILE, JSON.stringify(notesData, null, 2), 'utf8');
            const newColor = getCompColor(comp);
            strip.style.background = newColor;
            createNavigation();
            renderColorPicker(comp);
        } catch (err) {
            logError('Error clearing comp color', err);
            showToast('Fel vid återställning av färg.', 'error');
        }
    };
}

// Create a unified dropdown menu in the header to hold various tools.
function createUnifiedMenu() {
    if (document.getElementById('unified-menu')) return;
    const header = document.querySelector('header');
    if (!header) return;

    // ensure header is positioned so dropdown can be absolute
    header.style.position = header.style.position || 'relative';

    const container = document.createElement('div');
    container.id = 'unified-menu';
    container.style.position = 'absolute';
    container.style.top = '8px';
    container.style.right = '12px';
    container.style.zIndex = '10005';

    const btn = document.createElement('button');
    btn.id = 'unified-menu-btn';
    btn.type = 'button';
    btn.textContent = '☰';
    btn.title = 'Meny';
    btn.style.padding = '6px 8px';
    btn.style.borderRadius = '6px';
    btn.style.border = '1px solid #ccc';
    btn.style.background = '#fff';
    btn.style.cursor = 'pointer';

    const dropdown = document.createElement('div');
    dropdown.id = 'unified-menu-dropdown';
    dropdown.style.position = 'absolute';
    dropdown.style.top = '36px';
    dropdown.style.right = '0';
    dropdown.style.minWidth = '180px';
    dropdown.style.boxShadow = '0 4px 12px rgba(0,0,0,0.12)';
    dropdown.style.border = '1px solid #e6e6e6';
    dropdown.style.borderRadius = '6px';
    dropdown.style.background = '#fff';
    dropdown.style.padding = '8px';
    dropdown.style.display = 'none';
    dropdown.style.boxSizing = 'border-box';

    const makeItem = (text, handler) => {
        const it = document.createElement('button');
        it.type = 'button';
        it.textContent = text;
        it.style.display = 'block';
        it.style.width = '100%';
        it.style.textAlign = 'left';
        it.style.padding = '8px';
        it.style.margin = '0 0 6px 0';
        it.style.border = 'none';
        it.style.background = 'transparent';
        it.style.cursor = 'pointer';
        it.style.borderRadius = '4px';
        it.onmouseenter = () => { it.style.background = '#f5f5f5'; };
        it.onmouseleave = () => { it.style.background = 'transparent'; };
        it.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            try { handler(); } catch (err) { console.error('Menu handler failed', err); }
            dropdown.style.display = 'none';
        });
        return it;
    };

    // Color picker toggle: trigger existing color toggle if present
    dropdown.appendChild(makeItem('Färg', () => {
        try {
            // ensure color picker exists for current comp
            if (typeof renderColorPicker === 'function') renderColorPicker(currentComp);
            const t = document.getElementById('comp-color-toggle');
            if (t) t.click();
            else alert('Färgverktyg inte tillgängligt. Välj en komposition först.');
        } catch (e) { console.error(e); }
    }));

    // Delete current comp (use existing modal flow)
    dropdown.appendChild(makeItem('Ta bort komposition', () => {
        if (!currentComp) { alert('Ingen komposition vald.'); return; }
        try { showDeleteCompModal(currentComp); } catch (e) { console.error(e); }
    }));

    // Logs: open logs folder immediately (no floating button)
    dropdown.appendChild(makeItem('Logs', () => {
        try {
            openLogsFolder();
        } catch (e) { console.error(e); }
    }));

    // Clipboard: copy all
    dropdown.appendChild(makeItem('Kopiera alla', () => { try { exportCompsToClipboard(true); } catch (e) { console.error(e); } }));
    // Clipboard: copy current
    dropdown.appendChild(makeItem('Kopiera aktuell', () => { try { exportCompsToClipboard(false); } catch (e) { console.error(e); } }));
    // Clipboard: paste
    dropdown.appendChild(makeItem('Klistra in från urklipp', () => { try { importCompsFromClipboard(); } catch (e) { console.error(e); } }));

    // attach button and dropdown
    container.appendChild(btn);
    container.appendChild(dropdown);

    // prefer the sidebar header for placement (less intrusive). Fall back to top header
    const sidebarHeader = document.querySelector('.sidebar-header');
    const headerEl = document.querySelector('header');
    const parent = sidebarHeader || headerEl;
    if (parent) {
        // ensure parent is a positioned container
        try { parent.style.position = parent.style.position || 'relative'; } catch (e) {}
        parent.appendChild(container);
    } else {
        // last-resort append to body
        document.body.appendChild(container);
    }

    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        dropdown.style.display = dropdown.style.display === 'none' ? 'block' : 'none';
    });

    // close when clicking outside
    document.addEventListener('click', () => {
        try { dropdown.style.display = 'none'; } catch (e) {}
    });
}

// Initialize app when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
    loadNotes();
    createNavigation();
    setupAutoSave();
    setupImagePaste();

    // Consolidated UI: create a single dropdown menu that exposes
    // color toggle, delete, logs and clipboard actions. This keeps
    // existing logic intact and removes floating buttons.
    createUnifiedMenu();

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
