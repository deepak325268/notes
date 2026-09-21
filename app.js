// ==========================================
// 1. SUPABASE SETUP
// ==========================================
const SUPABASE_URL = 'https://grjiljowzclkqrpwavnj.supabase.co';
const SUPABASE_KEY = 'sb_publishable_QkFJZLtolSb8SNIUhqyLbA_jLB1DarC';
const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

// ==========================================
// 2. SECURITY PIN (ENCRYPTED) 🔒
// ==========================================
const SECRET_HASH = "48719"; // "131" ka encrypted code
let isUnlocked = localStorage.getItem('notes_unlocked') === 'true';

function encryptPIN(pin) {
    let hash = 0;
    for (let i = 0; i < pin.length; i++) {
        let char = pin.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash;
    }
    return hash.toString();
}

function toggleLock() {
    if (isUnlocked) {
        localStorage.setItem('notes_unlocked', 'false');
        location.reload();
    } else {
        const pin = prompt("Enter Secret PIN to Unlock Editing:");
        if (pin !== null) {
            if (encryptPIN(pin) === SECRET_HASH) {
                localStorage.setItem('notes_unlocked', 'true');
                location.reload();
            } else {
                alert("❌ Wrong PIN! You cannot edit.");
            }
        }
    }
}

// ==========================================
// 3. STATE MANAGEMENT
// ==========================================
let appData = { categories: [] };
let currentCategoryId = null;
let currentBookId = null;
let currentChapterId = null;
let editor = null;
let saveTimeout = null;

// ==========================================
// 4. INITIALIZATION & DATA LOADING
// ==========================================
window.onload = async () => {
    document.getElementById('saveStatus').innerText = "☁️ Loading...";

    if (isUnlocked) {
        document.getElementById('adminControls').style.display = 'block';
        document.getElementById('lockBtn').innerHTML = '🔓 Lock Editing';
        document.getElementById('lockBtn').style.background = '#eef2ff';
        document.getElementById('lockBtn').style.borderColor = '#4361ee';
    }

    await loadDataFromCloud();
    renderSidebar();
};

async function loadDataFromCloud() {
    try {
        const { data, error } = await supabaseClient.from('notes_db').select('data').eq('id', 1).single();
        if (error && error.code !== 'PGRST116') throw error;

        if (data && data.data) {
            appData = data.data;
            migrateOldData();
        }
        document.getElementById('saveStatus').innerText = "☁️ Synced";
    } catch (err) {
        document.getElementById('saveStatus').innerText = "⚠️ Offline Mode";
        const local = localStorage.getItem('bookNotesBackup');
        if (local) {
            appData = JSON.parse(local);
            migrateOldData();
        }
    }
}

function migrateOldData() {
    if (!appData.categories) {
        appData.categories = [];
        if (appData.books && appData.books.length > 0) {
            appData.categories.push({
                id: generateId(),
                title: "पुरानी किताबें (Old Books)",
                books: appData.books
            });
        }
        delete appData.books;
        triggerAutoSave();
    }
}

async function triggerAutoSave() {
    if (!isUnlocked) return;
    document.getElementById('saveStatus').innerText = "⏳ Saving...";
    clearTimeout(saveTimeout);
    saveTimeout = setTimeout(async () => {
        try {
            appData.lastUpdated = new Date().toISOString();
            localStorage.setItem('bookNotesBackup', JSON.stringify(appData));

            const { error } = await supabaseClient.from('notes_db').upsert({ id: 1, data: appData });
            if (error) throw error;
            document.getElementById('saveStatus').innerText = "☁️ Saved";

            const today = new Date().toISOString().split('T')[0];
            const lastBackup = localStorage.getItem('lastCloudBackupDate');
            if (lastBackup !== today && appData.categories.length > 0) {
                const { error: backupError } = await supabaseClient.from('auto_backups').upsert({ backup_date: today, data: appData });
                if (!backupError) {
                    localStorage.setItem('lastCloudBackupDate', today);
                    
                    const { data: allBackups } = await supabaseClient.from('auto_backups').select('backup_date').order('backup_date', { ascending: false });
                    if (allBackups && allBackups.length > 15) {
                        const oldBackupsToDelete = allBackups.slice(15).map(b => b.backup_date);
                        await supabaseClient.from('auto_backups').delete().in('backup_date', oldBackupsToDelete);
                    }
                }
            }
        } catch (err) {
            document.getElementById('saveStatus').innerText = "⚠️ Save Failed";
        }
    }, 1500);
}

