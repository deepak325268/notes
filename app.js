// ==========================================
// 1. SUPABASE SETUP (Database Configuration)
// ==========================================
const SUPABASE_URL = 'https://qnjliiowzdkqrpwavnj.supabase.co';
const SUPABASE_KEY = 'sb_publishable_QkFJZLtolSb8SNIUhqyLbA_jLB1DarC';

const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

// ==========================================
// 2. STATE MANAGEMENT
// ==========================================
let appData = { books: [] };
let currentBookId = null;
let currentChapterId = null; // Pages हटा दिए गए हैं, अब सिर्फ Chapter रहेगा
let editor = null;
let saveTimeout = null;

// ==========================================
// 3. INITIALIZATION & DATA LOADING
// ==========================================
window.onload = async () => {
    document.getElementById('saveStatus').innerText = "☁️ Loading...";
    await loadDataFromCloud();
    renderSidebar();
};

async function loadDataFromCloud() {
    try {
        const { data, error } = await supabaseClient.from('notes_db').select('data').eq('id', 1).single();
        if (error && error.code !== 'PGRST116') throw error;
        
        if (data && data.data) {
            appData = data.data;
        }
        document.getElementById('saveStatus').innerText = "☁️ Synced";
    } catch (err) {
        console.error("Error loading data:", err);
        document.getElementById('saveStatus').innerText = "⚠️ Offline Mode";
        const local = localStorage.getItem('bookNotesBackup');
        if (local) appData = JSON.parse(local);
    }
}

async function triggerAutoSave() {
    document.getElementById('saveStatus').innerText = "⏳ Saving...";
    clearTimeout(saveTimeout);
    saveTimeout = setTimeout(async () => {
        try {
            appData.lastUpdated = new Date().toISOString();
            localStorage.setItem('bookNotesBackup', JSON.stringify(appData));
            
            const { error } = await supabaseClient.from('notes_db').upsert({ id: 1, data: appData });
            
            if (error) throw error;
            document.getElementById('saveStatus').innerText = "☁️ Saved";
        } catch (err) {
            console.error("Save error:", err);
            document.getElementById('saveStatus').innerText = "⚠️ Save Failed";
        }
    }, 1500);
}

// ==========================================
// 4. UI RENDERING & NAVIGATION (BOOKS -> CHAPTERS ONLY)
// ==========================================
function generateId() { return Math.random().toString(36).substr(2, 9); }

function renderSidebar() {
    const list = document.getElementById('bookList');
    list.innerHTML = '';
    
    appData.books.forEach(book => {
        // BOOK LEVEL
        const bookDiv = document.createElement('div');
        bookDiv.className = `list-item ${currentBookId === book.id && !currentChapterId ? 'active' : ''}`;
        bookDiv.innerHTML = `
            <span onclick="openBook('${book.id}')" style="font-weight:bold; flex:1;">📚 ${book.title}</span>
            <div class="actions">
                <i class="fas fa-plus" onclick="addChapterTo('${book.id}', event)" title="Add Chapter"></i>
                <i class="fas fa-trash" onclick="deleteBook('${book.id}', event)" title="Delete Book"></i>
            </div>
        `;
        list.appendChild(bookDiv);

        // CHAPTERS LEVEL (Directly opens editor)
        if (currentBookId === book.id) {
            const chapContainer = document.createElement('div');
            chapContainer.style.background = "#ffffff";
            chapContainer.style.borderLeft = "3px solid #4361ee";
            chapContainer.style.marginLeft = "10px";
            
            (book.chapters || []).forEach(chapter => {
                const chapDiv = document.createElement('div');
                chapDiv.className = `list-item ${currentChapterId === chapter.id ? 'active' : ''}`;
                chapDiv.style.paddingLeft = "15px";
                chapDiv.innerHTML = `
                    <span onclick="openChapter('${chapter.id}')" style="font-size:0.9rem; flex:1; color:#444;">📑 ${chapter.title}</span>
                    <div class="actions">
                        <i class="fas fa-trash" onclick="deleteChapter('${chapter.id}', event)" title="Delete Chapter"></i>
                    </div>
                `;
                chapContainer.appendChild(chapDiv);
            });
            list.appendChild(chapContainer);
        }
    });
}

function updateBreadcrumb(text) {
    document.getElementById('breadcrumb').innerText = text;
}

// --- ADDING DATA ---
function addNewBook() {
    const title = prompt("Enter Book Name:");
    if (!title) return;
    appData.books.push({ id: generateId(), title: title, chapters: [] });
    triggerAutoSave();
    renderSidebar();
}

function addChapterTo(bId, e) {
    if(e) e.stopPropagation();
    const book = appData.books.find(b => b.id === bId);
    let title = prompt("Enter Chapter Name (Leave blank for default name):");
    if (title === null) return;
    if (title.trim() === "") title = "Chapter " + ((book.chapters || []).length + 1);
    
    if(!book.chapters) book.chapters = [];
    // Page हटाकर content सीधा Chapter में डाला गया है
    book.chapters.push({ id: generateId(), title: title, content: "" });
    triggerAutoSave();
    openBook(bId); 
}

