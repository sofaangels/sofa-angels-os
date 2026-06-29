const supabaseClient = supabase.createClient(window.SUPABASE_URL, window.SUPABASE_KEY);

let groups = [];
let history = [];
let photos = [];
let weeklyPost = null;
let currentUser = null;
let currentRole = "viewer";

function isAdmin(){ return currentRole === "admin"; }

function setStatus(text, ok=true){
  const el = document.getElementById("syncStatus");
  el.textContent = text;
  el.className = "sync " + (ok ? "ok" : "bad");
}

async function checkSession(){
  const { data } = await supabaseClient.auth.getSession();
  currentUser = data.session?.user || null;

  if(!currentUser){
    document.getElementById("loginScreen").classList.remove("hidden");
    document.getElementById("appShell").classList.add("hidden");
    return;
  }

  document.getElementById("loginScreen").classList.add("hidden");
  document.getElementById("appShell").classList.remove("hidden");

  await loadRole();
  await refreshAll();
}

async function loadRole(){
  currentRole = "viewer";
  const { data, error } = await supabaseClient
    .from("app_users")
    .select("role, display_name")
    .eq("user_id", currentUser.id)
    .maybeSingle();

  if(!error && data?.role) currentRole = data.role;

  const label = data?.display_name ? `${data.display_name} · ${currentRole}` : currentRole;
  const roleBadge = document.getElementById("roleBadge");
  roleBadge.textContent = label;
  roleBadge.className = "sync ok";

  document.getElementById("addGroupBtn").style.display = isAdmin() ? "inline-block" : "none";
  document.getElementById("groupHelp").textContent = isAdmin()
    ? "Add, edit or remove groups here. Changes save to Supabase instantly."
    : "View-only. Ask Lynsey/admin to add, edit or delete groups.";
}

async function login(){
  const email = document.getElementById("loginEmail").value.trim();
  const password = document.getElementById("loginPassword").value;
  const errorEl = document.getElementById("loginError");
  errorEl.textContent = "";

  const { error } = await supabaseClient.auth.signInWithPassword({ email, password });
  if(error){
    errorEl.textContent = error.message;
    return;
  }
  await checkSession();
}

async function logout(){
  await supabaseClient.auth.signOut();
  location.reload();
}

function isoToday(){ return new Date().toISOString().slice(0,10); }
function todayName(){ return new Date().toLocaleDateString("en-GB",{weekday:"long"}); }
function dateFromISO(iso){ const [y,m,d]=String(iso||"").split("-").map(Number); return new Date(y,m-1,d); }
function daysBetween(startISO,endISO){ return Math.floor((dateFromISO(endISO)-dateFromISO(startISO))/(24*60*60*1000)); }
function weeklyRule(group){ const text=((group.allowed_days||"")+" "+(group.notes||"")).toLowerCase(); return text.includes("anytime") || text.includes("once a week") || text.includes("weekly"); }
function dayAllowedToday(group){ const days=String(group.allowed_days||"").toLowerCase(); return days.includes("anytime") || days.includes(todayName().toLowerCase()); }
function latestHistory(groupId){ return history.filter(h=>h.group_id===groupId).sort((a,b)=>String(b.posted_at).localeCompare(String(a.posted_at)))[0] || null; }

function isDue(group){
  if(!dayAllowedToday(group)) return false;
  const rec = latestHistory(group.id);
  if(!rec) return true;
  if(weeklyRule(group)) return daysBetween(rec.posted_at, isoToday()) >= 7;
  return rec.posted_at !== isoToday();
}

function statusText(group){
  const rec = latestHistory(group.id);
  if(!dayAllowedToday(group)) return "Waiting for allowed day";
  if(!rec) return "Available now";
  if(weeklyRule(group)){
    const days = daysBetween(rec.posted_at, isoToday());
    if(days >= 7) return "Available now";
    const next = new Date(dateFromISO(rec.posted_at).getTime()+7*24*60*60*1000);
    return "Available again " + next.toLocaleDateString("en-GB",{weekday:"short",day:"numeric",month:"short"});
  }
  return rec.posted_at === isoToday() ? "Posted today" : "Available now";
}

