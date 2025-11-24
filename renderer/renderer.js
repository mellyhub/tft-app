const fs = require('fs');
const path = require('path');
const { ipcRenderer, clipboard, shell } = require('electron'); // added shell

// Path to notes.json in /data directory (relative to project root)
const NOTES_FILE = path.join(__dirname, '..', 'data', 'notes.json');
const SAVE_DELAY = 500; // milliseconds

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
let activeTagFilter = ''; // <-- new: currently selected tag filter

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
    const sorted = comps.sort((a, b) => {
        return a.localeCompare(b);
    });
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
            // ensure notes and items exist
            if (!('notes' in val)) val.notes = '';
            if (!Array.isArray(val.items)) val.items = [];
            if (!Array.isArray(val.tags)) val.tags = []; // <-- new: ensure tags array
            if (!val.lastEdited) val.lastEdited = new Date().toISOString();
        } else {
            // convert legacy string format to object
            notesData[k] = {
                notes: typeof val === 'string' ? val : '',
                items: [],
                tags: [], // <-- new: default tags
                lastEdited: new Date().toISOString()
            };
        }
    });
}

// Load notes from JSON file
function loadNotes() {
    try {
        // Ensure data directory exists
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
        console.error('Error loading notes:', error);
        notesData = {};
    }
}

// Save notes to JSON file (also updates lastEdited for current comp)
function saveNotes() {
    if (!currentComp) return;
    try {
        // Get content from contenteditable div instead of textarea
        const editorDiv = document.getElementById('comp-notes-editor');
        const notesContent = editorDiv ? editorDiv.innerHTML : '';
        
        // If the comp is an object, update notes and preserve items
        if (notesData[currentComp] && typeof notesData[currentComp] === 'object') {
            notesData[currentComp].notes = notesContent;
            notesData[currentComp].lastEdited = new Date().toISOString();
        } else {
            // If not, convert to new format with empty items and set lastEdited
            notesData[currentComp] = {
                notes: notesContent,
                items: [],
                lastEdited: new Date().toISOString()
            };
        }
        // Ensure data directory exists before saving
        const dataDir = path.dirname(NOTES_FILE);
        if (!fs.existsSync(dataDir)) {
            fs.mkdirSync(dataDir, { recursive: true });
        }
        fs.writeFileSync(NOTES_FILE, JSON.stringify(notesData, null, 2), 'utf8');

        // Update nav timestamps immediately
        createNavigation();

        // Update main meta display if present
        const mainMeta = document.getElementById('current-comp-meta');
        if (mainMeta) {
            mainMeta.textContent = `Last edited: ${formatDate(notesData[currentComp].lastEdited)}`;
        }
    } catch (error) {
        console.error('Error saving notes:', error);
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
    // remove tags
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

    // All tokens must match at least one field (title OR notes OR items OR tags)
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

    // Escape tokens for regex and build alternation
    const escaped = tokens.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    const re = new RegExp(`(${escaped.join('|')})`, 'gi');

    // Escape incoming text then replace matches
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

    // Live-search on input (no heavy debounce required; createNavigation is lightweight)
    searchInput.addEventListener('input', (e) => {
        searchQuery = e.target.value || '';
        createNavigation();
        // If currently viewing a comp, keep its editor content unchanged (avoid reloading unless switching)
    });

    // Keyboard shortcuts for search input:
    // Enter -> switch to first matching comp (if any)
    // Escape -> clear search
    searchInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            const compOrder = getCompOrder();
            const first = compOrder.find(c => compMatchesSearch(c, searchQuery));
            if (first) {
                // switch to notes view
                const notesInterface = document.getElementById('notes-interface');
                const plannerInterface = document.getElementById('planner-interface');
                if (notesInterface && plannerInterface) {
                    notesInterface.style.display = '';
                    plannerInterface.style.display = 'none';
                }
                switchToComp(first);
                // focus editor
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

// Get a sorted list of all tags present in notesData
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

// Toggle/set active tag filter
function setTagFilter(tag) {
    if (!tag) {
        activeTagFilter = '';
    } else if (activeTagFilter === tag) {
        activeTagFilter = '';
    } else {
        activeTagFilter = tag;
    }
    // update navigation and tag UI
    createNavigation();
    const input = document.getElementById('tag-filter-input');
    if (input) input.value = activeTagFilter || '';
}

// Create a simple tag filter UI above the navigation
function createTagFilterUI() {
    const nav = document.getElementById('comp-nav');
    if (!nav) return;

    // Container placed directly above nav; reuse if exists
    let container = document.getElementById('tag-filter-container');
    if (!container) {
        container = document.createElement('div');
        container.id = 'tag-filter-container';
        container.style.padding = '8px';
        container.style.borderBottom = '1px solid #eee';
        nav.parentNode.insertBefore(container, nav);
    }

    // Render input + tag chips
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

    // Render chips
    tagList.innerHTML = tags.map(t => {
        const active = (t === activeTagFilter) ? 'background:#e6f4ff;border-color:#9ad1ff;' : '';
        return `<button class="tag-chip" data-tag="${t}" style="padding:4px 8px;border-radius:12px;border:1px solid #ccc;${active};cursor:pointer;font-size:0.85rem">${t}</button>`;
    }).join('');

    tagList.querySelectorAll('.tag-chip').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const tag = btn.getAttribute('data-tag');
            setTagFilter(tag);
            createTagFilterUI();
        });
    });
}

