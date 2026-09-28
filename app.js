// ==========================================
// 1. SUPABASE SETUP
// ==========================================
const SUPABASE_URL = 'https://grjiljowzclkqrpwavnj.supabase.co';
const SUPABASE_KEY = 'sb_publishable_QkFJZLtolSb8SNIUhqyLbA_jLB1DarC';
// cache: 'no-store' -> browser purana (stale) response kabhi reuse nahi karega
const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
    global: {
        fetch: (url, options = {}) => fetch(url, { ...options, cache: 'no-store' })
    }
});

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

// --- Data-safety state ---
let cloudLoaded = false;        // true sirf tab jab cloud se data sahi se aaya ho
let writeLocked = false;        // conflict mila -> refresh hone tak saari saving band
let structureStamp = null;      // notes_db ka lastUpdated jo hamne load kiya tha
let chapterStamp = {};          // chapterId -> updated_at (null = row abhi hai hi nahi)
let lastSavedContent = {};      // chapterId -> content jo cloud me abhi hai
let lastSnapshotAt = {};        // chapterId -> last version-snapshot time
let conflictChapters = new Set();
let historyVersions = [];

let pendingContent = null;      // {chapterId, content} - sirf sabse naya
let contentSaving = false;
let contentTimer = null;

let structDirty = false;
let structSaving = false;
let structTimer = null;

function setStatus(text) {
    const el = document.getElementById('saveStatus');
    if (el) el.innerText = text;
}

function canSave() { return isUnlocked && cloudLoaded && !writeLocked; }

function guard() {
    if (!isUnlocked) return false;
    if (!cloudLoaded) {
        alert('⚠️ Cloud se data load nahi hua, isliye abhi editing band hai (taaki purana data naye ko overwrite na kare). Page refresh karein.');
        return false;
    }
    if (writeLocked) {
        alert('⚠️ Ye data kisi aur tab/device se badla ja chuka hai. Page refresh karein, tabhi editing chalegi.');
        return false;
    }
    return true;
}

function forEachChapter(struct, fn) {
    (struct.categories || []).forEach(cat =>
        (cat.books || []).forEach(book =>
            (book.chapters || []).forEach(ch => fn(ch, book, cat))));
}

// ==========================================
// 4. INITIALIZATION & DATA LOADING
// ==========================================
window.onload = async () => {
    setStatus("☁️ Loading...");

    if (isUnlocked) {
        document.getElementById('adminControls').style.display = 'block';
        document.getElementById('lockBtn').innerHTML = '🔓 Lock Editing';
        document.getElementById('lockBtn').style.background = '#eef2ff';
        document.getElementById('lockBtn').style.borderColor = '#4361ee';
    }

    await loadDataFromCloud();
    renderSidebar();

    if (isUnlocked && cloudLoaded) {
        // Pehle poora backup (content ke saath), tabhi migration
        const backedUp = await dailyBackupIfNeeded();
        if (backedUp) await migrateChapterContentIfNeeded();
    }
};

async function loadDataFromCloud(maxRetries = 4) {
    setStatus("☁️ Loading...");

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            const { data, error } = await supabaseClient
                .from('notes_db')
                .select('data')
                .eq('id', 1)
                .single();

            if (error && error.code !== 'PGRST116') throw error;

            if (data && data.data) {
                appData = data.data;
                structureStamp = appData.lastUpdated || null;
            }
            cloudLoaded = true;
            migrateOldData();
            setStatus("☁️ Synced");
            return;
        } catch (err) {
            console.log(`Cloud load attempt ${attempt}/${maxRetries} failed:`, err);
            if (attempt < maxRetries) {
                setStatus(`⏳ Slow connection, retrying (${attempt}/${maxRetries - 1})...`);
                await new Promise(res => setTimeout(res, attempt * 800));
            }
        }
    }

    // Cloud se nahi aaya: sirf padhne ke liye purana local copy. EDITING BAND.
    cloudLoaded = false;
    setStatus(isUnlocked ? "⚠️ Offline - editing band (refresh karein)" : "⚠️ Offline Mode");
    try {
        const local = localStorage.getItem('bookNotesBackup');
        if (local) {
            appData = JSON.parse(local);
            normalizeStructure(appData);
        }
    } catch (e) { console.log('Local backup unreadable', e); }
}

function normalizeStructure(obj) {
    if (!obj.categories) {
        obj.categories = [];
        if (obj.books && obj.books.length > 0) {
            obj.categories.push({
                id: generateId(),
                title: "पुरानी किताबें (Old Books)",
                books: obj.books
            });
        }
        delete obj.books;
        return true;
    }
    return false;
}

function migrateOldData() {
    if (normalizeStructure(appData)) triggerAutoSave();
}