// ==========================================
// 5. UI RENDERING & NAVIGATION (WITH SMART HIDE)
// ==========================================
function generateId() { return Math.random().toString(36).substr(2, 9); }

function renderSidebar() {
    const list = document.getElementById('bookList');
    list.innerHTML = '';

    (appData.categories || []).forEach(category => {
        const catDiv = document.createElement('div');
        catDiv.className = `list-item ${currentCategoryId === category.id && !currentBookId ? 'active' : ''}`;
        catDiv.style.backgroundColor = "#eef2ff";
        catDiv.style.borderBottom = "1px solid #ccc";

        const catActions = isUnlocked ? `<div class="actions">
            <i class="fas fa-plus" onclick="addBookTo('${category.id}', event)" title="Add Book"></i>
            <i class="fas fa-edit" onclick="renameCategory('${category.id}', event)" title="Rename Subject"></i>
            <i class="fas fa-trash" onclick="deleteCategory('${category.id}', event)" title="Delete Subject"></i>
        </div>` : ``;

        catDiv.innerHTML = `<span onclick="openCategory('${category.id}')" style="font-weight:bold; flex:1; color:#2b2d42;">📁 ${category.title}</span>${catActions}`;
        list.appendChild(catDiv);

        if (currentCategoryId === category.id) {
            const booksContainer = document.createElement('div');
            booksContainer.style.borderLeft = "2px solid #ccc";
            booksContainer.style.marginLeft = "10px";

            (category.books || []).forEach(book => {
                // SMART HIDE: Baaki books ko chhupao agar koi dusri book selected hai
                if (currentBookId !== null && currentBookId !== book.id) return;

                const bookDiv = document.createElement('div');
                bookDiv.className = `list-item ${currentBookId === book.id && !currentChapterId ? 'active' : ''}`;
                bookDiv.style.paddingLeft = "10px";

                const bookActions = isUnlocked ? `<div class="actions">
                    <i class="fas fa-plus" onclick="addChapterTo('${category.id}', '${book.id}', event)" title="Add Chapter"></i>
                    <i class="fas fa-edit" onclick="renameBook('${category.id}', '${book.id}', event)" title="Rename Book"></i>
                    <i class="fas fa-trash" onclick="deleteBook('${category.id}', '${book.id}', event)" title="Delete Book"></i>
                </div>` : ``;

                bookDiv.innerHTML = `<span onclick="openBook('${category.id}', '${book.id}')" style="font-weight:bold; flex:1; color:#4361ee;">📚 ${book.title}</span>${bookActions}`;
                booksContainer.appendChild(bookDiv);

                if (currentBookId === book.id) {
                    const chapContainer = document.createElement('div');
                    chapContainer.style.borderLeft = "2px solid #4361ee";
                    chapContainer.style.marginLeft = "15px";

                    (book.chapters || []).forEach(chapter => {
                        const chapDiv = document.createElement('div');
                        chapDiv.className = `list-item ${currentChapterId === chapter.id ? 'active' : ''}`;
                        chapDiv.style.paddingLeft = "10px";

                        const chapActions = isUnlocked ? `<div class="actions">
                            <i class="fas fa-edit" onclick="renameChapter('${category.id}', '${book.id}', '${chapter.id}', event)" title="Rename Chapter"></i>
                            <i class="fas fa-trash" onclick="deleteChapter('${category.id}', '${book.id}', '${chapter.id}', event)"></i>
                        </div>` : ``;

                        chapDiv.innerHTML = `<span onclick="openChapter('${category.id}', '${book.id}', '${chapter.id}')" style="font-size:0.9rem; flex:1; color:#444;">📑 ${chapter.title}</span>${chapActions}`;
                        chapContainer.appendChild(chapDiv);
                    });
                    booksContainer.appendChild(chapContainer);
                }
            });
            list.appendChild(booksContainer);
        }
    });
}