// Create navigation buttons for all comps
function createNavigation() {
    const nav = document.getElementById('comp-nav');
    if (!nav) return;
    nav.innerHTML = '';

    // ensure tag UI is present above nav
    createTagFilterUI();

    const compOrder = getCompOrder();
    const filteredComps = compOrder.filter(comp => {
        // filter by search query first
        if (searchQuery && searchQuery.trim() !== '' && !compMatchesSearch(comp, searchQuery)) return false;
        // then filter by active tag if any
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
        button.setAttribute('data-comp', comp);

        // Determine lastEdited for this comp
        const compData = notesData[comp] && typeof notesData[comp] === 'object' ? notesData[comp] : null;
        const lastEdited = compData ? compData.lastEdited : null;
        const tags = compData && Array.isArray(compData.tags) ? compData.tags : [];

        // Title with optional highlighted search matches
        const titleHtml = searchQuery
            ? highlightSearchMatches(capitalizeCompName(comp), searchQuery)
            : capitalizeCompName(comp);

        // Build tags html
        const tagsHtml = tags.length ? `<div class="nav-tags">${tags.map(t => `<span class="nav-tag" data-tag="${t}" style="display:inline-block;padding:2px 6px;margin:4px 4px 0 0;border-radius:10px;background:#f1f1f1;border:1px solid #e0e0e0;cursor:pointer;font-size:0.75rem;">${t}</span>`).join('')}</div>` : '';

        // Build innerHTML with title, tags and meta timestamp
        const metaHtml = lastEdited ? `<div class="nav-meta">Senast ändrad: ${formatDate(lastEdited)}</div>` : '';
        button.innerHTML = `<div class="nav-title">${titleHtml}</div>${tagsHtml}${metaHtml}`;

        button.addEventListener('click', () => {
            // Always show notes view and hide planner view when selecting a comp
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

    // tag click delegation: handle clicks on .nav-tag elements to toggle tag filter
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
    console.log('Switching to comp:', comp);
    // Update active button
    document.querySelectorAll('.nav-button').forEach(btn => {
        btn.classList.remove('active');
        if (btn.getAttribute('data-comp') === comp) {
            btn.classList.add('active');
        }
    });
    
    // Update delete button to work with current comp
    const deleteBtn = document.getElementById('delete-current-comp-btn');
    if (deleteBtn) {
        // Remove old event listeners by cloning
        const newDeleteBtn = deleteBtn.cloneNode(true);
        deleteBtn.parentNode.replaceChild(newDeleteBtn, deleteBtn);
        newDeleteBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            showDeleteCompModal(comp);
        });
    }
    
    // Save current comp before switching
    if (currentComp) {
        saveNotes();
    }
    
    // Update current comp
    currentComp = comp;
    
    // Show tab content and hide no-selection message
    document.getElementById('no-selection').classList.add('hidden');
    document.getElementById('tab-content').classList.remove('hidden');
    
    // Update title
    document.getElementById('current-comp-title').textContent = capitalizeCompName(comp);
    
    // Get notes and items for the comp (new structure)
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
    
    // Update main meta display (if element exists)
    const mainMeta = document.getElementById('current-comp-meta');
    if (mainMeta) {
        const lastEdited = compObj && compObj.lastEdited ? compObj.lastEdited : null;
        mainMeta.textContent = lastEdited ? `Last edited: ${formatDate(lastEdited)}` : '';
    }
    
    console.log('Comp data:', { comp, notesText: notesText.substring(0, 50), itemsArr });

    // Get or create items div
    let itemsDiv = document.getElementById('comp-items');
    if (!itemsDiv) {
        itemsDiv = document.createElement('div');
        itemsDiv.id = 'comp-items';
        itemsDiv.className = 'comp-items';
        const tabContent = document.getElementById('tab-content');
        const tabHeader = tabContent.querySelector('.tab-header');
        if (tabHeader) {
            tabHeader.insertAdjacentElement('afterend', itemsDiv);
        }
    }
    
    // Update items div content
    itemsDiv.innerHTML = `
        <strong>Items:</strong>
        <input id="comp-items-input" class="comp-items-input" type="text" value="${itemsArr.join(', ')}" placeholder="Sword, Bow, Rod">
        <button id="save-items-btn" class="save-items-btn" title="Spara items">💾</button>
        <span id="items-saved-msg" class="items-saved-msg" style="display:none; margin-left:8px; color:#4caf50; font-size:0.95em;">${SYSTEM_MESSAGES.saved}</span>
    `;
    
    // Add save logic for items
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
            // Save file and update UI
            try {
                fs.writeFileSync(NOTES_FILE, JSON.stringify(notesData, null, 2), 'utf8');
            } catch (error) {
                console.error('Error saving items:', error);
            }
            createNavigation();
            if (savedMsg) {
                savedMsg.textContent = SYSTEM_MESSAGES.saved;
                savedMsg.style.display = 'inline';
                setTimeout(() => { savedMsg.style.display = 'none'; }, 1200);
            }
            // update main meta
            const mainMeta2 = document.getElementById('current-comp-meta');
            if (mainMeta2) mainMeta2.textContent = `Last edited: ${formatDate(notesData[comp].lastEdited)}`;
        });
        // Save on Enter
        itemsInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                saveBtn.click();
                itemsInput.blur();
            }
        });
    }

    // Update contenteditable div with HTML content
    const editorDiv = document.getElementById('comp-notes-editor');
    if (editorDiv) {
        console.log('Setting editor HTML, length:', notesText.length);
        editorDiv.innerHTML = notesText || '';
        // Ensure the editor is visible and focused
        editorDiv.style.display = '';
    }

    // Show delete button
    const headerDeleteBtn = document.getElementById('delete-current-comp-btn');
    if (headerDeleteBtn) {
        headerDeleteBtn.style.display = 'flex';
    }
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
    
    // Check if comp already exists
    if (trimmedName in notesData) {
        alert(SYSTEM_MESSAGES.addCompExists);
        input.focus();
        return;
    }
    
    // Save current comp before adding new one
    if (currentComp) {
        saveNotes();
    }
    
    // Add new comp with empty notes, tags and timestamp
    notesData[trimmedName] = {
        notes: '',
        items: [],
        tags: [], // <-- new: tags field
        lastEdited: new Date().toISOString()
    };
    
    // Save to file
    try {
        const dataDir = path.dirname(NOTES_FILE);
        if (!fs.existsSync(dataDir)) {
            fs.mkdirSync(dataDir, { recursive: true });
        }
        fs.writeFileSync(NOTES_FILE, JSON.stringify(notesData, null, 2), 'utf8');
    } catch (error) {
        console.error('Error saving notes:', error);
        alert('Ett fel uppstod vid sparande: ' + error.message);
        return;
    }
    
    // Hide modal
    hideAddCompModal();
    
    // Refresh navigation and switch to new comp
    createNavigation();
    switchToComp(trimmedName);
}