function safeCopy(text){
  if(navigator.clipboard && window.isSecureContext){
    return navigator.clipboard.writeText(text).then(()=>true).catch(()=>fallbackCopy(text));
  }
  return Promise.resolve(fallbackCopy(text));
}
function fallbackCopy(text){
  const ta=document.createElement("textarea");
  ta.value=text; ta.style.position="fixed"; ta.style.left="-9999px";
  document.body.appendChild(ta); ta.focus(); ta.select();
  let ok=false; try{ok=document.execCommand("copy")}catch(e){ok=false}
  document.body.removeChild(ta); return ok;
}
function esc(text){ return String(text||"").replaceAll("\\","\\\\").replaceAll("'","\\'"); }
function table(headers, rows){
  // Adds mobile-friendly labels to each td based on the table headers.
  const processed = rows.map(row => {
    let i = 0;
    return row.replace(/<td(.*?)>/g, (match, attrs) => {
      const label = headers[i] || "";
      i++;
      return `<td${attrs} data-label="${label}">`;
    });
  });
  return `<table><thead><tr>${headers.map(h=>`<th>${h}</th>`).join("")}</tr></thead><tbody>${processed.join("")}</tbody></table>`;
}

document.querySelectorAll(".tab").forEach(btn=>{
  btn.onclick=()=>{
    document.querySelectorAll(".tab,.panel").forEach(x=>x.classList.remove("active"));
    btn.classList.add("active");
    document.getElementById(btn.dataset.tab).classList.add("active");
  }
});

async function refreshAll(){
  if(!currentUser) return;
  try{
    setStatus("Syncing...");
    const [gRes,hRes,pRes,photoRes] = await Promise.all([
      supabaseClient.from("facebook_groups").select("*").order("name"),
      supabaseClient.from("posting_history").select("*").order("posted_at",{ascending:false}),
      supabaseClient.from("weekly_post").select("*").order("updated_at",{ascending:false}).limit(1),
      supabaseClient.from("post_photos").select("*").order("created_at",{ascending:false})
    ]);
    if(gRes.error) throw gRes.error;
    if(hRes.error) throw hRes.error;
    if(pRes.error) throw pRes.error;
    if(photoRes.error) throw photoRes.error;

    groups = gRes.data || [];
    history = hRes.data || [];
    weeklyPost = (pRes.data || [])[0] || null;
    photos = photoRes.data || [];
    document.getElementById("caption").value = weeklyPost?.caption || "";
    setStatus("Synced");
    render();
  }catch(err){
    console.error(err);
    setStatus("Error syncing", false);
    alert("Supabase error: " + err.message);
  }
}

function render(){
  const due = groups.filter(isDue);
  const postedToday = groups.filter(g => latestHistory(g.id)?.posted_at === isoToday());

  document.getElementById("dueCount").textContent = due.length;
  document.getElementById("postedTodayCount").textContent = postedToday.length;
  document.getElementById("photoCount").textContent = photos.length;

  renderPhotos();
  renderGroups();
  renderToday();
  renderHistory();
}

function renderPhotos(){
  const html = photos.map(p=>`
    <div class="photoCard">
      <img src="${p.file_url}" alt="${p.file_name || ""}">
      <input value="${p.label || ""}" placeholder="Sofa name / note" onchange="updatePhotoLabel('${p.id}', this.value)">
      <small>${p.file_name || ""}</small>
      <button class="secondary" onclick="deletePhoto('${p.id}')">Remove</button>
    </div>
  `).join("");
  document.getElementById("photoGrid").innerHTML = html || "<p class='hint'>No photos uploaded yet.</p>";
}

function renderGroups(){
  const q=(document.getElementById("search")?.value||"").toLowerCase();
  const f=document.getElementById("dayFilter")?.value||"";
  const list=groups.filter(g=>{
    const matchesSearch=JSON.stringify(g).toLowerCase().includes(q);
    const matchesDay=!f || String(g.allowed_days||"").toLowerCase().includes(f.toLowerCase());
    return matchesSearch && matchesDay;
  });
  const rows=list.map(g=>`
    <tr>
      <td><strong>${g.name}</strong></td>
      <td>${g.area||""}</td>
      <td><span class="badge">${g.allowed_days||""}</span></td>
      <td>${g.link ? `<a href="${g.link}" target="_blank">Open</a>` : "No link"}</td>
      <td>${g.notes||""}</td>
      <td>
        <div class="actions">
          ${isAdmin() ? `<button class="small secondary" onclick="showEditGroup('${g.id}')">Edit</button>
          <button class="small danger" onclick="deleteGroup('${g.id}')">Delete</button>` : `<span class="hint">View only</span>`}
        </div>
      </td>
    </tr>
  `);
  document.getElementById("groupTable").innerHTML = table(["Group","Area","Allowed Days","Link","Notes","Manage"], rows);
}