function updateBreadcrumb(text) { document.getElementById('breadcrumb').innerText = text; }

// --- ADDING DATA ---
function addNewCategory() {
    if(!isUnlocked) return;
    const title = prompt("Enter Subject / Category Name (e.g. भूगोल):");
    if (!title) return;
    if (!appData.categories) appData.categories = [];
    appData.categories.push({ id: generateId(), title: title, books: [] });
    triggerAutoSave(); renderSidebar();
}

function addBookTo(catId, e) {
    if(!isUnlocked) return;
    if(e) e.stopPropagation();
    const cat = appData.categories.find(c => c.id === catId);
    const title = prompt("Enter Book/Class Name (e.g. कक्षा 6):");
    if (!title) return;
    if(!cat.books) cat.books = [];
    cat.books.push({ id: generateId(), title: title, chapters: [] });
    triggerAutoSave(); openCategory(catId);
}

function addChapterTo(catId, bId, e) {
    if(!isUnlocked) return;
    if(e) e.stopPropagation();
    const cat = appData.categories.find(c => c.id === catId);
    const book = cat.books.find(b => b.id === bId);
    let title = prompt("Enter Chapter Name:");
    if (title === null) return;
    if (title.trim() === "") title = "Chapter " + ((book.chapters || []).length + 1);

    if(!book.chapters) book.chapters = [];
    book.chapters.push({ id: generateId(), title: title, content: "" });
    triggerAutoSave(); openBook(catId, bId);
}

// --- RENAMING DATA ---
function renameCategory(id, e) {
    if(!isUnlocked) return;
    if(e) e.stopPropagation();
    const cat = appData.categories.find(c => c.id === id);
    const newTitle = prompt("Rename Category / Subject:", cat.title);
    if (newTitle && newTitle.trim() !== "") {
        cat.title = newTitle.trim();
        triggerAutoSave(); renderSidebar();
        if (currentCategoryId === id && !currentBookId) openCategory(id);
    }
}

function renameBook(catId, bookId, e) {
    if(!isUnlocked) return;
    if(e) e.stopPropagation();
    const cat = appData.categories.find(c => c.id === catId);
    const book = cat.books.find(b => b.id === bookId);
    const newTitle = prompt("Rename Book:", book.title);
    if (newTitle && newTitle.trim() !== "") {
        book.title = newTitle.trim();
        triggerAutoSave(); renderSidebar();
        if (currentBookId === bookId && !currentChapterId) openBook(catId, bookId);
        else if (currentCategoryId === catId && !currentBookId) openCategory(catId);
    }
}

function renameChapter(catId, bookId, chapId, e) {
    if(!isUnlocked) return;
    if(e) e.stopPropagation();
    const cat = appData.categories.find(c => c.id === catId);
    const book = cat.books.find(b => b.id === bookId);
    const chapter = book.chapters.find(c => c.id === chapId);
    const newTitle = prompt("Rename Chapter:", chapter.title);
    if (newTitle && newTitle.trim() !== "") {
        chapter.title = newTitle.trim();
        triggerAutoSave(); renderSidebar();
        if (currentChapterId === chapId) openChapter(catId, bookId, chapId);
        else if (currentBookId === bookId && !currentChapterId) openBook(catId, bookId);
    }
}

