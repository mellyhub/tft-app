const fs = require('fs');
const path = require('path');
const { ipcRenderer } = require('electron');

// Path to notes.json in /data directory (relative to project root)
const NOTES_FILE = path.join(__dirname, '..', 'data', 'notes.json');
const SAVE_DELAY = 500; // milliseconds

let saveTimeout = null;
let currentComp = null;
let notesData = {};
let searchQuery = '';

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
        } else {
            notesData = {};
            fs.writeFileSync(NOTES_FILE, JSON.stringify(notesData, null, 2), 'utf8');
        }
    } catch (error) {
        console.error('Error loading notes:', error);
        notesData = {};
    }
}

// Save notes to JSON file
function saveNotes() {
    if (!currentComp) return;
    try {
        // Get content from contenteditable div instead of textarea
        const editorDiv = document.getElementById('comp-notes-editor');
        const notesContent = editorDiv ? editorDiv.innerHTML : '';
        
        // If the comp is an object, update notes and preserve items
        if (notesData[currentComp] && typeof notesData[currentComp] === 'object') {
            notesData[currentComp].notes = notesContent;
        } else {
            // If not, convert to new format with empty items
            notesData[currentComp] = {
                notes: notesContent,
                items: []
            };
        }
        // Ensure data directory exists before saving
        const dataDir = path.dirname(NOTES_FILE);
        if (!fs.existsSync(dataDir)) {
            fs.mkdirSync(dataDir, { recursive: true });
        }
        fs.writeFileSync(NOTES_FILE, JSON.stringify(notesData, null, 2), 'utf8');
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

// Check if a composition matches the search query
function compMatchesSearch(comp, query) {
    if (!query || query.trim() === '') return true;
    
    const queryLower = query.toLowerCase();
    const compName = comp.toLowerCase();
    const notes = (notesData[comp] || '').toLowerCase();
    
    return compName.includes(queryLower) || notes.includes(queryLower);
}

// Highlight search matches in text
function highlightSearchMatches(text, query) {
    if (!query || query.trim() === '') return text;
    
    const regex = new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
    return text.replace(regex, '<mark class="search-highlight">$1</mark>');
}

// Create navigation buttons for all comps
function createNavigation() {
    const nav = document.getElementById('comp-nav');
    nav.innerHTML = '';
    
    const compOrder = getCompOrder();
    const filteredComps = searchQuery 
        ? compOrder.filter(comp => compMatchesSearch(comp, searchQuery))
        : compOrder;
    
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
        button.textContent = capitalizeCompName(comp);
        button.setAttribute('data-comp', comp);
        
        // Highlight search matches in button text
        if (searchQuery) {
            const highlighted = highlightSearchMatches(capitalizeCompName(comp), searchQuery);
            button.innerHTML = highlighted;
        }
        
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
    if (notesData[comp] && typeof notesData[comp] === 'object') {
        notesText = notesData[comp].notes || '';
        itemsArr = notesData[comp].items || [];
    } else {
        notesText = notesData[comp] || '';
        itemsArr = [];
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
            } else {
                notesData[comp] = { notes: notesText, items: newItems };
            }
            saveNotes();
            savedMsg.textContent = SYSTEM_MESSAGES.saved;
            savedMsg.style.display = 'inline';
            setTimeout(() => { savedMsg.style.display = 'none'; }, 1200);
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
    
    // Add new comp with empty notes
    notesData[trimmedName] = '';
    
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

// Show delete confirmation modal
function showDeleteCompModal(comp) {
    const modal = document.getElementById('delete-comp-modal');
    const message = document.getElementById('delete-comp-message');
    message.textContent = SYSTEM_MESSAGES.deleteConfirm(comp);
    modal.setAttribute('data-comp-to-delete', comp);
    modal.classList.remove('hidden');
}

// Hide delete confirmation modal
function hideDeleteCompModal() {
    const modal = document.getElementById('delete-comp-modal');
    modal.classList.add('hidden');
    modal.removeAttribute('data-comp-to-delete');
}

// Delete a composition (called after confirmation)
function deleteComp() {
    const modal = document.getElementById('delete-comp-modal');
    const comp = modal.getAttribute('data-comp-to-delete');
    
    if (!comp) {
        console.error('No comp to delete found in modal');
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
        // Try to switch to next comp, or previous if it's the last one
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
    
    // Store the comp data temporarily in case we need to restore
    const compData = notesData[comp];
    delete notesData[comp];
    
    // Verify deletion
    if (comp in notesData) {
        console.error('Failed to delete comp from notesData');
        hideDeleteCompModal();
        return;
    }
    
    console.log('Comp deleted from notesData. Remaining comps:', Object.keys(notesData));
    
    // Save to file
    try {
        fs.writeFileSync(NOTES_FILE, JSON.stringify(notesData, null, 2), 'utf8');
        console.log('Notes file saved after deletion');
        
        // Verify the file was saved correctly by reading it back
        const savedData = JSON.parse(fs.readFileSync(NOTES_FILE, 'utf8'));
        if (comp in savedData) {
            console.error('Comp still exists in saved file!');
            // Restore and abort
            notesData[comp] = compData;
            fs.writeFileSync(NOTES_FILE, JSON.stringify(notesData, null, 2), 'utf8');
            alert('Ett fel uppstod vid borttagning. Kompositionen kunde inte tas bort.');
            hideDeleteCompModal();
            return;
        }
    } catch (error) {
        console.error('Error saving notes:', error);
        // Restore the comp if save failed
        notesData[comp] = compData;
        alert('Ett fel uppstod vid borttagning: ' + error.message);
        hideDeleteCompModal();
        return;
    }
    
    // Hide modal first
    hideDeleteCompModal();
    
    // Update currentComp if we deleted the current one
    const wasCurrentComp = (currentComp === comp);
    if (wasCurrentComp) {
        currentComp = null;
    }
    
    // Refresh navigation FIRST (this will rebuild the list from updated notesData)
    createNavigation();
    
    // Then switch to another comp if needed
    if (wasCurrentComp) {
        if (switchTo && switchTo in notesData) {
            // Small delay to ensure navigation is fully updated
            setTimeout(() => {
                switchToComp(switchTo);
            }, 10);
        } else {
            // Show no-selection if we deleted the current comp and have no other to switch to
            document.getElementById('no-selection').classList.remove('hidden');
            document.getElementById('tab-content').classList.add('hidden');
            const headerDeleteBtn = document.getElementById('delete-current-comp-btn');
            if (headerDeleteBtn) {
                headerDeleteBtn.style.display = 'none';
            }
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
    searchInput.addEventListener('input', (e) => {
        searchQuery = e.target.value;
        createNavigation();
        // Clear editor display - don't show highlighted matches
        if (currentComp) {
            const editorDiv = document.getElementById('comp-notes-editor');
            const notesText = notesData[currentComp] || '';
            if (editorDiv && typeof notesData[currentComp] === 'object') {
                editorDiv.innerHTML = notesData[currentComp].notes || '';
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
                        const result = await ipcRenderer.invoke('save-image', base64data, filename);
                        if (result.success) {
                            // Insert image tag into editor
                            const imgPath = `../data/images/${filename}`;
                            const imgTag = `<img src="${imgPath}" alt="pasted-image" style="max-width:100%; border-radius:4px; margin:0.5rem 0;">`;
                            
                            // Insert at cursor position using execCommand
                            document.execCommand('insertHTML', false, imgTag);
                            
                            // Auto-save after inserting image
                            debouncedSave();
                        }
                    } catch (error) {
                        console.error('Error saving image:', error);
                        alert('Failed to save image: ' + error.message);
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

// Initialize app when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
    loadNotes();
    createNavigation();
    setupAutoSave();
    setupImagePaste();
    
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