function renderToday(){
  const due = groups.filter(isDue);
  const postedToday = groups.filter(g => latestHistory(g.id)?.posted_at === isoToday()).length;
  const totalToday = due.length + postedToday;
  const progress = totalToday ? Math.round((postedToday/totalToday)*100) : 0;
  document.getElementById("progressBar").style.width = progress + "%";

  const rows = due.map(g=>`
    <tr>
      <td><input type="checkbox" onchange="markPosted('${g.id}', this.checked)"></td>
      <td><strong>${g.name}</strong></td>
      <td>${g.area||""}</td>
      <td>${g.allowed_days||""}</td>
      <td><button onclick="copyAndOpen('${esc(g.link||"")}')">${g.link ? "Copy + Open Group" : "Copy Caption"}</button></td>
      <td>${statusText(g)}${g.notes ? "<br><small>"+g.notes+"</small>" : ""}</td>
    </tr>
  `);
  document.getElementById("todayTable").innerHTML = table(
    ["Done","Group","Area","Allowed Days","Action","Status / Notes"],
    rows.length ? rows : [`<tr><td colspan="6">Nothing due right now. You're all caught up.</td></tr>`]
  );
}

function renderHistory(){
  const notDue = groups.filter(g=>!isDue(g));
  const rows = notDue.map(g=>{
    const rec = latestHistory(g.id);
    const posted = rec ? new Date(rec.posted_at).toLocaleDateString("en-GB") : "";
    return `
      <tr>
        <td><strong>${g.name}</strong></td>
        <td>${g.area||""}</td>
        <td>${posted || "Not posted recently"}</td>
        <td><span class="badge wait">${statusText(g)}</span></td>
        <td>${rec ? `<button class="secondary small" onclick="undoGroup('${g.id}')">Undo</button>` : ""}</td>
      </tr>
    `;
  });
  document.getElementById("historyTable").innerHTML = table(
    ["Group","Area","Last Posted","Status","Action"],
    rows.length ? rows : [`<tr><td colspan="5">No groups are waiting. Everything due is in today's list.</td></tr>`]
  );
}

async function saveCaption(){
  const caption = document.getElementById("caption").value;
  const now = new Date().toISOString();
  let res;
  if(weeklyPost?.id){
    res = await supabaseClient.from("weekly_post").update({caption, updated_at: now}).eq("id", weeklyPost.id);
  }else{
    res = await supabaseClient.from("weekly_post").insert({caption, updated_at: now});
  }
  if(res.error){ alert(res.error.message); return; }
  document.getElementById("copyStatus").textContent = "Caption saved and synced.";
  await refreshAll();
}

async function copyCaption(){
  const caption = document.getElementById("caption").value;
  const ok = await safeCopy(caption || "");
  document.getElementById("copyStatus").textContent = ok ? "Caption copied." : "Copy failed. Highlight the caption and copy manually.";
}

async function copyAndOpen(link){
  await copyCaption();
  if(link) window.open(link, "_blank");
}

async function markPosted(groupId, checked){
  if(!checked) return;
  const { error } = await supabaseClient.from("posting_history").insert({
    group_id: groupId,
    posted_at: isoToday(),
    posted_by: currentUser.email
  });
  if(error){ alert(error.message); return; }
  await refreshAll();
}

async function undoGroup(groupId){
  const rec = latestHistory(groupId);
  if(!rec) return;
  const { error } = await supabaseClient.from("posting_history").delete().eq("id", rec.id);
  if(error){ alert(error.message); return; }
  await refreshAll();
}

async function undoToday(){
  if(!confirm("Undo all groups marked as posted today?")) return;
  const ids = history.filter(h=>h.posted_at===isoToday()).map(h=>h.id);
  if(!ids.length) return;
  const { error } = await supabaseClient.from("posting_history").delete().in("id", ids);
  if(error){ alert(error.message); return; }
  await refreshAll();
}

function scrollToPhotos(){
  document.querySelector('[data-tab="post"]').click();
  setTimeout(()=>document.getElementById("photoGrid").scrollIntoView({behavior:"smooth"}),100);
}