// --- OPENING VIEWS ---
function openCategory(catId) {
    currentCategoryId = catId; currentBookId = null; currentChapterId = null;
    const cat = appData.categories.find(c => c.id === catId);
    updateBreadcrumb(`📁 ${cat.title}`); renderSidebar();

    let html = `<div class="view-header"><h2>Books in ${cat.title}</h2>
        ${isUnlocked ? `<button class="btn-add" onclick="addBookTo('${cat.id}')"><i class="fas fa-plus"></i> Add Book</button>` : ``}
    </div><div class="grid-list">`;

    if (!cat.books || cat.books.length === 0) html += `<p>No books yet in this subject.</p>`;
    (cat.books || []).forEach(b => {
        html += `<div class="grid-card" onclick="openBook('${cat.id}', '${b.id}')">
            <span>📚 ${b.title}</span>
            ${isUnlocked ? `<div class="actions">
                <i class="fas fa-edit" onclick="renameBook('${cat.id}', '${b.id}', event)"></i>
                <i class="fas fa-trash" onclick="deleteBook('${cat.id}', '${b.id}', event)"></i>
            </div>` : ``}
        </div>`;
    });
    html += `</div>`;
    document.getElementById('contentArea').innerHTML = html;
    if(window.innerWidth <= 768) toggleSidebar();
}

function openBook(catId, bookId) {
    currentCategoryId = catId; currentBookId = bookId; currentChapterId = null;
    const cat = appData.categories.find(c => c.id === catId);
    const book = cat.books.find(b => b.id === bookId);
    updateBreadcrumb(`📁 ${cat.title} > 📘 ${book.title}`); renderSidebar();

    let html = `<div class="view-header">
        <h2>Chapters in ${book.title}</h2>
        ${isUnlocked ? `<button class="btn-add" onclick="addChapterTo('${cat.id}', '${book.id}')"><i class="fas fa-plus"></i> Add Chapter</button>` : ``}
    </div><div class="grid-list">`;

    if (!book.chapters || book.chapters.length === 0) html += `<p>No chapters yet.</p>`;
    (book.chapters || []).forEach(ch => {
        html += `<div class="grid-card" onclick="openChapter('${cat.id}', '${book.id}', '${ch.id}')">
            <span>📑 ${ch.title}</span>
            ${isUnlocked ? `<div class="actions">
                <i class="fas fa-edit" onclick="renameChapter('${cat.id}', '${book.id}', '${ch.id}', event)"></i>
                <i class="fas fa-trash" onclick="deleteChapter('${cat.id}', '${book.id}', '${ch.id}', event)"></i>
            </div>` : ``}
        </div>`;
    });
    html += `</div>`;
    document.getElementById('contentArea').innerHTML = html;
    if(window.innerWidth <= 768) toggleSidebar();
}

function openChapter(catId, bookId, chapterId) {
    currentCategoryId = catId; currentBookId = bookId; currentChapterId = chapterId;
    const cat = appData.categories.find(c => c.id === catId);
    const book = cat.books.find(b => b.id === bookId);
    const chapter = book.chapters.find(c => c.id === chapterId);

    updateBreadcrumb(`📁 ${cat.title} > 📘 ${book.title} > 📑 ${chapter.title}`);
    renderSidebar();

    document.getElementById('contentArea').innerHTML = `
        <div style="margin-bottom: 15px;">
            <button onclick="openBook('${catId}', '${bookId}')" style="padding:8px 15px; cursor:pointer; background:#fff; border:1px solid #ccc; border-radius:5px; font-weight:bold;">⬅ Back to Book</button>
        </div>
        <div id="toolbar-container" style="${isUnlocked ? '' : 'display:none;'}">
            <span class="ql-formats"><button class="ql-bold"></button><button class="ql-italic"></button></span>
            <span class="ql-formats"><button class="ql-header" value="1"></button><button class="ql-header" value="2"></button></span>
            <span class="ql-formats"><button class="ql-list" value="ordered"></button><button class="ql-list" value="bullet"></button></span>
            <span class="ql-formats"><button class="ql-clean"></button></span>
            <span class="ql-formats">
                <button type="button" onclick="fixPDFText()" style="width:auto; padding:0 10px; font-weight:bold; color:#4361ee;" title="PDF के टूटे पैराग्राफ को सही करें">🛠️ Fix PDF Text</button>
            </span>
        </div>
        <div id="editor-container" style="${isUnlocked ? '' : 'border-radius:8px; border-top:1px solid #ccc;'}"></div>
    `;

    editor = new Quill('#editor-container', {
        modules: { toolbar: isUnlocked ? '#toolbar-container' : false },
        theme: 'snow',
        readOnly: !isUnlocked
    });

    editor.clipboard.dangerouslyPasteHTML(chapter.content || '');

    if (isUnlocked) {
        editor.on('text-change', () => { chapter.content = editor.root.innerHTML; triggerAutoSave(); });
    }
}