// --- OPENING VIEWS ---
function openBook(bookId) {
    currentBookId = bookId; currentChapterId = null;
    const book = appData.books.find(b => b.id === bookId);
    updateBreadcrumb(`📘 ${book.title}`);
    renderSidebar();

    let html = `<div class="view-header">
        <h2>Chapters in ${book.title}</h2>
        <button class="btn-add" onclick="addChapterTo('${book.id}')"><i class="fas fa-plus"></i> Add Chapter</button>
    </div><div class="grid-list">`;
    
    if (!book.chapters || book.chapters.length === 0) html += `<p>No chapters yet. Click "+ Add Chapter" to start.</p>`;
    
    (book.chapters || []).forEach(ch => {
        html += `<div class="grid-card" onclick="openChapter('${ch.id}')">
            <span>📑 ${ch.title}</span>
            <div class="actions">
                <i class="fas fa-trash" onclick="deleteChapter('${ch.id}', event)"></i>
            </div>
        </div>`;
    });
    html += `</div>`;
    document.getElementById('contentArea').innerHTML = html;
    if(window.innerWidth <= 768) toggleSidebar();
}

// Chapter खोलते ही सीधा Editor खुलेगा
function openChapter(chapterId) {
    currentChapterId = chapterId;
    const book = appData.books.find(b => b.id === currentBookId);
    const chapter = book.chapters.find(c => c.id === chapterId);
    
    updateBreadcrumb(`📘 ${book.title} > 📑 ${chapter.title}`);
    renderSidebar();

    document.getElementById('contentArea').innerHTML = `
        <div style="margin-bottom: 15px;">
            <button onclick="openBook('${currentBookId}')" style="padding:8px 15px; cursor:pointer; background:#fff; border:1px solid #ccc; border-radius:5px; font-weight:bold;">⬅ Back to Book</button>
        </div>
        <div id="toolbar-container">
            <span class="ql-formats"><button class="ql-bold"></button><button class="ql-italic"></button></span>
            <span class="ql-formats"><button class="ql-header" value="1"></button><button class="ql-header" value="2"></button></span>
            <span class="ql-formats"><button class="ql-list" value="ordered"></button><button class="ql-list" value="bullet"></button></span>
            <span class="ql-formats"><button class="ql-clean"></button></span>
        </div>
        <div id="editor-container"></div>
    `;

    editor = new Quill('#editor-container', {
        modules: { toolbar: '#toolbar-container' },
        theme: 'snow'
    });
    
    // Chapter का content सीधा Editor में
    editor.clipboard.dangerouslyPasteHTML(chapter.content || '');

    editor.on('text-change', () => {
        chapter.content = editor.root.innerHTML;
        triggerAutoSave();
    });
}

// --- DELETING ---
function deleteBook(id, e) {
    e.stopPropagation();
    if(confirm("Are you sure you want to delete this book and ALL its chapters?")) {
        appData.books = appData.books.filter(b => b.id !== id);
        if(currentBookId === id) document.getElementById('contentArea').innerHTML = '<div class="welcome-screen"><h2>Book Deleted</h2></div>';
        triggerAutoSave(); renderSidebar();
    }
}

function deleteChapter(id, e) {
    e.stopPropagation();
    if(confirm("Delete this chapter?")) {
        const book = appData.books.find(b => b.id === currentBookId);
        book.chapters = book.chapters.filter(c => c.id !== id);
        if(currentChapterId === id) openBook(currentBookId);
        triggerAutoSave(); renderSidebar();
    }
}

// --- SEARCH & BACKUP ---
function handleSearch() {
    const query = document.getElementById('searchInput').value.toLowerCase();
    if (!query) {
        if(currentBookId) openBook(currentBookId);
        else document.getElementById('contentArea').innerHTML = '<div class="welcome-screen"><h2>Welcome</h2></div>';
        return;
    }

    let resultsHTML = `<h2>Search Results for "${query}"</h2><div class="grid-list">`;
    let found = false;

    appData.books.forEach(book => {
        (book.chapters || []).forEach(chapter => {
            // Chapter के content में Search
            const contentText = (chapter.content || "").replace(/<[^>]+>/g, '').toLowerCase(); 
            if (chapter.title.toLowerCase().includes(query) || contentText.includes(query) || book.title.toLowerCase().includes(query)) {
                found = true;
                resultsHTML += `
                    <div class="search-result-item" onclick="jumpToChapter('${book.id}', '${chapter.id}')">
                        <div class="search-path">📘 ${book.title}</div>
                        <strong>📑 ${chapter.title}</strong>
                    </div>
                `;
            }
        });
    });

    if(!found) resultsHTML += `<p>No matching chapters found.</p>`;
    resultsHTML += `</div>`;
    document.getElementById('contentArea').innerHTML = resultsHTML;
}

function jumpToChapter(bId, cId) {
    document.getElementById('searchInput').value = '';
    currentBookId = bId; 
    openChapter(cId);
    if(window.innerWidth <= 768) toggleSidebar();
}

function exportBackup() {
    const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(appData));
    const downloadAnchorNode = document.createElement('a');
    downloadAnchorNode.setAttribute("href",     dataStr);
    downloadAnchorNode.setAttribute("download", "MyBookNotes_Backup.json");
    document.body.appendChild(downloadAnchorNode); 
    downloadAnchorNode.click();
    downloadAnchorNode.remove();
}

function importBackup(event) {
    const file = event.target.files[0];
    if(!file) return;
    const reader = new FileReader();
    reader.onload = function(e) {
        try {
            const importedData = JSON.parse(e.target.result);
            if(importedData && importedData.books) {
                appData = importedData;
                triggerAutoSave();
                renderSidebar();
                document.getElementById('contentArea').innerHTML = '<div class="welcome-screen"><h2>Backup Restored Successfully!</h2></div>';
                alert("Backup Restored!");
            } else { alert("Invalid Backup File."); }
        } catch (err) { alert("Error reading file."); }
    };
    reader.readAsText(file);
}

function toggleSidebar() {
    document.getElementById('sidebar').classList.toggle('open');
}