// ==========================================
// 4b. SAFE SAVING (structure)
// ==========================================
function triggerAutoSave() {
    if (!canSave()) return;
    structDirty = true;
    setStatus("⏳ Saving...");
    // turant local copy (sync) - tab band ho jaye to bhi structure bacha rahe
    try { localStorage.setItem('bookNotesBackup', JSON.stringify(appData)); } catch (e) {}
    clearTimeout(structTimer);
    structTimer = setTimeout(flushStructure, 1500);
}

async function flushStructure() {
    clearTimeout(structTimer);
    if (structSaving || !structDirty || !canSave()) return;
    structSaving = true;
    structDirty = false;
    let failed = false;
    try {
        const ok = await persistStructure();
        if (ok) setStatus("☁️ Saved");
    } catch (err) {
        console.error("Structure save error:", err);
        failed = true;
        structDirty = true;
        setStatus("⚠️ Save failed - dobara try ho raha hai");
    }
    structSaving = false;
    if (structDirty && canSave()) structTimer = setTimeout(flushStructure, failed ? 5000 : 300);
}

// Sirf tab likhta hai jab cloud par abhi bhi wahi version ho jo hamne load kiya tha.
async function persistStructure() {
    const newStamp = new Date().toISOString();
    const next = { ...appData, lastUpdated: newStamp };

    if (structureStamp) {
        const { data, error } = await supabaseClient
            .from('notes_db')
            .update({ data: next })
            .eq('id', 1)
            .eq('data->>lastUpdated', structureStamp)
            .select('id');
        if (error) throw error;
        if (!data || data.length === 0) {
            writeLocked = true;
            structDirty = false;
            setStatus("⚠️ Conflict - save roka gaya");
            alert('⚠️ Subjects/Books ka structure kisi aur tab ya device se badla ja chuka hai. Aapka ye change cloud me SAVE NAHI kiya gaya (taaki unka kaam overwrite na ho). Page refresh karke change dobara karein.');
            return false;
        }
    } else {
        const { error } = await supabaseClient.from('notes_db').upsert({ id: 1, data: next });
        if (error) throw error;
    }
    appData.lastUpdated = newStamp;
    structureStamp = newStamp;
    return true;
}

async function forceWriteStructure(struct) {
    const next = { ...struct, lastUpdated: new Date().toISOString() };
    const { error } = await supabaseClient.from('notes_db').upsert({ id: 1, data: next });
    if (error) throw error;
    try { localStorage.setItem('bookNotesBackup', JSON.stringify(next)); } catch (e) {}
}

// ==========================================
// 4c. SAFE SAVING (chapter content)
// ==========================================
const DRAFT_PREFIX = 'draft:';

function writeDraft(id, content) {
    try {
        localStorage.setItem(DRAFT_PREFIX + id, JSON.stringify({
            content, base: chapterStamp[id] || null, t: Date.now()
        }));
    } catch (e) { console.log('Draft skip (storage full?)'); }
}
function readDraft(id) {
    try { const r = localStorage.getItem(DRAFT_PREFIX + id); return r ? JSON.parse(r) : null; }
    catch (e) { return null; }
}
function clearDraft(id) { try { localStorage.removeItem(DRAFT_PREFIX + id); } catch (e) {} }

function saveChapterContent(chapterId, content) {
    if (!canSave() || conflictChapters.has(chapterId)) return;
    pendingContent = { chapterId, content };
    writeDraft(chapterId, content);     // har badlav turant local me safe
    setStatus("⏳ Saving...");
    clearTimeout(contentTimer);
    contentTimer = setTimeout(flushContentSave, 1200);
}

async function flushContentSave() {
    clearTimeout(contentTimer);
    if (contentSaving) return false;
    if (!pendingContent) return true;
    if (!canSave()) return false;

    contentSaving = true;
    const job = pendingContent;
    pendingContent = null;
    let failed = false;
    try {
        const result = await persistChapter(job.chapterId, job.content);
        if (result === 'conflict' && pendingContent && pendingContent.chapterId === job.chapterId) {
            pendingContent = null;
        }
    } catch (err) {
        console.error("Content save error:", err);
        failed = true;
        if (!pendingContent) pendingContent = job;   // naya na ho to yahi dobara try hoga
        setStatus("⚠️ Save failed - dobara try ho raha hai (draft local me safe hai)");
    }
    contentSaving = false;
    if (pendingContent && canSave()) {
        contentTimer = setTimeout(flushContentSave, failed ? 5000 : 300);
    }
    return !failed;
}

// Pending saves puri hone tak ruko (chapter badalne / backup se pehle)
async function drainSaves() {
    for (let i = 0; i < 60 && (contentSaving || pendingContent); i++) {
        if (contentSaving) { await new Promise(r => setTimeout(r, 100)); continue; }
        const ok = await flushContentSave();
        if (!ok) break;
    }
    if (structDirty && !structSaving) await flushStructure();
}