// ==========================================
// 6. FIX PDF TEXT 🛠️
// ==========================================
function fixPDFText() {
    if (!isUnlocked || !editor) return;
    const range = editor.getSelection();
    if (range && range.length > 0) {
        let text = editor.getText(range.index, range.length);
        text = text.replace(/\n\n/g, '||PARAGRAPH||');
        text = text.replace(/\n/g, ' ');
        text = text.replace(/\|\|PARAGRAPH\|\|/g, '\n\n');
        text = text.replace(/ +/g, ' ');
        editor.deleteText(range.index, range.length);
        editor.insertText(range.index, text);
        editor.setSelection(range.index, text.length);
        triggerAutoSave();
    } else {
        alert("❌ पहले माउस से उस टूटे हुए टेक्स्ट को Select करें जिसे ठीक करना है!");
    }
}

// --- DELETING ---
function deleteCategory(id, e) {
    if(!isUnlocked) return;
    e.stopPropagation();
    if(confirm("Are you sure you want to delete this Subject and ALL its Books?")) {
        appData.categories = appData.categories.filter(c => c.id !== id);
        if(currentCategoryId === id) document.getElementById('contentArea').innerHTML = '<div class="welcome-screen"><h2>Subject Deleted</h2></div>';
        triggerAutoSave(); renderSidebar();
    }
}

function deleteBook(catId, bookId, e) {
    if(!isUnlocked) return;
    e.stopPropagation();
    if(confirm("Are you sure you want to delete this book?")) {
        const cat = appData.categories.find(c => c.id === catId);
        cat.books = cat.books.filter(b => b.id !== bookId);
        if(currentBookId === bookId) openCategory(catId);
        triggerAutoSave(); renderSidebar();
    }
}

function deleteChapter(catId, bookId, chapId, e) {
    if(!isUnlocked) return;
    e.stopPropagation();
    if(confirm("Delete this chapter?")) {
        const cat = appData.categories.find(c => c.id === catId);
        const book = cat.books.find(b => b.id === bookId);
        book.chapters = book.chapters.filter(c => c.id !== chapId);
        if(currentChapterId === chapId) openBook(catId, bookId);
        triggerAutoSave(); renderSidebar();
    }
}