// Show delete confirmation modal (now uses native dialog via main process, falls back to in-app modal)
async function showDeleteCompModal(comp) {
    // Try native confirmation dialog first
    try {
        const confirmed = await safeInvoke('confirm-delete', comp);
        if (confirmed) {
            // Proceed to delete
            deleteComp(comp);
        } else {
            // User cancelled - do nothing
        }
    } catch (err) {
        logWarn('Native confirm failed, falling back to modal', err);
        // Fallback: show existing in-app modal UI
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
// Accept an optional comp parameter; if omitted, read from modal attribute (backwards compatible)
function deleteComp(comp) {
    const modal = document.getElementById('delete-comp-modal');
    if (!comp && modal) {
        comp = modal.getAttribute('data-comp-to-delete');
    }

    if (!comp) {
        console.error('No comp to delete specified');
        hideDeleteCompModal();
        return;
    }

    console.log('Deleting comp:', comp);

    const compOrder = getCompOrder();

    // Don't allow deleting if it's the only comp
    if (compOrder.length <= 1) {
        alert(SYSTEM_MESSAGES.deleteLastComp);
        hideDeleteCompModal();
        return;
    }

    // Save current comp before deleting
    if (currentComp) {
        saveNotes();
    }

    // Find another comp to switch to BEFORE deleting
    let switchTo = null;
    if (currentComp === comp) {
        const currentIndex = compOrder.indexOf(comp);
        if (currentIndex < compOrder.length - 1) {
            switchTo = compOrder[currentIndex + 1];
        } else if (currentIndex > 0) {
            switchTo = compOrder[currentIndex - 1];
        }
    }

    // Delete the comp from notesData
    if (!(comp in notesData)) {
        console.error('Comp not found in notesData:', comp);
        hideDeleteCompModal();
        return;
    }

    const compData = notesData[comp];
    delete notesData[comp];

    // Save to file
    try {
        fs.writeFileSync(NOTES_FILE, JSON.stringify(notesData, null, 2), 'utf8');
    } catch (error) {
        console.error('Error saving notes:', error);
        // Restore on failure
        notesData[comp] = compData;
        alert('Ett fel uppstod vid borttagning: ' + error.message);
        hideDeleteCompModal();
        return;
    }

    // Hide modal if open
    hideDeleteCompModal();

    const wasCurrentComp = (currentComp === comp);
    if (wasCurrentComp) {
        currentComp = null;
    }

    // Refresh navigation
    createNavigation();

    // Switch to another comp if needed
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

// Setup textarea auto-save
function setupAutoSave() {
    const editorDiv = document.getElementById('comp-notes-editor');
    if (editorDiv) {
        editorDiv.addEventListener('input', debouncedSave);
    }
}

// Setup search functionality
function setupSearch() {
    const searchInput = document.getElementById('search-input');
    if (!searchInput) return;

    // Live-search on input (no heavy debounce required; createNavigation is lightweight)
    searchInput.addEventListener('input', (e) => {
        searchQuery = e.target.value || '';
        createNavigation();
        // If currently viewing a comp, keep its editor content unchanged (avoid reloading unless switching)
    });

    // Keyboard shortcuts for search input:
    // Enter -> switch to first matching comp (if any)
    // Escape -> clear search
    searchInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            const compOrder = getCompOrder();
            const first = compOrder.find(c => compMatchesSearch(c, searchQuery));
            if (first) {
                // switch to notes view
                const notesInterface = document.getElementById('notes-interface');
                const plannerInterface = document.getElementById('planner-interface');
                if (notesInterface && plannerInterface) {
                    notesInterface.style.display = '';
                    plannerInterface.style.display = 'none';
                }
                switchToComp(first);
                // focus editor
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

    // Clear previous content
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
            // All selected items must be present in the comp's items
            return selectedItems.every(item => data.items.map(i => i.toLowerCase()).includes(item));
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
        // Add click event to each comp title to switch to that comp
        resultsDiv.querySelectorAll('.planner-comp-title').forEach(el => {
            el.addEventListener('click', (e) => {
                const comp = e.target.getAttribute('data-comp');
                if (comp) {
                    // Switch to notes view and show the selected comp
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
                            // Insert image tag into editor
                            const imgPath = `../data/images/${filename}`;
                            const imgTag = `<img src="${imgPath}" alt="pasted-image" style="max-width:100%; border-radius:4px; margin:0.5rem 0;">`;

                            // Insert at cursor position using execCommand
                            document.execCommand('insertHTML', false, imgTag);

                            // Auto-save after inserting image
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

        // If no image, handle normal paste
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
                    console.warn('Failed to read image for clipboard export:', f, err);
                }
            }
        }

        clipboard.writeText(JSON.stringify(exportObj));
        alert('Kompositioner kopierade till urklipp (inkl. bilder).');
    } catch (error) {
        console.error('Clipboard export failed', error);
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

        // Ensure images dir exists
        const imagesDir = path.join(__dirname, '..', 'data', 'images');
        if (!fs.existsSync(imagesDir)) fs.mkdirSync(imagesDir, { recursive: true });

        // Write images (handle collisions by renaming)
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
                console.warn('Failed to write imported image', name, err);
            }
        }

        // Merge comps into notesData with collision-safe names
        const importedNames = [];
        Object.entries(comps).forEach(([name, data]) => {
            let target = name;
            if (target in notesData) {
                const base = target;
                let i = 1;
                while ((`${base}-imported${i > 1 ? '-' + i : ''}`) in notesData) i++;
                target = `${base}-imported${i > 1 ? '-' + i : ''}`;
            }
            // If comp references images by original filenames, user images were renamed; best-effort replace
            if (data && typeof data === 'object' && data.notes && Object.keys(writtenImages).length) {
                let notesHtml = data.notes;
                Object.entries(writtenImages).forEach(([orig, newName]) => {
                    // replace occurrences of original image path with new path
                    notesHtml = notesHtml.split(`../data/images/${orig}`).join(`../data/images/${newName}`);
                    notesHtml = notesHtml.split(`data/images/${orig}`).join(`../data/images/${newName}`);
                    notesHtml = notesHtml.split(orig).join(newName);
                });
                data.notes = notesHtml;
            }
            // Ensure structure
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

        // Save to file
        try {
            const dataDir = path.dirname(NOTES_FILE);
            if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
            fs.writeFileSync(NOTES_FILE, JSON.stringify(notesData, null, 2), 'utf8');
        } catch (err) {
            console.error('Failed to save notes after import', err);
            alert('Fel vid sparande efter import: ' + (err && err.message ? err.message : String(err)));
            return;
        }

        // Reload UI
        loadNotes();
        createNavigation();

        alert('Import klart. Kompositioner importerade: ' + (importedNames.length ? importedNames.join(', ') : '0'));
    } catch (error) {
        console.error('Clipboard import failed', error);
        alert('Import misslyckades: ' + (error && error.message ? error.message : String(error)));
    }
}

// Small clipboard toolbar UI (copy/paste)
function createClipboardToolbar() {
    if (document.getElementById('clipboard-toolbar')) return;

    const toolbar = document.createElement('div');
    toolbar.id = 'clipboard-toolbar';
    toolbar.style.position = 'fixed';
    toolbar.style.left = '12px';
    toolbar.style.bottom = '12px';
    toolbar.style.zIndex = '9999';
    toolbar.style.display = 'flex';
    toolbar.style.gap = '8px';

    const btnStyle = 'padding:6px 10px;border-radius:6px;border:1px solid #ccc;background:#fff;cursor:pointer;font-size:0.85rem;';

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
    btn.style.left = '12px';
    btn.style.bottom = '68px'; // above clipboard toolbar
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
            // Try to open directly using shell
            const opened = await shell.openPath(LOG_DIR);
            // shell.openPath returns '' on success, otherwise error string
            if (opened && opened.length) {
                // fallback: ask main process (if available)
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
}

// Initialize app when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
    loadNotes();
    createNavigation();
    setupAutoSave();
    setupImagePaste();

    // Create clipboard toolbar for export/import
    createClipboardToolbar();

    // Create log button UI
    setTimeout(createLogButtonUI, 50);

    // Setup add button (do it here to ensure DOM is ready)
    const addBtn = document.getElementById('add-comp-btn');
    if (addBtn) {
        addBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            showAddCompModal();
        });
    }
    
    // Setup modal buttons
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
    
    // Allow Enter key to submit
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
    
    // Close modal when clicking outside
    const addModal = document.getElementById('add-comp-modal');
    if (addModal) {
        addModal.addEventListener('click', (e) => {
            if (e.target === addModal) {
                hideAddCompModal();
            }
        });
    }
    
    // Setup delete confirmation modal
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
    
    // Show no-selection message initially
    document.getElementById('no-selection').classList.remove('hidden');
    document.getElementById('tab-content').classList.add('hidden');
    
    // Setup search functionality
    setupSearch();

    // Setup Planner tab button
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