async function persistChapter(chapterId, content) {
    const known = chapterStamp[chapterId];
    await maybeSnapshotVersion(chapterId, lastSavedContent[chapterId]);   // best-effort

    const nowIso = new Date().toISOString();
    let res;
    if (known === null || known === undefined) {
        // Cloud par row nahi thi: sirf naya insert. Agar kisi ne beech me bana di to conflict.
        res = await supabaseClient.from('chapter_content')
            .insert({ id: chapterId, content, updated_at: nowIso })
            .select('updated_at');
        if (res.error) {
            if (res.error.code === '23505') return await handleChapterConflict(chapterId, content);
            throw res.error;
        }
    } else {
        let q = supabaseClient.from('chapter_content')
            .update({ content, updated_at: nowIso })
            .eq('id', chapterId);
        q = (known === 'NULLROW') ? q.is('updated_at', null) : q.eq('updated_at', known);
        res = await q.select('updated_at');
        if (res.error) throw res.error;
        if (!res.data || res.data.length === 0) return await handleChapterConflict(chapterId, content);
    }

    chapterStamp[chapterId] = res.data[0].updated_at;
    lastSavedContent[chapterId] = content;
    if (!(pendingContent && pendingContent.chapterId === chapterId)) clearDraft(chapterId);
    setStatus("☁️ Saved");
    return 'ok';
}

async function handleChapterConflict(chapterId, mine) {
    conflictChapters.add(chapterId);
    await snapshotVersion(chapterId, mine, 'conflict-mine');
    if (currentChapterId === chapterId && editor) editor.enable(false);
    setStatus("⚠️ Conflict - save roka gaya");
    alert('⚠️ Ye chapter kisi aur tab/device se badla ja chuka hai.\n\nAapka likha hua text OVERWRITE NAHI kiya gaya aur "History" me (conflict-mine) tatha is browser me safe rakha gaya hai.\n\nPage refresh karein, phir History se apna version wapas la sakte hain.');
    return 'conflict';
}

// ==========================================
// 4d. VERSION HISTORY (per chapter)
// ==========================================
function isTriviallyEmpty(html) {
    return !html || html.replace(/<[^>]*>/g, '').trim() === '';
}

// true = safe (save ho gaya ya kuch save karne layak tha hi nahi), false = save fail
async function snapshotVersion(chapterId, content, reason) {
    if (isTriviallyEmpty(content)) return true;
    try {
        const { error } = await supabaseClient.from('chapter_versions')
            .insert({ chapter_id: chapterId, content, reason });
        if (error) throw error;
        pruneVersions(chapterId);
        return true;
    } catch (e) {
        console.log('Version snapshot failed:', e);
        return false;
    }
}

async function maybeSnapshotVersion(chapterId, prevContent) {
    if (isTriviallyEmpty(prevContent)) return;
    const last = lastSnapshotAt[chapterId];
    if (last && Date.now() - last < 10 * 60 * 1000) return;   // 10 min me ek
    lastSnapshotAt[chapterId] = Date.now();
    await snapshotVersion(chapterId, prevContent, 'auto');
}

async function pruneVersions(chapterId) {
    try {
        const { data } = await supabaseClient.from('chapter_versions')
            .select('id').eq('chapter_id', chapterId)
            .order('created_at', { ascending: false }).range(30, 200);
        if (data && data.length) {
            await supabaseClient.from('chapter_versions').delete().in('id', data.map(r => r.id));
        }
    } catch (e) {}
}