function clearGroupForm(){
  ["gId","gName","gLink","gArea","gDays","gNotes"].forEach(id=>document.getElementById(id).value="");
}

function showAddGroup(){
  if(!isAdmin()){ alert("Only an admin can add groups."); return; }
  clearGroupForm();
  document.getElementById("groupDialogTitle").textContent = "Add Facebook Group";
  document.getElementById("groupDialog").showModal();
}

function showEditGroup(groupId){
  if(!isAdmin()){ alert("Only an admin can edit groups."); return; }
  const g = groups.find(x=>x.id===groupId);
  if(!g) return;
  document.getElementById("groupDialogTitle").textContent = "Edit Facebook Group";
  document.getElementById("gId").value = g.id;
  document.getElementById("gName").value = g.name || "";
  document.getElementById("gLink").value = g.link || "";
  document.getElementById("gArea").value = g.area || "";
  document.getElementById("gDays").value = g.allowed_days || "";
  document.getElementById("gNotes").value = g.notes || "";
  document.getElementById("groupDialog").showModal();
}

async function saveGroup(event){
  event.preventDefault();
  if(!isAdmin()){ alert("Only an admin can save groups."); return; }

  const id = document.getElementById("gId").value;
  const payload = {
    name: document.getElementById("gName").value.trim(),
    link: document.getElementById("gLink").value.trim(),
    area: document.getElementById("gArea").value.trim(),
    allowed_days: document.getElementById("gDays").value.trim(),
    notes: document.getElementById("gNotes").value.trim()
  };
  if(!payload.name){ alert("Please add a group name."); return; }

  let result;
  if(id){
    result = await supabaseClient.from("facebook_groups").update(payload).eq("id", id);
  }else{
    result = await supabaseClient.from("facebook_groups").insert(payload);
  }

  if(result.error){ alert(result.error.message); return; }
  document.getElementById("groupDialog").close();
  clearGroupForm();
  await refreshAll();
}

async function deleteGroup(groupId){
  if(!isAdmin()){ alert("Only an admin can delete groups."); return; }
  const g = groups.find(x=>x.id===groupId);
  if(!g) return;
  if(!confirm(`Delete "${g.name}"? This also removes its posting history.`)) return;

  const { error } = await supabaseClient.from("facebook_groups").delete().eq("id", groupId);
  if(error){ alert(error.message); return; }
  await refreshAll();
}

document.getElementById("photoInput").addEventListener("change", e=>handleFiles(e.target.files));
const dz = document.getElementById("dropZone");
dz.addEventListener("dragover", e=>{e.preventDefault(); dz.classList.add("drag");});
dz.addEventListener("dragleave", ()=>dz.classList.remove("drag"));
dz.addEventListener("drop", e=>{e.preventDefault(); dz.classList.remove("drag"); handleFiles(e.dataTransfer.files);});

async function handleFiles(fileList){
  const files = [...fileList].filter(f=>f.type.startsWith("image/"));
  if(!files.length) return;
  document.getElementById("photoStatus").textContent = `Uploading ${files.length} photo(s)...`;

  for(const file of files){
    const safeName = file.name.replace(/[^a-z0-9_.-]/gi, "_");
    const path = `${Date.now()}-${Math.random().toString(36).slice(2)}-${safeName}`;

    const upload = await supabaseClient.storage.from("sofa-images").upload(path, file);
    if(upload.error){ alert("Upload error: " + upload.error.message); continue; }

    const publicUrl = supabaseClient.storage.from("sofa-images").getPublicUrl(path).data.publicUrl;
    const insert = await supabaseClient.from("post_photos").insert({
      file_url: publicUrl,
      file_name: file.name,
      label: ""
    });
    if(insert.error){ alert("Photo database error: " + insert.error.message); }
  }

  document.getElementById("photoStatus").textContent = "Upload complete.";
  await refreshAll();
}

async function updatePhotoLabel(id, label){
  const { error } = await supabaseClient.from("post_photos").update({label}).eq("id", id);
  if(error){ alert(error.message); return; }
  await refreshAll();
}

async function deletePhoto(id){
  const { error } = await supabaseClient.from("post_photos").delete().eq("id", id);
  if(error){ alert(error.message); return; }
  await refreshAll();
}

supabaseClient.auth.onAuthStateChange((_event, session)=>{
  currentUser = session?.user || null;
});

checkSession();