// --- SEARCH & BACKUP ---
function handleSearch() {
    const query = document.getElementById('searchInput').value.toLowerCase();
    if (!query) {
        if(currentCategoryId) openCategory(currentCategoryId);
        else document.getElementById('contentArea').innerHTML = '<div class="welcome-screen"><h2>Welcome</h2></div>';
        return;
    }
    let resultsHTML = `<h2>Search Results for "${query}"</h2><div class="grid-list">`;
    let found = false;

    (appData.categories || []).forEach(cat => {
        (cat.books || []).forEach(book => {
            (book.chapters || []).forEach(chapter => {
                const contentText = (chapter.content || "").replace(/<[^>]+>/g, '').toLowerCase();
                if (chapter.title.toLowerCase().includes(query) || contentText.includes(query) || book.title.toLowerCase().includes(query) || cat.title.toLowerCase().includes(query)) {
                    found = true;
                    resultsHTML += `
                        <div class="search-result-item" onclick="jumpToChapter('${cat.id}', '${book.id}', '${chapter.id}')">
                            <div class="search-path">📁 ${cat.title} > 📘 ${book.title}</div>
                            <strong>📑 ${chapter.title}</strong>
                        </div>
                    `;
                }
            });
        });
    });

    if(!found) resultsHTML += `<p>No matching chapters found.</p>`;
    resultsHTML += `</div>`;
    document.getElementById('contentArea').innerHTML = resultsHTML;
}

function jumpToChapter(catId, bId, cId) {
    document.getElementById('searchInput').value = '';
    openChapter(catId, bId, cId);
    if(window.innerWidth <= 768) toggleSidebar();
}

async function showAutoBackups() {
    if(!isUnlocked) return;
    currentCategoryId = null; currentBookId = null; currentChapterId = null; renderSidebar();
    document.getElementById('contentArea').innerHTML = `<div class="welcome-screen"><h2>Loading Backups... ⏳</h2></div>`;
    const { data, error } = await supabaseClient.from('auto_backups').select('backup_date').order('backup_date', { ascending: false });
    if (error) return;
    let html = `<div class="view-header"><h2>☁️ Daily Cloud Backups</h2></div><div class="grid-list">`;
    (data || []).forEach(b => {
        html += `<div class="grid-card" style="align-items:center;">
            <span style="font-weight:bold; font-size:1.1rem;">📅 Date: ${b.backup_date}</span>
            <button onclick="restoreAutoBackup('${b.backup_date}')" style="padding:8px 15px; background:#e63946; color:white; border:none; border-radius:5px; cursor:pointer;">Restore</button>
        </div>`;
    });
    html += `</div>`;
    document.getElementById('contentArea').innerHTML = html;
}

async function restoreAutoBackup(dateStr) {
    if(!isUnlocked) return;
    if(!confirm(`WARNING! Restore backup from ${dateStr}? This will REPLACE current notes.`)) return;
    document.getElementById('contentArea').innerHTML = `<div class="welcome-screen"><h2>Restoring... ⏳</h2></div>`;
    const { data, error } = await supabaseClient.from('auto_backups').select('data').eq('backup_date', dateStr).single();
    if(data && data.data) {
        appData = data.data;
        migrateOldData();
        await supabaseClient.from('notes_db').upsert({ id: 1, data: appData });
        triggerAutoSave(); renderSidebar();
        document.getElementById('contentArea').innerHTML = `<div class="welcome-screen"><h2 style="color:green;">✅ Backup Restored!</h2></div>`;
    }
}

function exportBackup() {
    if(!isUnlocked) return;
    const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(appData));
    const downloadAnchorNode = document.createElement('a');
    downloadAnchorNode.setAttribute("href", dataStr);
    downloadAnchorNode.setAttribute("download", "MyBookNotes_Backup.json");
    document.body.appendChild(downloadAnchorNode);
    downloadAnchorNode.click(); downloadAnchorNode.remove();
}

function importBackup(event) {
    if(!isUnlocked) return;
    const file = event.target.files[0];
    if(!file) return;
    const reader = new FileReader();
    reader.onload = function(e) {
        try {
            const importedData = JSON.parse(e.target.result);
            if(importedData) {
                appData = importedData;
                migrateOldData();
                triggerAutoSave(); renderSidebar();
                alert("Backup Restored!");
            }
        } catch (err) { alert("Error reading file."); }
    };
    reader.readAsText(file);
}

function toggleSidebar() { document.getElementById('sidebar').classList.toggle('open'); }