async function showChapterHistory() {
    if (!editor || !currentChapterId) return;
    const chapterId = currentChapterId;
    const { data, error } = await supabaseClient.from('chapter_versions')
        .select('id,reason,created_at,content').eq('chapter_id', chapterId)
        .order('created_at', { ascending: false }).limit(20);
    if (error) { alert('❌ History load nahi hui. (chapter_versions table bana hai?)'); return; }
    historyVersions = data || [];

    const old = document.getElementById('historyOverlay');
    if (old) old.remove();
    const ov = document.createElement('div');
    ov.id = 'historyOverlay';
    ov.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:9999;display:flex;align-items:center;justify-content:center;padding:15px;';
    const box = document.createElement('div');
    box.style.cssText = 'background:#fff;border-radius:10px;max-width:540px;width:100%;max-height:80vh;overflow:auto;padding:18px;';
    const title = document.createElement('h3');
    title.style.margin = '0 0 12px';
    title.textContent = '🕘 Is chapter ke purane versions';
    box.appendChild(title);

    if (historyVersions.length === 0) {
        const p = document.createElement('p');
        p.textContent = 'Abhi koi purana version nahi hai. Edit karte rahoge to apne aap banenge.';
        box.appendChild(p);
    }
    const labels = { 'auto': 'Auto', 'conflict-mine': 'Conflict me mera version', 'before-restore': 'Restore se pehle', 'before-fix-pdf': 'Fix PDF se pehle', 'migration-old-copy': 'Purani copy', 'declined-draft': 'Chhoda hua draft' };
    historyVersions.forEach((v, i) => {
        const row = document.createElement('div');
        row.style.cssText = 'border:1px solid #ddd;border-radius:8px;padding:10px;margin-bottom:8px;';
        const meta = document.createElement('div');
        meta.style.cssText = 'font-weight:bold;font-size:14px;';
        meta.textContent = new Date(v.created_at).toLocaleString() + ' • ' + (labels[v.reason] || v.reason || '');
        const prev = document.createElement('div');
        prev.style.cssText = 'color:#555;font-size:13px;margin:6px 0;';
        const txt = (v.content || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
        prev.textContent = txt.slice(0, 90) + (txt.length > 90 ? '…' : '') + '  (' + txt.length + ' akshar)';
        const btn = document.createElement('button');
        btn.textContent = 'Ye version wapas laayein';
        btn.style.cssText = 'padding:6px 12px;cursor:pointer;background:#4361ee;color:#fff;border:none;border-radius:5px;';
        btn.onclick = () => restoreVersion(i);
        row.appendChild(meta); row.appendChild(prev); row.appendChild(btn);
        box.appendChild(row);
    });
    const close = document.createElement('button');
    close.textContent = 'Band karein';
    close.style.cssText = 'padding:8px 14px;cursor:pointer;margin-top:6px;';
    close.onclick = () => ov.remove();
    box.appendChild(close);
    ov.appendChild(box);
    document.body.appendChild(ov);
}

async function restoreVersion(index) {
    const v = historyVersions[index];
    if (!v || !editor || !currentChapterId) return;
    if (conflictChapters.has(currentChapterId) || !canSave()) {
        alert('Pehle page refresh karein, phir restore karein.');
        return;
    }
    if (!confirm('Ye version editor me wapas laayein? Abhi ka text bhi History me safe rakha jayega.')) return;
    await snapshotVersion(currentChapterId, editor.root.innerHTML, 'before-restore');
    editor.setContents([]);
    editor.clipboard.dangerouslyPasteHTML(v.content || '');
    const ov = document.getElementById('historyOverlay');
    if (ov) ov.remove();
}

// ==========================================
// 4e. FULL BACKUPS (structure + chapter content)
// ==========================================
async function fetchAllContents() {
    const all = {};
    const step = 200;
    for (let from = 0; ; from += step) {
        const { data, error } = await supabaseClient.from('chapter_content')
            .select('id,content').order('id').range(from, from + step - 1);
        if (error) throw error;
        (data || []).forEach(r => { all[r.id] = r.content; });
        if (!data || data.length < step) break;
    }
    return all;
}

async function createFullBackup(reason, forcedId, ignoreDuplicate) {
    const contents = await fetchAllContents();
    const structure = JSON.parse(JSON.stringify(appData));
    forEachChapter(structure, ch => {
        if (ch.content !== undefined) {
            if (contents[ch.id] === undefined) contents[ch.id] = ch.content;
            delete ch.content;
        }
    });
    const id = forcedId || (new Date().toISOString().replace(/[:.]/g, '-') + '_' + reason);
    const row = { id, reason, data: { version: 2, structure, contents } };
    const table = supabaseClient.from('full_backups');
    const { error } = ignoreDuplicate
        ? await table.upsert(row, { onConflict: 'id', ignoreDuplicates: true })
        : await table.insert(row);
    if (error) throw error;
    pruneFullBackups();
}

async function pruneFullBackups() {
    try {
        const { data } = await supabaseClient.from('full_backups')
            .select('id').order('created_at', { ascending: false }).range(30, 500);
        if (data && data.length) {
            await supabaseClient.from('full_backups').delete().in('id', data.map(r => r.id));
        }
    } catch (e) {}
}

async function dailyBackupIfNeeded() {
    const today = new Date().toISOString().split('T')[0];
    try { if (localStorage.getItem('lastFullBackupDate') === today) return true; } catch (e) {}
    if (!(appData.categories || []).length) return true;
    try {
        await createFullBackup('daily', today + '_daily', true);
        try { localStorage.setItem('lastFullBackupDate', today); } catch (e) {}
        return true;
    } catch (e) {
        console.warn('Daily backup failed:', e);
        setStatus("⚠️ Backup nahi ban paya (full_backups table?)");
        return false;
    }
}

// Kuch bhi delete/replace karne se pehle poora backup. Fail hua to action ruk jayega.
async function safetyBackup(reason) {
    try {
        await drainSaves();
        await createFullBackup(reason);
        return true;
    } catch (e) {
        console.error('Safety backup failed:', e);
        alert('❌ Backup nahi ban paya, isliye ye action roka gaya (taaki data na jaye). Supabase me full_backups table bana hai?');
        return false;
    }
}

// ==========================================
// 4f. SAFE MIGRATION (old embedded content -> chapter_content)
// ==========================================
async function migrateChapterContentIfNeeded() {
    if (!canSave()) return;
    const jobs = [];
    forEachChapter(appData, ch => { if (ch.content !== undefined) jobs.push(ch); });
    if (!jobs.length) return;

    let changed = false;
    for (const ch of jobs) {
        try {
            const { data: existing, error: readErr } = await supabaseClient
                .from('chapter_content').select('id,content').eq('id', ch.id).maybeSingle();
            if (readErr) throw readErr;

            if (!existing) {
                const { error } = await supabaseClient.from('chapter_content')
                    .insert({ id: ch.id, content: ch.content });
                if (error) throw error;
            } else if ((existing.content || '') !== (ch.content || '')) {
                // Cloud wali row alag hai (shayad nayi) -> use mat chhedo, purani copy History me rakho
                const saved = await snapshotVersion(ch.id, ch.content, 'migration-old-copy');
                if (!saved) throw new Error('old copy save nahi hui');
            }
        } catch (err) {
            console.log('Migration skipped for chapter', ch.id, err);
            continue;    // content structure me hi rahega, kuch delete nahi hoga
        }
        delete ch.content;
        changed = true;
    }
    if (changed) triggerAutoSave();
}

// ==========================================
// 5. UI RENDERING
// ==========================================
function generateId() { return Math.random().toString(36).substr(2, 9); }

function renderSidebar() {
    const list = document.getElementById('bookList');
    list.innerHTML = '';

    (appData.categories || []).forEach(category => {
        const catDiv = document.createElement('div');
        catDiv.className = `list-item ${currentCategoryId === category.id ? 'active' : ''}`;
        catDiv.style.backgroundColor = "#eef2ff";
        catDiv.style.borderBottom = "1px solid #ccc";

        const catActions = isUnlocked ? `<div class="actions">
            <i class="fas fa-plus" onclick="addBookTo('${category.id}', event)" title="Add Book"></i>
            <i class="fas fa-edit" onclick="renameCategory('${category.id}', event)" title="Rename Subject"></i>
            <i class="fas fa-trash" onclick="deleteCategory('${category.id}', event)" title="Delete Subject"></i>
        </div>` : ``;

        catDiv.innerHTML = `<span onclick="openCategory('${category.id}')" style="font-weight:bold; flex:1; color:#2b2d42;">📁 ${category.title}</span>${catActions}`;
        list.appendChild(catDiv);
    });
}

function updateBreadcrumb(text) { document.getElementById('breadcrumb').innerText = text; }

// --- ADDING DATA ---
function addNewCategory() {
    if (!guard()) return;
    const title = prompt("Enter Subject / Category Name (e.g. भूगोल):");
    if (!title) return;
    if (!appData.categories) appData.categories = [];
    appData.categories.push({ id: generateId(), title: title, books: [] });
    triggerAutoSave(); renderSidebar();
}

function addBookTo(catId, e) {
    if (e) e.stopPropagation();
    if (!guard()) return;
    const cat = appData.categories.find(c => c.id === catId);
    const title = prompt("Enter Book/Class Name (e.g. कक्षा 6):");
    if (!title) return;
    if (!cat.books) cat.books = [];
    cat.books.push({ id: generateId(), title: title, chapters: [] });
    triggerAutoSave(); openCategory(catId);
}

function addChapterTo(catId, bId, e) {
    if (e) e.stopPropagation();
    if (!guard()) return;
    const cat = appData.categories.find(c => c.id === catId);
    const book = cat.books.find(b => b.id === bId);
    let title = prompt("Enter Chapter Name:");
    if (title === null) return;
    if (title.trim() === "") title = "Chapter " + ((book.chapters || []).length + 1);

    if (!book.chapters) book.chapters = [];
    book.chapters.push({ id: generateId(), title: title });
    triggerAutoSave(); openBook(catId, bId);
}

// --- RENAMING DATA ---
function renameCategory(id, e) {
    if (e) e.stopPropagation();
    if (!guard()) return;
    const cat = appData.categories.find(c => c.id === id);
    const newTitle = prompt("Rename Category / Subject:", cat.title);
    if (newTitle && newTitle.trim() !== "") {
        cat.title = newTitle.trim();
        triggerAutoSave(); renderSidebar();
        if (currentCategoryId === id && !currentBookId) openCategory(id);
    }
}

function renameBook(catId, bookId, e) {
    if (e) e.stopPropagation();
    if (!guard()) return;
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
    if (e) e.stopPropagation();
    if (!guard()) return;
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
    if (window.innerWidth <= 768) toggleSidebar();
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
    if (window.innerWidth <= 768) toggleSidebar();
}

// Chapter HAMESHA cloud se taaza padha jata hai (purana cache kabhi nahi dikhta).
async function openChapter(catId, bookId, chapterId) {
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
            <span class="ql-formats">
                <button type="button" onclick="showChapterHistory()" style="width:auto; padding:0 10px; font-weight:bold; color:#4361ee;" title="Purane versions">🕘 History</button>
            </span>
        </div>
        <div id="editor-container" style="${isUnlocked ? '' : 'border-radius:8px; border-top:1px solid #ccc;'}"></div>
    `;

    editor = new Quill('#editor-container', {
        modules: { toolbar: isUnlocked ? '#toolbar-container' : false },
        theme: 'snow',
        readOnly: true
    });
    editor.setText('⏳ Loading chapter...');

    if (isUnlocked) await drainSaves();   // pehle ka pending save khatam hone do

    let content = '', stamp = null, loadFailed = false;
    try {
        const { data, error } = await supabaseClient
            .from('chapter_content')
            .select('content,updated_at')
            .eq('id', chapterId)
            .maybeSingle();
        if (error) throw error;
        if (data) {
            content = data.content || '';
            stamp = data.updated_at || 'NULLROW';
        } else {
            content = chapter.content || '';   // migration se pehle wala embedded content
            stamp = null;
        }
    } catch (err) {
        console.log('Chapter content load failed:', err);
        loadFailed = true;
        content = chapter.content || '';
    }

    if (currentChapterId !== chapterId) return;   // user tab tak kahin aur chala gaya

    editor.setContents([]);
    editor.clipboard.dangerouslyPasteHTML(content);

    if (loadFailed) {
        setStatus("⚠️ Load failed - editing band, refresh karein");
        return;   // editor read-only hi rahega
    }

    chapterStamp[chapterId] = stamp;
    lastSavedContent[chapterId] = content;

    const editable = canSave();
    editor.enable(editable);
    if (!editable) return;

    // Pichhli baar ka unsaved local draft?
    let restoreDraftHtml = null;
    const draft = readDraft(chapterId);
    if (draft) {
        if (draft.content === content) {
            clearDraft(chapterId);
        } else {
            const ok = confirm('Is chapter ka ek unsaved local draft mila (pichhli baar cloud me save nahi ho paya tha).\n\nOK = draft wapas laao\nCancel = cloud wala hi rakho (draft History me rakh diya jayega)');
            if (ok) restoreDraftHtml = draft.content;
            else { snapshotVersion(chapterId, draft.content, 'declined-draft'); clearDraft(chapterId); }
        }
    }

    editor.on('text-change', () => {
        if (conflictChapters.has(chapterId)) return;
        saveChapterContent(chapterId, editor.root.innerHTML);
    });

    if (restoreDraftHtml !== null) editor.clipboard.dangerouslyPasteHTML(restoreDraftHtml);
}

// ==========================================
// 6. FIX PDF TEXT 🛠️
// ==========================================
function fixPDFText() {
    if (!isUnlocked || !editor || !canSave()) return;
    const range = editor.getSelection();
    if (range && range.length > 0) {
        // formatting badalne se pehle abhi ka version History me rakh do
        snapshotVersion(currentChapterId, editor.root.innerHTML, 'before-fix-pdf');
        let text = editor.getText(range.index, range.length);
        text = text.replace(/\n\n/g, '||PARAGRAPH||');
        text = text.replace(/\n/g, ' ');
        text = text.replace(/\|\|PARAGRAPH\|\|/g, '\n\n');
        text = text.replace(/ +/g, ' ');
        editor.deleteText(range.index, range.length);
        editor.insertText(range.index, text);
        editor.setSelection(range.index, text.length);
    } else {
        alert("❌ पहले माउस से उस टूटे हुए टेक्स्ट को Select करें जिसे ठीक करना है!");
    }
}

// --- DELETING (har delete se pehle poora backup) ---
async function deleteCategory(id, e) {
    if (e) e.stopPropagation();
    if (!guard()) return;
    if (!confirm("Are you sure you want to delete this Subject and ALL its Books?")) return;
    if (!(await safetyBackup('pre-delete-subject'))) return;
    appData.categories = appData.categories.filter(c => c.id !== id);
    if (currentCategoryId === id) document.getElementById('contentArea').innerHTML = '<div class="welcome-screen"><h2>Subject Deleted</h2></div>';
    triggerAutoSave(); renderSidebar();
}

async function deleteBook(catId, bookId, e) {
    if (e) e.stopPropagation();
    if (!guard()) return;
    if (!confirm("Are you sure you want to delete this book?")) return;
    if (!(await safetyBackup('pre-delete-book'))) return;
    const cat = appData.categories.find(c => c.id === catId);
    cat.books = cat.books.filter(b => b.id !== bookId);
    if (currentBookId === bookId) openCategory(catId);
    triggerAutoSave(); renderSidebar();
}

async function deleteChapter(catId, bookId, chapId, e) {
    if (e) e.stopPropagation();
    if (!guard()) return;
    if (!confirm("Delete this chapter?")) return;
    if (!(await safetyBackup('pre-delete-chapter'))) return;
    const cat = appData.categories.find(c => c.id === catId);
    const book = cat.books.find(b => b.id === bookId);
    book.chapters = book.chapters.filter(c => c.id !== chapId);
    // NOTE: chapter_content ki row jaan-boojh kar delete nahi ki - content recoverable rahe
    if (currentChapterId === chapId) openBook(catId, bookId);
    triggerAutoSave(); renderSidebar();
}

// --- SEARCH ---
async function handleSearch() {
    const query = document.getElementById('searchInput').value.toLowerCase();
    if (!query) {
        if (currentCategoryId) openCategory(currentCategoryId);
        else document.getElementById('contentArea').innerHTML = '<div class="welcome-screen"><h2>Welcome</h2></div>';
        return;
    }

    let matchedChapters = new Map();
    (appData.categories || []).forEach(cat => {
        (cat.books || []).forEach(book => {
            (book.chapters || []).forEach(chapter => {
                if (chapter.title.toLowerCase().includes(query) ||
                    book.title.toLowerCase().includes(query) ||
                    cat.title.toLowerCase().includes(query)) {
                    matchedChapters.set(chapter.id, {
                        catId: cat.id, bookId: book.id,
                        catTitle: cat.title, bookTitle: book.title, chapterTitle: chapter.title
                    });
                }
            });
        });
    });

    renderSearchResults(query, matchedChapters, true);

    try {
        const escaped = query.replace(/[%_\\]/g, m => '\\' + m);
        const { data, error } = await supabaseClient
            .from('chapter_content')
            .select('id')
            .ilike('content', `%${escaped}%`);

        if (!error && data) {
            data.forEach(row => {
                if (matchedChapters.has(row.id)) return;
                outer:
                for (const cat of appData.categories || []) {
                    for (const book of cat.books || []) {
                        const ch = (book.chapters || []).find(c => c.id === row.id);
                        if (ch) {
                            matchedChapters.set(row.id, {
                                catId: cat.id, bookId: book.id,
                                catTitle: cat.title, bookTitle: book.title, chapterTitle: ch.title
                            });
                            break outer;
                        }
                    }
                }
            });
            renderSearchResults(query, matchedChapters, false);
        }
    } catch (err) {
        console.log('Content search failed (title-only results shown):', err);
    }
}

function renderSearchResults(query, matchedChapters, isPartial) {
    if (document.getElementById('searchInput').value.toLowerCase() !== query) return;

    let resultsHTML = `<h2>Search Results for "${query}"${isPartial ? ' <span style="font-size:0.6em;color:#888;">(खोज जारी है...)</span>' : ''}</h2><div class="grid-list">`;
    if (matchedChapters.size === 0) {
        resultsHTML += isPartial ? `<p>खोज रहे हैं...</p>` : `<p>No matching chapters found.</p>`;
    } else {
        matchedChapters.forEach((info, chapterId) => {
            resultsHTML += `
                <div class="search-result-item" onclick="jumpToChapter('${info.catId}', '${info.bookId}', '${chapterId}')">
                    <div class="search-path">📁 ${info.catTitle} > 📘 ${info.bookTitle}</div>
                    <strong>📑 ${info.chapterTitle}</strong>
                </div>
            `;
        });
    }
    resultsHTML += `</div>`;
    document.getElementById('contentArea').innerHTML = resultsHTML;
}

function jumpToChapter(catId, bId, cId) {
    document.getElementById('searchInput').value = '';
    openChapter(catId, bId, cId);
    if (window.innerWidth <= 768) toggleSidebar();
}

// ==========================================
// 7. BACKUP / RESTORE / EXPORT / IMPORT
// ==========================================
async function showAutoBackups() {
    if (!isUnlocked) return;
    currentCategoryId = null; currentBookId = null; currentChapterId = null; renderSidebar();
    document.getElementById('contentArea').innerHTML = `<div class="welcome-screen"><h2>Loading Backups... ⏳</h2></div>`;

    const full = await supabaseClient.from('full_backups').select('id,reason,created_at').order('created_at', { ascending: false }).limit(40);
    const legacy = await supabaseClient.from('auto_backups').select('backup_date').order('backup_date', { ascending: false });

    const reasons = { daily: 'Roz ka auto-backup', 'pre-delete-chapter': 'Chapter delete se pehle', 'pre-delete-book': 'Book delete se pehle', 'pre-delete-subject': 'Subject delete se pehle', 'pre-restore': 'Restore se pehle', 'pre-import': 'Import se pehle' };

    let html = `<div class="view-header"><h2>☁️ Full Backups (content ke saath)</h2></div><div class="grid-list">`;
    if (full.error) html += `<p>Full backups load nahi hue (full_backups table bana hai?)</p>`;
    (full.data || []).forEach(b => {
        html += `<div class="grid-card" style="align-items:center;">
            <span style="font-weight:bold;">📅 ${new Date(b.created_at).toLocaleString()}<br><small>${reasons[b.reason] || b.reason || ''}</small></span>
            <button onclick="restoreFullBackup('${b.id}')" style="padding:8px 15px; background:#e63946; color:white; border:none; border-radius:5px; cursor:pointer;">Restore</button>
        </div>`;
    });
    html += `</div>`;

    if ((legacy.data || []).length) {
        html += `<div class="view-header" style="margin-top:20px;"><h2>🗂️ Purane Daily Backups</h2></div><div class="grid-list">`;
        legacy.data.forEach(b => {
            html += `<div class="grid-card" style="align-items:center;">
                <span style="font-weight:bold;">📅 ${b.backup_date}</span>
                <button onclick="restoreAutoBackup('${b.backup_date}')" style="padding:8px 15px; background:#e63946; color:white; border:none; border-radius:5px; cursor:pointer;">Restore</button>
            </div>`;
        });
        html += `</div>`;
    }
    document.getElementById('contentArea').innerHTML = html;
}

// Restore / Import ka common raasta: pehle abhi ka backup, phir content, sabse aakhir me structure.
async function applyRestoredData(obj, reason) {
    let structure, contents = {};
    if (obj && obj.version === 2 && obj.structure) {
        structure = JSON.parse(JSON.stringify(obj.structure));
        contents = Object.assign({}, obj.contents || {});
    } else {
        structure = JSON.parse(JSON.stringify(obj));
    }
    normalizeStructure(structure);
    if (!Array.isArray(structure.categories)) throw new Error('File ka format sahi nahi hai');
    forEachChapter(structure, ch => {
        if (ch.content !== undefined) {
            if (contents[ch.id] === undefined) contents[ch.id] = ch.content;
            delete ch.content;
        }
    });

    if (!confirm(`Is backup me ${structure.categories.length} subjects hain. Restore karne par abhi ke notes REPLACE honge.\n\nPehle abhi ka poora backup apne aap ban jayega. Aage badhein?`)) return;
    if (!(await safetyBackup(reason))) return;

    setStatus("⏳ Restoring...");
    const ids = Object.keys(contents);
    const now = new Date().toISOString();
    for (let i = 0; i < ids.length; i += 25) {
        const rows = ids.slice(i, i + 25).map(id => ({ id, content: contents[id], updated_at: now }));
        const { error } = await supabaseClient.from('chapter_content').upsert(rows);
        if (error) throw error;      // structure abhi tak nahi chhua gaya
    }
    await forceWriteStructure(structure);
    location.reload();
}

async function restoreFullBackup(id) {
    if (!guard()) return;
    try {
        const { data, error } = await supabaseClient.from('full_backups').select('data').eq('id', id).single();
        if (error || !data) throw error || new Error('backup nahi mila');
        await applyRestoredData(data.data, 'pre-restore');
    } catch (err) {
        alert('❌ Restore nahi ho paya (kuch badla nahi gaya): ' + (err.message || err));
        setStatus("⚠️ Restore failed");
    }
}

async function restoreAutoBackup(dateStr) {
    if (!guard()) return;
    try {
        const { data, error } = await supabaseClient.from('auto_backups').select('data').eq('backup_date', dateStr).single();
        if (error || !data || !data.data) throw error || new Error('backup nahi mila');
        await applyRestoredData(data.data, 'pre-restore');
    } catch (err) {
        alert('❌ Restore nahi ho paya (kuch badla nahi gaya): ' + (err.message || err));
        setStatus("⚠️ Restore failed");
    }
}

async function exportBackup() {
    if (!isUnlocked) return;
    setStatus("⏳ Export ban raha hai...");
    try {
        await drainSaves();
        const contents = await fetchAllContents();
        const structure = JSON.parse(JSON.stringify(appData));
        forEachChapter(structure, ch => {
            if (ch.content !== undefined) {
                if (contents[ch.id] === undefined) contents[ch.id] = ch.content;
                delete ch.content;
            }
        });
        const payload = { version: 2, exportedAt: new Date().toISOString(), structure, contents };
        const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'MyBookNotes_Backup_' + new Date().toISOString().split('T')[0] + '.json';
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 5000);
        setStatus("☁️ Export ho gaya");
    } catch (err) {
        console.error(err);
        alert('❌ Export fail hua: ' + (err.message || err));
        setStatus("⚠️ Export failed");
    }
}

function importBackup(event) {
    const input = event.target;
    if (!guard()) { input.value = ''; return; }
    const file = input.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async function (e) {
        try {
            const parsed = JSON.parse(e.target.result);
            await applyRestoredData(parsed, 'pre-import');
        } catch (err) {
            alert('❌ Import nahi ho paya (kuch badla nahi gaya): ' + (err.message || err));
        }
        input.value = '';
    };
    reader.readAsText(file);
}

// ==========================================
// 8. SAFETY NETS (tab band / network wapas aane par)
// ==========================================
window.addEventListener('beforeunload', (e) => {
    if (pendingContent || contentSaving || structDirty || structSaving) {
        e.preventDefault();
        e.returnValue = '';
        return '';
    }
});
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') { flushContentSave(); flushStructure(); }
});
window.addEventListener('pagehide', () => { flushContentSave(); flushStructure(); });
window.addEventListener('online', () => { flushContentSave(); flushStructure(); });

function toggleSidebar() { document.getElementById('sidebar').classList.toggle('open'); }
