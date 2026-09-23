import { SEED_DATA } from "../data/seed.js";

const DAYS = ["السبت", "الأحد", "الاثنين", "الثلاثاء", "الأربعاء", "الخميس"];
const LOCAL_KEY = "zoology-lab-schedule-v2";
const cfg = window.APP_CONFIG || {};
const WORKLOAD_LABELS = { target: "داخل النصاب", extra: "ساعات إضافية", excluded: "لا تُحسب" };
const PROGRAM_TYPES = ["برنامج عام", "برنامج خاص", "أخرى"];

const state = {
  data: structuredClone(SEED_DATA),
  mode: "local",
  supabase: null,
  user: null,
  currentView: "final",
  dirty: false,
  dirtySessions: new Set(),
  deletedSessionIds: new Set(),
  deletedAssistantIds: new Set(),
  deletedFacultyIds: new Set(),
  deletedCourseIds: new Set(),
  deletedRoleTargets: new Set(),
  remoteSessionIds: new Set(),
  autoSaveTimer: null,
  selectedPersonType: "assistant",
  selectedPersonId: null,
  adminPersonType: "assistant",
  search: "",
};

const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];
const esc = (v = "") => String(v).replace(/[&<>'"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;"}[c]));
const clone = v => structuredClone(v);
const uid = prefix => `${prefix}-${globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`}`;

function toMinutes(t) {
  if (!t) return 0;
  const [h, m] = String(t).slice(0,5).split(":").map(Number);
  return h * 60 + m;
}
function calcDuration(start, end) {
  let a = toMinutes(start), b = toMinutes(end);
  if (b < a) b += 1440;
  return Math.round(((b - a) / 60) * 100) / 100;
}
function fmtTime(t) {
  if (!t) return "";
  const [hh, mm] = String(t).slice(0,5).split(":").map(Number);
  const suffix = hh >= 12 ? "م" : "ص";
  let h = hh % 12; if (h === 0) h = 12;
  return `${h}:${String(mm).padStart(2, "0")} ${suffix}`;
}
function fmtRange(s) { return `${fmtTime(s.startTime)} - ${fmtTime(s.endTime)}`; }
function stripTitle(name = "") {
  return String(name).replace(/^(?:أ\.د\.|أ\.د\s*\.|د\.|د\/)+\s*/u, "").trim();
}
function compactName(name, title = "") {
  const words = stripTitle(name).split(/\s+/).filter(Boolean);
  const short = words.slice(0, 2).join(" ");
  return title ? `${title} ${short}`.trim() : short;
}
function personFullName(person) {
  if (!person) return "";
  const core = stripTitle(person.name || "");
  return `${person.title || ""} ${core}`.trim();
}
function facultyShort(person) { return compactName(person?.name, person?.title || ""); }
function assistantShort(person) { return compactName(person?.name, person?.title || ""); }
function sortSessions(arr) {
  return [...arr].sort((a,b) => (a.dayOrder-b.dayOrder) || a.startTime.localeCompare(b.startTime) || a.endTime.localeCompare(b.endTime) || sessionCourseName(a).localeCompare(sessionCourseName(b),"ar") || a.labNo-b.labNo);
}
function sessionMap() { return new Map(state.data.sessions.map(s => [s.id,s])); }
function assistantMap() { return new Map(state.data.assistantPeople.map(p => [Number(p.id),p])); }
function facultyMap() { return new Map(state.data.faculty.map(p => [Number(p.id),p])); }
function courseMap() { return new Map(state.data.courseCatalog.map(c => [c.id,c])); }
function courseByNameMap() { return new Map(state.data.courseCatalog.map(c => [c.name,c])); }
function assignmentsFor(sessionId, type) {
  const rows = type === "assistant" ? state.data.assistantAssignments : state.data.supervisorAssignments;
  return rows.filter(a => a.sessionId === sessionId).sort((a,b) => a.position-b.position);
}
function activeCourses() { return state.data.courseCatalog.filter(c=>c.active!==false).sort((a,b)=>a.name.localeCompare(b.name,"ar")); }
function courseForSession(s) {
  return courseMap().get(s?.courseId) || courseByNameMap().get(s?.course) || null;
}
function sessionCourseName(s) { return courseForSession(s)?.name || s?.course || ""; }
function sessionProgramType(s) { return courseForSession(s)?.programType || "برنامج عام"; }
function sessionWorkloadMode(s) { return courseForSession(s)?.workloadMode || "target"; }
function coursePolicyLabel(s) { return `${sessionProgramType(s)} · ${WORKLOAD_LABELS[sessionWorkloadMode(s)] || "داخل النصاب"}`; }
function canEdit() { return state.mode === "local" || !!state.user; }

function deriveRoleTargets(data) {
  const out=[];
  for (const [personType,key] of [["assistant","assistantPeople"],["faculty","faculty"]]) {
    const grouped=new Map();
    for (const p of data[key] || []) {
      if (!grouped.has(p.role)) grouped.set(p.role,[]);
      grouped.get(p.role).push(Number(p.targetHours || 0));
    }
    for (const [role,vals] of grouped) {
      const counts=new Map(); vals.forEach(v=>counts.set(v,(counts.get(v)||0)+1));
      const target=[...counts.entries()].sort((a,b)=>b[1]-a[1])[0]?.[0] || 0;
      out.push({id:`${personType}:${role}`,personType,role,targetHours:target,active:true});
    }
  }
  return out;
}
function deriveCourses(data) {
  const names=[];
  for (const s of data.sessions || []) if (s.course && !names.includes(s.course)) names.push(s.course);
  return names.map((name,i)=>{
    const rows=(data.sessions||[]).filter(s=>s.course===name);
    const specialty=rows.find(s=>s.specialty)?.specialty || "";
    return {id:`C${String(i+1).padStart(3,"0")}`,code:/^[A-Za-z0-9_-]+$/.test(name)?name:"",name,programType:"برنامج عام",workloadMode:"target",specialty,supervisionRequiredDefault:rows.some(s=>s.supervisionRequired!==false),active:true,notes:""};
  });
}
function roleTarget(type, role) {
  return state.data.roleTargets.find(x=>x.personType===type && x.role===role && x.active!==false) || null;
}
function effectiveTarget(person,type) {
  if (person?.targetOverride !== null && person?.targetOverride !== undefined && person?.targetOverride !== "") return Number(person.targetOverride) || 0;
  const rt=roleTarget(type,person?.role);
  if (rt) return Number(rt.targetHours)||0;
  return Number(person?.targetHours)||0;
}
function normalizeState() {
  state.data.assistantPeople ||= [];
  state.data.faculty ||= [];
  state.data.sessions ||= [];
  state.data.assistantAssignments ||= [];
  state.data.supervisorAssignments ||= [];
  state.data.meta ||= clone(SEED_DATA.meta || {});
  state.data.roleTargets ||= deriveRoleTargets(state.data);
  state.data.courseCatalog ||= deriveCourses(state.data);
  state.data.roleTargets.forEach(x=>{ x.id ||= `${x.personType}:${x.role}`; x.targetHours=Number(x.targetHours)||0; x.active=x.active!==false; });
  state.data.courseCatalog.forEach(c=>{
    c.programType ||= "برنامج عام"; c.workloadMode ||= "target"; c.specialty ||= ""; c.supervisionRequiredDefault=c.supervisionRequiredDefault!==false; c.active=c.active!==false; c.notes ||= "";
  });
  state.data.assistantPeople.forEach((p,i)=>{ p.targetOverride ??= null; p.sortOrder ??= i+1; p.active=p.active!==false; });
  state.data.faculty.forEach(p=>{ p.targetOverride ??= null; p.active=p.active!==false; p.specialty ||= ""; p.status ||= ""; p.title ||= ""; });
  const byName=courseByNameMap();
  state.data.sessions.forEach(s => {
    s.dayOrder = DAYS.indexOf(s.day)+1 || 99;
    s.durationHours = calcDuration(s.startTime,s.endTime);
    s.active = s.active !== false;
    s.supervisionRequired = s.supervisionRequired !== false;
    if (!s.courseId) s.courseId=byName.get(s.course)?.id || null;
    const c=courseMap().get(s.courseId);
    if (c) s.course=c.name;
  });
}

function markDirty(sessionId) {
  state.dirty = true;
  if (sessionId) state.dirtySessions.add(sessionId);
  updateBadges();
  if (cfg.AUTO_SAVE !== false) scheduleAutoSave();
}
function scheduleAutoSave() {
  clearTimeout(state.autoSaveTimer);
  const delay = Number(cfg.AUTO_SAVE_DELAY_MS || 1200);
  state.autoSaveTimer = setTimeout(() => { if (state.dirty && canEdit()) saveAll(true); }, delay);
}
function updateBadges() {
  const c = $("#connectionBadge"), s = $("#saveBadge"), l = $("#loginBtn");
  if (state.mode === "remote") {
    c.textContent = "Supabase متصل"; c.className = "badge badge-ok";
    l.textContent = state.user ? `خروج (${state.user.email || "مسؤول"})` : "تسجيل الدخول";
  } else {
    c.textContent = "وضع محلي"; c.className = "badge badge-warn";
    l.textContent = "تسجيل الدخول";
  }
  s.textContent = state.dirty ? "تعديلات غير محفوظة" : "محفوظ";
  s.className = state.dirty ? "badge badge-warn" : "badge badge-ok";
  $("#saveBtn").disabled = !state.dirty || !canEdit();
}

async function initSupabase() {
  const url = String(cfg.SUPABASE_URL || "").trim();
  const key = String(cfg.SUPABASE_ANON_KEY || "").trim();
  if (!url || !key || url.includes("YOUR-PROJECT") || key.includes("YOUR_SUPABASE")) return false;
  try {
    const { createClient } = await import("https://esm.sh/@supabase/supabase-js@2");
    state.supabase = createClient(url, key, { auth: { persistSession: true, autoRefreshToken: true } });
    state.mode = "remote";
    const { data: authData } = await state.supabase.auth.getSession();
    state.user = authData?.session?.user || null;
    state.supabase.auth.onAuthStateChange((_event, session) => { state.user = session?.user || null; updateBadges(); render(); });
    const loaded = await loadRemote();
    if (!loaded) loadLocalOrSeed();
    return true;
  } catch (err) {
    console.error(err); state.mode = "local"; return false;
  }
}
function loadLocalOrSeed() {
  try {
    const saved = localStorage.getItem(LOCAL_KEY);
    state.data = saved ? JSON.parse(saved) : clone(SEED_DATA);
  } catch { state.data = clone(SEED_DATA); }
  normalizeState();
}
function fromDb(raw) {
  return {
    meta: clone(SEED_DATA.meta),
    roleTargets: (raw.roleTargets||[]).map(x=>({id:`${x.person_type}:${x.role}`,personType:x.person_type,role:x.role,targetHours:Number(x.target_hours),active:x.active})),
    courseCatalog: (raw.courses||[]).map(x=>({id:x.id,code:x.code||"",name:x.name,programType:x.program_type||"برنامج عام",workloadMode:x.workload_mode||"target",specialty:x.specialty||"",supervisionRequiredDefault:x.supervision_required_default!==false,active:x.active,notes:x.notes||""})),
    assistantPeople: raw.assistantPeople.map(x => ({id:x.id,name:x.name,displayName:x.display_name,title:x.title||"",role:x.role,sortOrder:x.sort_order,targetHours:Number(x.target_hours||0),targetOverride:x.target_override===null?null:Number(x.target_override),active:x.active})),
    faculty: raw.faculty.map(x => ({id:x.id,name:x.name,title:x.title||"",role:x.role,status:x.status||"",specialty:x.specialty||"",targetHours:Number(x.target_hours||0),targetOverride:x.target_override===null?null:Number(x.target_override),active:x.active})),
    sessions: raw.sessions.map(x => ({id:x.id,sourceRow:x.source_row,day:x.day,dayOrder:x.day_order,startTime:String(x.start_time).slice(0,5),endTime:String(x.end_time).slice(0,5),durationHours:Number(x.duration_hours),courseId:x.course_id||null,course:x.course,specialty:x.specialty||"",labNo:x.lab_no,supervisionRequired:x.supervision_required,notes:x.notes||"",active:x.active})),
    assistantAssignments: raw.assistantAssignments.map(x => ({sessionId:x.session_id,personId:x.person_id,position:x.position})),
    supervisorAssignments: raw.supervisorAssignments.map(x => ({sessionId:x.session_id,facultyId:x.faculty_id,position:x.position})),
  };
}
function sessionToDb(s) {
  return { id:s.id, source_row:s.sourceRow || null, day:s.day, day_order:DAYS.indexOf(s.day)+1, start_time:s.startTime, end_time:s.endTime, duration_hours:calcDuration(s.startTime,s.endTime), course_id:s.courseId||null, course:sessionCourseName(s), specialty:s.specialty||null, lab_no:Number(s.labNo), supervision_required:!!s.supervisionRequired, notes:s.notes||null, active:s.active!==false };
}
function assistantToDb(x) { return {id:x.id,name:x.name,display_name:x.displayName||personFullName(x),title:x.title||null,role:x.role,sort_order:x.sortOrder||null,target_hours:effectiveTarget(x,"assistant"),target_override:x.targetOverride===null||x.targetOverride===""?null:Number(x.targetOverride),active:x.active!==false}; }
function facultyToDb(x) { return {id:x.id,name:x.name,title:x.title||null,role:x.role,status:x.status||null,specialty:x.specialty||null,target_hours:effectiveTarget(x,"faculty"),target_override:x.targetOverride===null||x.targetOverride===""?null:Number(x.targetOverride),active:x.active!==false}; }
function courseToDb(c) { return {id:c.id,code:c.code||null,name:c.name,program_type:c.programType||"برنامج عام",workload_mode:c.workloadMode||"target",specialty:c.specialty||null,supervision_required_default:c.supervisionRequiredDefault!==false,active:c.active!==false,notes:c.notes||null}; }
function roleTargetToDb(x) { return {person_type:x.personType,role:x.role,target_hours:Number(x.targetHours)||0,active:x.active!==false}; }

async function loadRemote() {
  const sb = state.supabase;
  if (!sb) return false;
  const [rt,c,p,f,s,aa,sa] = await Promise.all([
    sb.from("role_targets").select("*").order("person_type").order("role"),
    sb.from("courses").select("*").order("name"),
    sb.from("assistant_people").select("*").order("id"),
    sb.from("faculty").select("*").order("id"),
    sb.from("sessions").select("*").order("day_order").order("start_time").order("lab_no"),
    sb.from("assistant_assignments").select("*").order("session_id").order("position"),
    sb.from("supervisor_assignments").select("*").order("session_id").order("position"),
  ]);
  const error = rt.error || c.error || p.error || f.error || s.error || aa.error || sa.error;
  if (error) {
    console.error("Supabase load error", error);
    if (String(error.message||"").includes("role_targets") || String(error.message||"").includes("courses")) {
      toast("قاعدة البيانات تحتاج تشغيل migration_v2.sql أولاً.", true);
    }
    return false;
  }
  if (!s.data?.length) {
    state.data = clone(SEED_DATA); normalizeState(); state.remoteSessionIds = new Set(); return true;
  }
  state.data = fromDb({roleTargets:rt.data||[],courses:c.data||[],assistantPeople:p.data||[],faculty:f.data||[],sessions:s.data||[],assistantAssignments:aa.data||[],supervisorAssignments:sa.data||[]});
  normalizeState(); state.remoteSessionIds = new Set(state.data.sessions.map(x=>x.id)); return true;
}

async function seedRemote() {
  if (!state.supabase || !state.user) return openLogin();
  if (!confirm("سيتم تحميل بيانات البداية المدمجة وإعدادات النصاب والمواد إلى قاعدة البيانات. هل تريد المتابعة؟")) return;
  const d=clone(SEED_DATA); state.data=d; normalizeState();
  const sb=state.supabase;
  const calls=[
    await sb.from("role_targets").upsert(state.data.roleTargets.map(roleTargetToDb),{onConflict:"person_type,role"}),
    await sb.from("courses").upsert(state.data.courseCatalog.map(courseToDb)),
    await sb.from("assistant_people").upsert(state.data.assistantPeople.map(assistantToDb)),
    await sb.from("faculty").upsert(state.data.faculty.map(facultyToDb)),
    await sb.from("sessions").upsert(state.data.sessions.map(sessionToDb)),
    await sb.from("assistant_assignments").upsert(state.data.assistantAssignments.map(x=>({session_id:x.sessionId,person_id:x.personId,position:x.position}))),
    await sb.from("supervisor_assignments").upsert(state.data.supervisorAssignments.map(x=>({session_id:x.sessionId,faculty_id:x.facultyId,position:x.position}))),
  ];
  const err=calls.find(x=>x.error)?.error;
  if (err) return alert(`تعذر تهيئة البيانات: ${err.message}`);
  await loadRemote(); clearDirty(); updateBadges(); render(); alert("تم تحميل البيانات الأولية إلى Supabase.");
}
function clearDirty() {
  state.dirty=false; state.dirtySessions.clear(); state.deletedSessionIds.clear(); state.deletedAssistantIds.clear(); state.deletedFacultyIds.clear(); state.deletedCourseIds.clear(); state.deletedRoleTargets.clear();
}
async function saveAll(silent=false) {
  clearTimeout(state.autoSaveTimer);
  if (!state.dirty) return;
  if (state.mode === "local") {
    localStorage.setItem(LOCAL_KEY, JSON.stringify(state.data)); clearDirty(); updateBadges(); if (!silent) toast("تم الحفظ محلياً على هذا الجهاز."); return;
  }
  if (!state.user) { if (!silent) openLogin(); return; }
  const sb=state.supabase;
  try {
    // الحذف أولاً حتى يمكن إعادة استخدام نفس الاسم/الدرجة بدون تعارض unique.
    for (const id of state.deletedSessionIds) { const {error}=await sb.from("sessions").delete().eq("id",id); if(error) throw error; }
    for (const id of state.deletedAssistantIds) {
      let q=await sb.from("assistant_assignments").delete().eq("person_id",id); if(q.error) throw q.error;
      q=await sb.from("assistant_people").delete().eq("id",id); if(q.error) throw q.error;
    }
    for (const id of state.deletedFacultyIds) {
      let q=await sb.from("supervisor_assignments").delete().eq("faculty_id",id); if(q.error) throw q.error;
      q=await sb.from("faculty").delete().eq("id",id); if(q.error) throw q.error;
    }
    for (const id of state.deletedCourseIds) { const {error}=await sb.from("courses").delete().eq("id",id); if(error) throw error; }
    for (const key of state.deletedRoleTargets) {
      const sep=key.indexOf(":"); const personType=key.slice(0,sep), role=key.slice(sep+1);
      const {error}=await sb.from("role_targets").delete().eq("person_type",personType).eq("role",role); if(error) throw error;
    }

    // ثم حفظ القوائم المرجعية قبل الجلسات والتكليفات.
    const r1=await sb.from("role_targets").upsert(state.data.roleTargets.map(roleTargetToDb),{onConflict:"person_type,role"}); if(r1.error) throw r1.error;
    const r2=await sb.from("courses").upsert(state.data.courseCatalog.map(courseToDb)); if(r2.error) throw r2.error;
    const r3=await sb.from("assistant_people").upsert(state.data.assistantPeople.map(assistantToDb)); if(r3.error) throw r3.error;
    const r4=await sb.from("faculty").upsert(state.data.faculty.map(facultyToDb)); if(r4.error) throw r4.error;

    for (const id of state.dirtySessions) {
      const s=state.data.sessions.find(x=>x.id===id); if (!s) continue;
      const {error:se}=await sb.from("sessions").upsert(sessionToDb(s)); if (se) throw se;
      const {error:a1}=await sb.from("assistant_assignments").delete().eq("session_id",id); if (a1) throw a1;
      const {error:a2}=await sb.from("supervisor_assignments").delete().eq("session_id",id); if (a2) throw a2;
      const aa=assignmentsFor(id,"assistant").map(x=>({session_id:id,person_id:x.personId,position:x.position}));
      const sa=assignmentsFor(id,"faculty").map(x=>({session_id:id,faculty_id:x.facultyId,position:x.position}));
      if (aa.length) { const {error}=await sb.from("assistant_assignments").insert(aa); if (error) throw error; }
      if (sa.length) { const {error}=await sb.from("supervisor_assignments").insert(sa); if (error) throw error; }
    }
    state.remoteSessionIds = new Set(state.data.sessions.map(x=>x.id)); clearDirty(); updateBadges(); if (!silent) toast("تم الحفظ على قاعدة البيانات.");
  } catch (err) { console.error(err); toast(`خطأ في الحفظ: ${err.message || err}`, true); }
}

function toast(message, danger=false) {
  const el=document.createElement("div"); el.textContent=message;
  el.style.cssText=`position:fixed;left:18px;bottom:18px;z-index:1000;padding:10px 14px;border-radius:10px;color:white;background:${danger?'#b42318':'#17365d'};box-shadow:0 8px 28px rgba(0,0,0,.22);font-weight:700`;
  document.body.appendChild(el); setTimeout(()=>el.remove(),3000);
}

function render() {
  $$(".tab").forEach(b=>b.classList.toggle("active",b.dataset.view===state.currentView));
  if (state.currentView === "final") renderFinal();
  else if (state.currentView === "assistants") renderAssistants();
  else if (state.currentView === "supervision") renderSupervision();
  else if (state.currentView === "members") renderMembers();
  else if (state.currentView === "conflicts") renderConflicts();
  else if (state.currentView === "admin") renderAdmin();
  else if (state.currentView === "history") renderHistory();
  else renderSettings();
  updateBadges();
}

function groupedFinalData() {
  const groupsByDay = new Map(DAYS.map(d=>[d,new Map()]));
  for (const s of sortSessions(state.data.sessions.filter(x=>x.active!==false))) {
    if (!groupsByDay.has(s.day)) groupsByDay.set(s.day,new Map());
    const key=`${s.day}|${s.startTime}|${s.endTime}|${s.courseId||s.course}`;
    const map=groupsByDay.get(s.day);
    if (!map.has(key)) map.set(key,{day:s.day,startTime:s.startTime,endTime:s.endTime,course:sessionCourseName(s),labs:[]});
    map.get(key).labs.push(s);
  }
  return groupsByDay;
}
function renderLabText(session,type) {
  const aMap=assistantMap(), fMap=facultyMap(); const list=assignmentsFor(session.id,type);
  if (type==="assistant") return list.map(x=>assistantShort(aMap.get(Number(x.personId)))).filter(Boolean).join("، ");
  if (!session.supervisionRequired) return `<span class="no-supervision">بدون إشراف</span>`;
  if (!list.length) return `<span class="needs-supervision">يحتاج توزيع إشراف</span>`;
  return list.map(x=>facultyShort(fMap.get(Number(x.facultyId)))).filter(Boolean).join("، ");
}
function renderFinal() {
  const groups=groupedFinalData();
  const missing=state.data.sessions.filter(s=>s.active!==false&&s.supervisionRequired&&!assignmentsFor(s.id,"faculty").length).length;
  const html=[];
  html.push(`<div class="toolbar no-print"><button class="btn btn-primary" data-print-all>طباعة كل الأيام</button><span class="badge ${missing?'badge-warn':'badge-ok'}">${missing ? `${missing} معمل يحتاج توزيع إشراف` : 'الإشراف مكتمل للجلسات المطلوبة'}</span><span class="spacer"></span><span class="muted small">الأسماء مختصرة لأول اسمين في الطباعة، والبيانات الكاملة محفوظة في التوزيعات.</span></div>`);
  html.push(`<section class="panel"><div class="panel-body">`);
  for (const day of DAYS) {
    const list=[...(groups.get(day)?.values()||[])].sort((a,b)=>a.startTime.localeCompare(b.startTime)||a.course.localeCompare(b.course,"ar"));
    if (!list.length) continue;
    const maxLanes=Math.max(...list.map(g=>g.labs.length));
    html.push(`<section class="schedule-day" data-day="${esc(day)}"><div class="day-heading"><h2>${esc(day)}</h2><button class="btn btn-small btn-burgundy no-print" data-print-day="${esc(day)}">طباعة ${esc(day)}</button></div><div class="table-wrap"><table class="final-table"><thead><tr><th style="width:11%">الوقت</th><th style="width:20%">المادة / الفرقة</th><th style="width:9%">البيان</th>${Array.from({length:maxLanes},()=>`<th>المعمل</th>`).join("")}</tr></thead><tbody>`);
    for (const g of list) {
      const labs=[...g.labs].sort((a,b)=>a.labNo-b.labNo);
      const assistCells=labs.map(s=>`<td class="lab-assist"><span class="lab-number">(${s.labNo})</span> ${renderLabText(s,"assistant")}</td>`).join("") + Array.from({length:maxLanes-labs.length},()=>`<td class="lab-assist"></td>`).join("");
      const supCells=labs.map(s=>`<td class="lab-super"><span class="lab-number">(${s.labNo})</span> ${renderLabText(s,"faculty")}</td>`).join("") + Array.from({length:maxLanes-labs.length},()=>`<td class="lab-super"></td>`).join("");
      html.push(`<tr><td rowspan="2" class="meta">${fmtTime(g.startTime)}<br>—<br>${fmtTime(g.endTime)}</td><td rowspan="2" class="meta">${esc(g.course)}</td><td class="label-assist">هيئة معاونة</td>${assistCells}</tr>`);
      html.push(`<tr><td class="label-super">الإشراف</td>${supCells}</tr>`);
    }
    html.push(`</tbody></table></div></section>`);
  }
  html.push(`</div></section>`); $("#app").innerHTML=html.join("");
  $$('[data-print-day]').forEach(b=>b.addEventListener('click',()=>printDay(b.dataset.printDay))); $('[data-print-all]')?.addEventListener('click',()=>printDay(null));
}
function printDay(day) { if(day) document.body.dataset.printDay=day; else delete document.body.dataset.printDay; window.print(); setTimeout(()=>delete document.body.dataset.printDay,500); }
window.addEventListener("afterprint",()=>delete document.body.dataset.printDay);

function sessionFilter(s) {
  const q=state.search.trim().toLowerCase(); const c=courseForSession(s);
  return !q || [s.day,sessionCourseName(s),c?.programType,WORKLOAD_LABELS[c?.workloadMode],s.specialty,String(s.labNo),fmtRange(s)].some(x=>String(x||"").toLowerCase().includes(q));
}
function dayOptions(selected) { return DAYS.map(d=>`<option ${d===selected?'selected':''}>${esc(d)}</option>`).join(""); }
function labOptions(selected) { return Array.from({length:7},(_,i)=>i+1).map(n=>`<option value="${n}" ${Number(selected)===n?'selected':''}>${n}</option>`).join(""); }
function courseOptions(selectedId) {
  const all=[...activeCourses()]; const current=state.data.courseCatalog.find(c=>c.id===selectedId); if(current&&!all.some(c=>c.id===current.id)) all.push(current);
  return all.map(c=>`<option value="${esc(c.id)}" ${c.id===selectedId?'selected':''}>${esc(c.name)}${c.code&&c.code!==c.name?` (${esc(c.code)})`:''}</option>`).join("");
}
function assistantSelects(sessionId) {
  const people=[...state.data.assistantPeople].filter(x=>x.active!==false).sort((a,b)=>a.role.localeCompare(b.role,"ar")||a.sortOrder-b.sortOrder); const assigned=assignmentsFor(sessionId,"assistant"); const count=Math.min(5,Math.max(3,assigned.length+1));
  return `<div class="assignments">${Array.from({length:count},(_,i)=>{const pos=i+1,current=assigned.find(a=>a.position===pos)?.personId||"";return `<select class="inline-edit" data-assign="assistant" data-session="${sessionId}" data-position="${pos}" ${canEdit()?'':'disabled'}><option value="">—</option>${people.map(p=>`<option value="${p.id}" ${Number(current)===Number(p.id)?'selected':''}>${esc(personFullName(p))}</option>`).join("")}</select>`;}).join("")}</div>`;
}
function facultySelects(sessionId) {
  const people=[...state.data.faculty].filter(x=>x.active!==false).sort((a,b)=>a.role.localeCompare(b.role,"ar")||personFullName(a).localeCompare(personFullName(b),"ar")); const assigned=assignmentsFor(sessionId,"faculty"); const count=Math.min(10,Math.max(5,assigned.length+1));
  return `<div class="assignments">${Array.from({length:count},(_,i)=>{const pos=i+1,current=assigned.find(a=>a.position===pos)?.facultyId||"";return `<select class="inline-edit" data-assign="faculty" data-session="${sessionId}" data-position="${pos}" ${canEdit()?'':'disabled'}><option value="">—</option>${people.map(p=>`<option value="${p.id}" ${Number(current)===Number(p.id)?'selected':''}>${esc(personFullName(p))} — ${esc(p.specialty||'')}</option>`).join("")}</select>`;}).join("")}</div>`;
}

function renderAssistants() {
  const sessions=sortSessions(state.data.sessions.filter(s=>s.active!==false&&sessionFilter(s))); let lastDay=""; const rows=[];
  for (const s of sessions) {
    if (s.day!==lastDay) { rows.push(`<tr class="day-separator"><td colspan="9">${esc(s.day)}</td></tr>`); lastDay=s.day; }
    rows.push(`<tr data-row-session="${s.id}"><td class="editable-cell"><select class="inline-edit" data-field="day" data-session="${s.id}" ${canEdit()?'':'disabled'}>${dayOptions(s.day)}</select></td><td class="editable-cell"><input class="inline-edit" type="time" value="${esc(s.startTime)}" data-field="startTime" data-session="${s.id}" ${canEdit()?'':'disabled'} /></td><td class="editable-cell"><input class="inline-edit" type="time" value="${esc(s.endTime)}" data-field="endTime" data-session="${s.id}" ${canEdit()?'':'disabled'} /></td><td class="editable-cell"><select class="inline-edit course-select" data-field="courseId" data-session="${s.id}" ${canEdit()?'':'disabled'}>${courseOptions(s.courseId)}</select></td><td><span class="policy-chip ${sessionWorkloadMode(s)}">${esc(coursePolicyLabel(s))}</span></td><td class="editable-cell"><select class="inline-edit" data-field="labNo" data-session="${s.id}" ${canEdit()?'':'disabled'}>${labOptions(s.labNo)}</select></td><td>${assistantSelects(s.id)}</td><td>${s.durationHours.toFixed(1)}</td><td><div class="row-actions"><button class="btn btn-small" data-duplicate="${s.id}" ${canEdit()?'':'disabled'}>نسخ</button><button class="btn btn-small btn-danger" data-delete="${s.id}" ${canEdit()?'':'disabled'}>حذف</button></div></td></tr>`);
  }
  $("#app").innerHTML=`<div class="toolbar"><button class="btn btn-primary" data-add-session ${canEdit()?'':'disabled'}>+ إضافة جلسة / معمل</button><button class="btn" data-go-admin>إدارة المواد والأعضاء</button><input class="inline-edit search" id="tableSearch" placeholder="بحث باليوم أو المادة أو المعمل…" value="${esc(state.search)}"><span class="badge badge-muted">${state.data.sessions.length} صف معمل</span><span class="spacer"></span><span class="muted small">المادة تختار من دليل المقررات؛ تعديل نوعها أو طريقة احتساب ساعاتها يتم من إدارة البيانات.</span></div>${state.mode==='remote'&&!state.user?`<div class="notice warn">أنت في وضع العرض. سجّل الدخول لتفعيل التعديل والحفظ.</div>`:''}<section class="panel"><div class="table-wrap"><table><thead><tr><th>اليوم</th><th>من</th><th>إلى</th><th>المادة / الفرقة</th><th>نوع/حساب الساعات</th><th>المعمل</th><th>أعضاء الهيئة المعاونة</th><th>الساعات</th><th>إجراء</th></tr></thead><tbody>${rows.join("")}</tbody></table></div></section>`;
  bindEditorEvents(); $('[data-add-session]')?.addEventListener('click',addSession); $('[data-go-admin]')?.addEventListener('click',()=>{state.currentView='admin';render();});
  $$('#app [data-delete]').forEach(b=>b.addEventListener('click',()=>deleteSession(b.dataset.delete))); $$('#app [data-duplicate]').forEach(b=>b.addEventListener('click',()=>duplicateSession(b.dataset.duplicate)));
  const search=$('#tableSearch'); search?.addEventListener('input',()=>{state.search=search.value;clearTimeout(search._t);search._t=setTimeout(renderAssistants,180)});
}
function renderSupervision() {
  const sessions=sortSessions(state.data.sessions.filter(s=>s.active!==false&&sessionFilter(s))); let lastDay=""; const rows=[];
  for (const s of sessions) {
    if (s.day!==lastDay) { rows.push(`<tr class="day-separator"><td colspan="9">${esc(s.day)}</td></tr>`); lastDay=s.day; }
    rows.push(`<tr><td>${esc(fmtRange(s))}</td><td>${esc(sessionCourseName(s))}</td><td><span class="policy-chip ${sessionWorkloadMode(s)}">${esc(coursePolicyLabel(s))}</span></td><td>${s.labNo}</td><td class="editable-cell"><input class="inline-edit" value="${esc(s.specialty||'')}" data-field="specialty" data-session="${s.id}" ${canEdit()?'':'disabled'} /></td><td class="editable-cell"><label><input type="checkbox" data-field="supervisionRequired" data-session="${s.id}" ${s.supervisionRequired?'checked':''} ${canEdit()?'':'disabled'}> مطلوب</label></td><td>${s.supervisionRequired?facultySelects(s.id):'<span class="no-supervision">بدون إشراف حسب التعليمات</span>'}</td><td class="editable-cell"><input class="inline-edit" value="${esc(s.notes||'')}" data-field="notes" data-session="${s.id}" ${canEdit()?'':'disabled'} /></td><td>${s.supervisionRequired&&!assignmentsFor(s.id,'faculty').length?'<span class="badge badge-danger">يحتاج توزيع</span>':'<span class="badge badge-ok">مكتمل/غير مطلوب</span>'}</td></tr>`);
  }
  const missing=state.data.sessions.filter(s=>s.active!==false&&s.supervisionRequired&&!assignmentsFor(s.id,'faculty').length).length;
  $("#app").innerHTML=`<div class="toolbar"><input class="inline-edit search" id="tableSearch" placeholder="بحث في الإشراف…" value="${esc(state.search)}"><span class="badge ${missing?'badge-warn':'badge-ok'}">${missing} يحتاج توزيع إشراف</span><span class="spacer"></span><span class="muted small">نوع البرنامج وطريقة احتساب الساعات موحّدان للمقرر من إدارة البيانات.</span></div>${state.mode==='remote'&&!state.user?`<div class="notice warn">سجّل الدخول لتعديل الإشراف وحفظه.</div>`:''}<section class="panel"><div class="table-wrap"><table><thead><tr><th>الوقت</th><th>المادة / الفرقة</th><th>نوع/حساب الساعات</th><th>المعمل</th><th>التخصص</th><th>الإشراف</th><th>المشرفون</th><th>ملاحظات</th><th>الحالة</th></tr></thead><tbody>${rows.join("")}</tbody></table></div></section>`;
  bindEditorEvents(); const search=$('#tableSearch'); search?.addEventListener('input',()=>{state.search=search.value;clearTimeout(search._t);search._t=setTimeout(renderSupervision,180)});
}
function bindEditorEvents() {
  $$('#app [data-field]').forEach(el=>el.addEventListener('change',()=>{
    const s=state.data.sessions.find(x=>x.id===el.dataset.session); if(!s)return; const f=el.dataset.field; let v=el.type==='checkbox'?el.checked:el.value;
    if (f==='labNo') v=Number(v);
    if (f==='courseId') {
      s.courseId=v; const c=courseMap().get(v); if(c){s.course=c.name;s.specialty=c.specialty||s.specialty;s.supervisionRequired=c.supervisionRequiredDefault!==false;} 
    } else { s[f]=v; }
    if (f==='day') s.dayOrder=DAYS.indexOf(v)+1;
    if (f==='startTime'||f==='endTime') s.durationHours=calcDuration(s.startTime,s.endTime);
    if (f==='supervisionRequired'&&!v) state.data.supervisorAssignments=state.data.supervisorAssignments.filter(a=>a.sessionId!==s.id);
    markDirty(s.id); render();
  }));
  $$('#app [data-assign]').forEach(el=>el.addEventListener('change',()=>{
    const type=el.dataset.assign,sid=el.dataset.session,pos=Number(el.dataset.position),val=Number(el.value)||null;
    if(type==='assistant'){
      state.data.assistantAssignments=state.data.assistantAssignments.filter(a=>!(a.sessionId===sid&&a.position===pos));
      if(val){state.data.assistantAssignments=state.data.assistantAssignments.filter(a=>!(a.sessionId===sid&&Number(a.personId)===val));state.data.assistantAssignments.push({sessionId:sid,personId:val,position:pos});}
    }else{
      state.data.supervisorAssignments=state.data.supervisorAssignments.filter(a=>!(a.sessionId===sid&&a.position===pos));
      if(val){state.data.supervisorAssignments=state.data.supervisorAssignments.filter(a=>!(a.sessionId===sid&&Number(a.facultyId)===val));state.data.supervisorAssignments.push({sessionId:sid,facultyId:val,position:pos});}
    }
    markDirty(sid); render();
  }));
}
function addSession() {
  const c=activeCourses()[0]; if(!c){alert("أضف مادة أولاً من إدارة البيانات.");state.currentView='admin';render();return;}
  const id=uid("web"); state.data.sessions.push({id,sourceRow:null,day:"السبت",dayOrder:1,startTime:"08:00",endTime:"10:00",durationHours:2,courseId:c.id,course:c.name,specialty:c.specialty||"",labNo:1,supervisionRequired:c.supervisionRequiredDefault!==false,notes:"",active:true}); markDirty(id); renderAssistants();
}
function duplicateSession(id) {
  const src=state.data.sessions.find(x=>x.id===id);if(!src)return;const nid=uid("web");state.data.sessions.push({...clone(src),id:nid,sourceRow:null,labNo:Math.min(7,Number(src.labNo)+1)});
  for(const a of assignmentsFor(id,"assistant"))state.data.assistantAssignments.push({...a,sessionId:nid});for(const a of assignmentsFor(id,"faculty"))state.data.supervisorAssignments.push({...a,sessionId:nid});markDirty(nid);renderAssistants();
}
function deleteSessionInternal(id) {
  state.data.sessions=state.data.sessions.filter(x=>x.id!==id);state.data.assistantAssignments=state.data.assistantAssignments.filter(x=>x.sessionId!==id);state.data.supervisorAssignments=state.data.supervisorAssignments.filter(x=>x.sessionId!==id);if(state.remoteSessionIds.has(id))state.deletedSessionIds.add(id);state.dirtySessions.delete(id);state.dirty=true;
}
function deleteSession(id) {
  const s=state.data.sessions.find(x=>x.id===id);if(!s)return;if(!confirm(`حذف ${s.day} — ${sessionCourseName(s)} — معمل ${s.labNo}؟`))return;deleteSessionInternal(id);updateBadges();scheduleAutoSave();renderAssistants();
}

function workload(type) {
  const sMap=sessionMap(); const persons=type==='assistant'?state.data.assistantPeople:state.data.faculty; const assigns=type==='assistant'?state.data.assistantAssignments:state.data.supervisorAssignments;
  return persons.filter(p=>p.active!==false).map(p=>{
    const mine=assigns.filter(a=>Number(type==='assistant'?a.personId:a.facultyId)===Number(p.id)); let counted=0,extra=0,excluded=0;
    for(const a of mine){const s=sMap.get(a.sessionId);if(!s)continue;const h=Number(s.durationHours)||0;const mode=sessionWorkloadMode(s);if(mode==='extra')extra+=h;else if(mode==='excluded')excluded+=h;else counted+=h;}
    counted=Math.round(counted*100)/100;extra=Math.round(extra*100)/100;excluded=Math.round(excluded*100)/100;const target=effectiveTarget(p,type);const diff=Math.round((counted-target)*100)/100;
    return {...p,targetHoursEffective:target,countedHours:counted,extraHours:extra,excludedHours:excluded,totalHours:Math.round((counted+extra)*100)/100,count:mine.length,diff};
  });
}
function statusFor(w){if(Math.abs(w.diff)<0.01)return['مطابق','status-good'];return w.diff>0?['زائد داخل النصاب','status-over']:['ناقص','status-under'];}
function renderMembers() {
  const type=state.selectedPersonType;const rows=workload(type).sort((a,b)=>a.role.localeCompare(b.role,"ar")||personFullName(a).localeCompare(personFullName(b),"ar"));if(!state.selectedPersonId&&rows.length)state.selectedPersonId=rows[0].id;const p=rows.find(x=>Number(x.id)===Number(state.selectedPersonId));const detail=p?renderPersonDetail(p,type):'';
  $("#app").innerHTML=`<div class="toolbar"><button class="btn ${type==='assistant'?'btn-primary':''}" data-person-type="assistant">الهيئة المعاونة</button><button class="btn ${type==='faculty'?'btn-primary':''}" data-person-type="faculty">هيئة الإشراف</button><button class="btn" data-open-admin>إدارة الأعضاء والنصاب</button><span class="spacer"></span><span class="muted small">الفرق يُحسب من الساعات المصنفة «داخل النصاب» فقط؛ ساعات البرامج الخاصة المصنفة «إضافية» تظهر منفصلة.</span></div><div class="split"><section class="panel"><div class="panel-head"><h3>ملخص الساعات</h3></div><div class="table-wrap"><table><thead><tr><th>الاسم</th><th>الدرجة</th><th>المستهدف</th><th>داخل النصاب</th><th>إضافي</th><th>الإجمالي</th><th>الفرق</th><th>التكليفات</th><th>الحالة</th></tr></thead><tbody>${rows.map(w=>{const st=statusFor(w);return `<tr class="person-row" data-person-id="${w.id}"><td>${esc(personFullName(w))}</td><td>${esc(w.role)}</td><td>${w.targetHoursEffective}</td><td>${w.countedHours}</td><td class="hours-extra">${w.extraHours}</td><td>${w.totalHours}</td><td>${w.diff>0?'+':''}${w.diff}</td><td>${w.count}</td><td class="${st[1]}">${st[0]}</td></tr>`}).join('')}</tbody></table></div></section>${detail}</div>`;
  $$('[data-person-type]').forEach(b=>b.addEventListener('click',()=>{state.selectedPersonType=b.dataset.personType;state.selectedPersonId=null;renderMembers()}));$$('.person-row').forEach(r=>r.addEventListener('click',()=>{state.selectedPersonId=Number(r.dataset.personId);renderMembers()}));$('[data-open-admin]')?.addEventListener('click',()=>{state.currentView='admin';state.adminPersonType=type;render();});
}
function renderPersonDetail(person,type) {
  const assigns=(type==='assistant'?state.data.assistantAssignments:state.data.supervisorAssignments).filter(a=>Number(type==='assistant'?a.personId:a.facultyId)===Number(person.id));const sm=sessionMap();const items=assigns.map(a=>sm.get(a.sessionId)).filter(Boolean).sort((a,b)=>a.dayOrder-b.dayOrder||a.startTime.localeCompare(b.startTime));
  return `<section class="panel person-detail"><div class="panel-head"><h3>${esc(personFullName(person))}</h3><div class="toolbar"><span class="badge badge-muted">المستهدف ${person.targetHoursEffective}</span><span class="badge badge-ok">داخل النصاب ${person.countedHours}</span><span class="badge badge-extra">إضافي ${person.extraHours}</span></div></div><div class="panel-body">${items.length?`<div class="table-wrap"><table><thead><tr><th>اليوم</th><th>الوقت</th><th>المادة</th><th>نوع البرنامج</th><th>احتساب الساعات</th><th>المعمل</th><th>الساعات</th></tr></thead><tbody>${items.map(s=>`<tr><td>${esc(s.day)}</td><td>${esc(fmtRange(s))}</td><td>${esc(sessionCourseName(s))}</td><td>${esc(sessionProgramType(s))}</td><td>${esc(WORKLOAD_LABELS[sessionWorkloadMode(s)]||'داخل النصاب')}</td><td>${s.labNo}</td><td>${s.durationHours}</td></tr>`).join('')}</tbody></table></div>`:'<div class="empty">لا توجد تكليفات حالية.</div>'}</div></section>`;
}

function overlaps(a,b){return a.day===b.day&&toMinutes(a.startTime)<toMinutes(b.endTime)&&toMinutes(b.startTime)<toMinutes(a.endTime);}
function computeConflicts(type){const sm=sessionMap(),people=type==='assistant'?assistantMap():facultyMap(),assigns=type==='assistant'?state.data.assistantAssignments:state.data.supervisorAssignments,pidKey=type==='assistant'?'personId':'facultyId',grouped=new Map(),out=[];for(const a of assigns){const id=Number(a[pidKey]);if(!grouped.has(id))grouped.set(id,[]);grouped.get(id).push(sm.get(a.sessionId));}for(const[pid,list0]of grouped){const list=list0.filter(Boolean);for(let i=0;i<list.length;i++)for(let j=i+1;j<list.length;j++){const a=list[i],b=list[j];if(a.id!==b.id&&overlaps(a,b))out.push({type,person:people.get(pid),a,b});}}return out;}
function renderConflicts(){const a=computeConflicts('assistant'),f=computeConflicts('faculty'),all=[...a,...f];$("#app").innerHTML=`<div class="grid-cards"><div class="kpi"><div class="value">${a.length}</div><div class="label">تعارضات الهيئة المعاونة</div></div><div class="kpi"><div class="value">${f.length}</div><div class="label">تعارضات الإشراف</div></div><div class="kpi"><div class="value">${state.data.sessions.filter(s=>s.supervisionRequired&&!assignmentsFor(s.id,'faculty').length).length}</div><div class="label">معامل تحتاج إشراف</div></div></div><section class="panel"><div class="panel-head"><h2>التعارضات الزمنية</h2></div><div class="panel-body">${all.length?`<div class="table-wrap"><table><thead><tr><th>النوع</th><th>الاسم</th><th>اليوم</th><th>التكليف الأول</th><th>التكليف الثاني</th></tr></thead><tbody>${all.map(c=>`<tr><td>${c.type==='assistant'?'هيئة معاونة':'إشراف'}</td><td>${esc(personFullName(c.person))}</td><td>${esc(c.a.day)}</td><td>${esc(fmtRange(c.a))} — ${esc(sessionCourseName(c.a))} — معمل ${c.a.labNo}</td><td>${esc(fmtRange(c.b))} — ${esc(sessionCourseName(c.b))} — معمل ${c.b.labNo}</td></tr>`).join('')}</tbody></table></div>`:'<div class="notice">لا توجد تعارضات زمنية محسوبة في التوزيع الحالي.</div>'}</div></section>`;}

function roleOptions(type,selected){return state.data.roleTargets.filter(x=>x.personType===type&&x.active!==false).sort((a,b)=>a.role.localeCompare(b.role,"ar")).map(x=>`<option value="${esc(x.role)}" ${x.role===selected?'selected':''}>${esc(x.role)} — ${x.targetHours} س</option>`).join('');}
function renderAdmin() {
  const rts=[...state.data.roleTargets].sort((a,b)=>a.personType.localeCompare(b.personType)||a.role.localeCompare(b.role,"ar"));
  const courses=[...state.data.courseCatalog].sort((a,b)=>a.name.localeCompare(b.name,"ar"));
  const type=state.adminPersonType; const people=(type==='assistant'?state.data.assistantPeople:state.data.faculty).filter(p=>p.active!==false).sort((a,b)=>a.role.localeCompare(b.role,"ar")||personFullName(a).localeCompare(personFullName(b),"ar"));
  const roleRows=rts.map(x=>{const n=(x.personType==='assistant'?state.data.assistantPeople:state.data.faculty).filter(p=>p.active!==false&&p.role===x.role).length;return `<tr><td>${x.personType==='assistant'?'هيئة معاونة':'هيئة تدريس'}</td><td>${esc(x.role)}</td><td class="editable-cell"><input class="inline-edit narrow" type="number" min="0" step="0.5" value="${x.targetHours}" data-role-hours="${esc(x.id)}" ${canEdit()?'':'disabled'}></td><td>${n}</td><td><button class="btn btn-small btn-danger" data-delete-role="${esc(x.id)}" ${canEdit()?'':'disabled'}>حذف الدرجة</button></td></tr>`;}).join('');
  const courseRows=courses.map(c=>{const used=state.data.sessions.filter(s=>s.courseId===c.id||( !s.courseId&&s.course===c.name)).length;return `<tr data-course-row="${esc(c.id)}"><td class="editable-cell"><input class="inline-edit" value="${esc(c.name)}" data-course-field="name" data-course-id="${esc(c.id)}" ${canEdit()?'':'disabled'}></td><td class="editable-cell"><input class="inline-edit narrow" value="${esc(c.code||'')}" data-course-field="code" data-course-id="${esc(c.id)}" ${canEdit()?'':'disabled'}></td><td class="editable-cell"><select class="inline-edit" data-course-field="programType" data-course-id="${esc(c.id)}" ${canEdit()?'':'disabled'}>${PROGRAM_TYPES.map(v=>`<option ${v===c.programType?'selected':''}>${v}</option>`).join('')}</select></td><td class="editable-cell"><select class="inline-edit" data-course-field="workloadMode" data-course-id="${esc(c.id)}" ${canEdit()?'':'disabled'}><option value="target" ${c.workloadMode==='target'?'selected':''}>داخل النصاب</option><option value="extra" ${c.workloadMode==='extra'?'selected':''}>ساعات إضافية</option><option value="excluded" ${c.workloadMode==='excluded'?'selected':''}>لا تُحسب</option></select></td><td class="editable-cell"><input class="inline-edit" value="${esc(c.specialty||'')}" data-course-field="specialty" data-course-id="${esc(c.id)}" ${canEdit()?'':'disabled'}></td><td class="editable-cell"><label><input type="checkbox" data-course-field="supervisionRequiredDefault" data-course-id="${esc(c.id)}" ${c.supervisionRequiredDefault?'checked':''} ${canEdit()?'':'disabled'}> مطلوب</label></td><td>${used}</td><td><button class="btn btn-small btn-danger" data-delete-course="${esc(c.id)}" ${canEdit()?'':'disabled'}>حذف المادة</button></td></tr>`;}).join('');
  const memberRows=people.map(p=>`<tr><td class="editable-cell"><input class="inline-edit" value="${esc(stripTitle(p.name))}" data-member-field="name" data-member-id="${p.id}" data-member-type="${type}" ${canEdit()?'':'disabled'}></td><td class="editable-cell"><input class="inline-edit narrow" value="${esc(p.title||'')}" data-member-field="title" data-member-id="${p.id}" data-member-type="${type}" ${canEdit()?'':'disabled'}></td><td class="editable-cell"><select class="inline-edit" data-member-field="role" data-member-id="${p.id}" data-member-type="${type}" ${canEdit()?'':'disabled'}>${roleOptions(type,p.role)}</select></td>${type==='faculty'?`<td class="editable-cell"><input class="inline-edit" value="${esc(p.status||'')}" data-member-field="status" data-member-id="${p.id}" data-member-type="faculty" ${canEdit()?'':'disabled'}></td><td class="editable-cell"><input class="inline-edit" value="${esc(p.specialty||'')}" data-member-field="specialty" data-member-id="${p.id}" data-member-type="faculty" ${canEdit()?'':'disabled'}></td>`:''}<td class="editable-cell"><input class="inline-edit narrow" type="number" min="0" step="0.5" placeholder="تلقائي" value="${p.targetOverride??''}" data-member-field="targetOverride" data-member-id="${p.id}" data-member-type="${type}" ${canEdit()?'':'disabled'}></td><td>${effectiveTarget(p,type)}</td><td><button class="btn btn-small btn-danger" data-delete-member="${p.id}" data-member-type="${type}" ${canEdit()?'':'disabled'}>حذف</button></td></tr>`).join('');
  $("#app").innerHTML=`
  <div class="notice"><b>طريقة الحساب:</b> حدّد النصاب لكل درجة مرة واحدة. كل مقرر يمكن ضبطه «داخل النصاب» أو «ساعات إضافية» أو «لا يُحسب». تغيير التصنيف ينعكس فورًا على تقارير الساعات بدون تغيير التوزيع.</div>
  <section class="panel"><div class="panel-head"><h2>1) النصاب المستهدف حسب الدرجة العلمية</h2></div><div class="panel-body"><form id="addRoleForm" class="admin-form"><select id="newRoleType" class="inline-edit"><option value="assistant">هيئة معاونة</option><option value="faculty">هيئة تدريس / إشراف</option></select><input id="newRoleName" class="inline-edit" placeholder="اسم الدرجة العلمية" required><input id="newRoleHours" class="inline-edit narrow" type="number" min="0" step="0.5" placeholder="الساعات" required><button class="btn btn-primary" ${canEdit()?'':'disabled'}>+ إضافة درجة</button></form><div class="table-wrap"><table><thead><tr><th>الفئة</th><th>الدرجة</th><th>النصاب المستهدف</th><th>عدد الأعضاء</th><th>إجراء</th></tr></thead><tbody>${roleRows}</tbody></table></div></div></section>
  <section class="panel"><div class="panel-head"><h2>2) إدارة المواد ونوع البرنامج واحتساب الساعات</h2></div><div class="panel-body"><form id="addCourseForm" class="admin-form course-form"><input id="newCourseName" class="inline-edit" placeholder="اسم المادة / الفرقة" required><input id="newCourseCode" class="inline-edit" placeholder="الكود - اختياري"><select id="newCourseType" class="inline-edit">${PROGRAM_TYPES.map(v=>`<option>${v}</option>`).join('')}</select><select id="newCourseMode" class="inline-edit"><option value="target">داخل النصاب</option><option value="extra">ساعات إضافية</option><option value="excluded">لا تُحسب</option></select><input id="newCourseSpecialty" class="inline-edit" placeholder="التخصص - اختياري"><label class="check-box"><input id="newCourseSupervision" type="checkbox" checked> إشراف مطلوب افتراضيًا</label><button class="btn btn-primary" ${canEdit()?'':'disabled'}>+ إضافة مادة</button></form><div class="table-wrap"><table><thead><tr><th>المادة</th><th>الكود</th><th>البرنامج</th><th>احتساب الساعات</th><th>التخصص</th><th>الإشراف الافتراضي</th><th>جلسات حالية</th><th>إجراء</th></tr></thead><tbody>${courseRows}</tbody></table></div></div></section>
  <section class="panel"><div class="panel-head"><h2>3) إدارة الأعضاء</h2><div class="toolbar"><button class="btn ${type==='assistant'?'btn-primary':''}" data-admin-type="assistant">الهيئة المعاونة</button><button class="btn ${type==='faculty'?'btn-primary':''}" data-admin-type="faculty">هيئة التدريس</button></div></div><div class="panel-body"><form id="addMemberForm" class="admin-form"><input id="newMemberName" class="inline-edit" placeholder="الاسم الكامل بدون اللقب" required><input id="newMemberTitle" class="inline-edit narrow" placeholder="اللقب مثل د. / أ.د."><select id="newMemberRole" class="inline-edit" required><option value="">اختر الدرجة</option>${roleOptions(type,'')}</select>${type==='faculty'?'<input id="newMemberStatus" class="inline-edit" placeholder="الحالة: عامل / متفرغ"><input id="newMemberSpecialty" class="inline-edit" placeholder="التخصص">':''}<input id="newMemberOverride" class="inline-edit narrow" type="number" min="0" step="0.5" placeholder="نصاب خاص - اختياري"><button class="btn btn-primary" ${canEdit()?'':'disabled'}>+ إضافة عضو</button></form><div class="table-wrap"><table><thead><tr><th>الاسم</th><th>اللقب</th><th>الدرجة</th>${type==='faculty'?'<th>الحالة</th><th>التخصص</th>':''}<th>نصاب خاص</th><th>النصاب الفعلي</th><th>إجراء</th></tr></thead><tbody>${memberRows}</tbody></table></div></div></section>`;
  bindAdminEvents();
}
function bindAdminEvents(){
  $$('[data-role-hours]').forEach(el=>el.addEventListener('change',()=>{const x=state.data.roleTargets.find(r=>r.id===el.dataset.roleHours);if(!x)return;x.targetHours=Math.max(0,Number(el.value)||0);markDirty();renderAdmin();}));
  $$('[data-delete-role]').forEach(b=>b.addEventListener('click',()=>deleteRoleTarget(b.dataset.deleteRole)));
  $('#addRoleForm')?.addEventListener('submit',e=>{e.preventDefault();if(!canEdit())return;const personType=$('#newRoleType').value,role=$('#newRoleName').value.trim(),targetHours=Math.max(0,Number($('#newRoleHours').value)||0);if(!role)return;if(state.data.roleTargets.some(x=>x.personType===personType&&x.role===role))return alert('هذه الدرجة موجودة بالفعل.');state.data.roleTargets.push({id:`${personType}:${role}`,personType,role,targetHours,active:true});markDirty();renderAdmin();});
  $$('[data-course-field]').forEach(el=>el.addEventListener('change',()=>editCourseField(el)));
  $$('[data-delete-course]').forEach(b=>b.addEventListener('click',()=>deleteCourse(b.dataset.deleteCourse)));
  $('#addCourseForm')?.addEventListener('submit',e=>{e.preventDefault();addCourseFromForm();});
  $$('[data-admin-type]').forEach(b=>b.addEventListener('click',()=>{state.adminPersonType=b.dataset.adminType;renderAdmin();}));
  $$('[data-member-field]').forEach(el=>el.addEventListener('change',()=>editMemberField(el)));
  $$('[data-delete-member]').forEach(b=>b.addEventListener('click',()=>deleteMember(b.dataset.memberType,Number(b.dataset.deleteMember))));
  $('#addMemberForm')?.addEventListener('submit',e=>{e.preventDefault();addMemberFromForm();});
}
function deleteRoleTarget(id){const x=state.data.roleTargets.find(r=>r.id===id);if(!x)return;const used=(x.personType==='assistant'?state.data.assistantPeople:state.data.faculty).some(p=>p.active!==false&&p.role===x.role);if(used)return alert('لا يمكن حذف الدرجة لأنها مستخدمة بواسطة أعضاء حاليين. غيّر درجاتهم أولاً.');if(!confirm(`حذف درجة «${x.role}»؟`))return;state.data.roleTargets=state.data.roleTargets.filter(r=>r.id!==id);state.deletedRoleTargets.add(id);markDirty();renderAdmin();}
function editCourseField(el){const c=state.data.courseCatalog.find(x=>x.id===el.dataset.courseId);if(!c)return;const f=el.dataset.courseField;let v=el.type==='checkbox'?el.checked:el.value;if(f==='name'){v=v.trim();if(!v)return alert('اسم المادة لا يمكن أن يكون فارغاً.');if(state.data.courseCatalog.some(x=>x.id!==c.id&&x.name===v))return alert('يوجد مقرر آخر بنفس الاسم.');c.name=v;for(const s of state.data.sessions.filter(s=>s.courseId===c.id)){s.course=v;markDirty(s.id);}}else c[f]=v;markDirty();renderAdmin();}
function addCourseFromForm(){if(!canEdit())return;const name=$('#newCourseName').value.trim();if(!name)return;if(state.data.courseCatalog.some(c=>c.name===name))return alert('المادة موجودة بالفعل.');const c={id:uid('course'),name,code:$('#newCourseCode').value.trim(),programType:$('#newCourseType').value,workloadMode:$('#newCourseMode').value,specialty:$('#newCourseSpecialty').value.trim(),supervisionRequiredDefault:$('#newCourseSupervision').checked,active:true,notes:''};state.data.courseCatalog.push(c);markDirty();renderAdmin();}
function deleteCourse(id){const c=state.data.courseCatalog.find(x=>x.id===id);if(!c)return;const ss=state.data.sessions.filter(s=>s.courseId===id||(!s.courseId&&s.course===c.name));const msg=ss.length?`المادة «${c.name}» مستخدمة في ${ss.length} صف/معمل. الحذف سيزيل هذه الجلسات وكل تكليفاتها. هل تريد المتابعة؟`:`حذف المادة «${c.name}»؟`;if(!confirm(msg))return;ss.forEach(s=>deleteSessionInternal(s.id));state.data.courseCatalog=state.data.courseCatalog.filter(x=>x.id!==id);state.deletedCourseIds.add(id);markDirty();renderAdmin();}
function editMemberField(el){const type=el.dataset.memberType,id=Number(el.dataset.memberId),arr=type==='assistant'?state.data.assistantPeople:state.data.faculty,p=arr.find(x=>Number(x.id)===id);if(!p)return;const f=el.dataset.memberField;let v=el.value;if(f==='targetOverride')v=v===''?null:Math.max(0,Number(v)||0);else if(f==='name'){v=v.trim();if(!v)return alert('الاسم مطلوب.');}p[f]=v;if(type==='assistant')p.displayName=personFullName(p);markDirty();renderAdmin();}
function nextPersonId(arr){return Math.max(0,...arr.map(x=>Number(x.id)||0))+1;}
function addMemberFromForm(){if(!canEdit())return;const type=state.adminPersonType,name=$('#newMemberName').value.trim(),title=$('#newMemberTitle').value.trim(),role=$('#newMemberRole').value;if(!name||!role)return alert('أدخل الاسم واختر الدرجة العلمية.');const override=$('#newMemberOverride').value===''?null:Math.max(0,Number($('#newMemberOverride').value)||0);if(type==='assistant'){const id=nextPersonId(state.data.assistantPeople);const sortOrder=Math.max(0,...state.data.assistantPeople.filter(p=>p.role===role).map(p=>Number(p.sortOrder)||0))+1;state.data.assistantPeople.push({id,name,displayName:`${title} ${name}`.trim(),title,role,sortOrder,targetHours:roleTarget(type,role)?.targetHours||0,targetOverride:override,active:true});}else{const id=nextPersonId(state.data.faculty);state.data.faculty.push({id,name,title,role,status:$('#newMemberStatus')?.value.trim()||'',specialty:$('#newMemberSpecialty')?.value.trim()||'',targetHours:roleTarget(type,role)?.targetHours||0,targetOverride:override,active:true});}markDirty();renderAdmin();}
function deleteMember(type,id){const arr=type==='assistant'?state.data.assistantPeople:state.data.faculty,p=arr.find(x=>Number(x.id)===id);if(!p)return;const assigns=(type==='assistant'?state.data.assistantAssignments:state.data.supervisorAssignments).filter(a=>Number(type==='assistant'?a.personId:a.facultyId)===id);if(!confirm(`حذف «${personFullName(p)}»؟${assigns.length?` لديه ${assigns.length} تكليف وسيتم إزالته منها.`:''}`))return;for(const a of assigns)markDirty(a.sessionId);if(type==='assistant'){state.data.assistantAssignments=state.data.assistantAssignments.filter(a=>Number(a.personId)!==id);state.data.assistantPeople=state.data.assistantPeople.filter(x=>Number(x.id)!==id);state.deletedAssistantIds.add(id);}else{state.data.supervisorAssignments=state.data.supervisorAssignments.filter(a=>Number(a.facultyId)!==id);state.data.faculty=state.data.faculty.filter(x=>Number(x.id)!==id);state.deletedFacultyIds.add(id);}markDirty();renderAdmin();}

async function renderHistory(){if(state.mode!=="remote"){$("#app").innerHTML=`<div class="notice">سجل التعديلات المركزي متاح عند ربط الموقع بـ Supabase. في الوضع المحلي تُحفظ البيانات داخل المتصفح فقط.</div>`;return;}if(!state.user){$("#app").innerHTML=`<div class="notice warn">سجّل الدخول لعرض سجل التعديلات.</div>`;return;}$("#app").innerHTML=`<div class="empty">جاري تحميل سجل التعديلات…</div>`;const{data,error}=await state.supabase.from('change_log').select('*').order('changed_at',{ascending:false}).limit(200);if(error){$("#app").innerHTML=`<div class="notice danger">${esc(error.message)}</div>`;return;}$("#app").innerHTML=`<section class="panel"><div class="panel-head"><h2>آخر التعديلات</h2><span class="badge badge-muted">${data.length}</span></div><div class="table-wrap"><table><thead><tr><th>الوقت</th><th>المستخدم</th><th>الجدول</th><th>العملية</th><th>المفتاح</th></tr></thead><tbody>${data.map(x=>`<tr><td>${new Date(x.changed_at).toLocaleString('ar-EG')}</td><td>${esc(x.changed_by||'')}</td><td>${esc(x.table_name)}</td><td>${esc(x.action)}</td><td>${esc(x.row_key||'')}</td></tr>`).join('')}</tbody></table></div></section>`;}
function renderSettings(){const remoteEmpty=state.mode==='remote'&&!state.remoteSessionIds.size;$("#app").innerHTML=`<div class="settings-grid"><div class="settings-card"><h3>حالة النظام</h3><p><b>الوضع:</b> ${state.mode==='remote'?'Supabase — حفظ مشترك':'محلي — LocalStorage'}</p><p><b>المستخدم:</b> ${state.user?esc(state.user.email||'مسؤول'):'غير مسجل'}</p><p><b>مصدر البيانات:</b> ${esc(state.data.meta?.sourceUpdate||'')}</p>${remoteEmpty?'<div class="notice warn">قاعدة البيانات متصلة لكنها فارغة. بعد تسجيل الدخول استخدم زر تحميل البيانات الأولية.</div>':''}<button class="btn btn-primary" data-seed-remote ${state.mode==='remote'&&state.user?'':'disabled'}>تحميل البيانات الأولية إلى Supabase</button></div><div class="settings-card"><h3>نسخة احتياطية</h3><p class="muted">النسخة تشمل المواعيد والتوزيعات والأعضاء والمواد وقواعد النصاب.</p><div class="toolbar"><button class="btn" data-export-backup>تنزيل Backup JSON</button><button class="btn" data-import-backup ${canEdit()?'':'disabled'}>استيراد Backup</button></div></div><div class="settings-card"><h3>إعادة الضبط</h3><p class="muted">في الوضع المحلي فقط: استعادة بيانات البداية المدمجة وحذف التعديلات المحلية.</p><button class="btn btn-danger" data-reset-local ${state.mode==='local'?'':'disabled'}>استعادة النسخة الأساسية</button></div><div class="settings-card"><h3>البيانات الحالية</h3><p>مواد: <b>${state.data.courseCatalog.length}</b></p><p>درجات/قواعد نصاب: <b>${state.data.roleTargets.length}</b></p><p>جلسات/معامل: <b>${state.data.sessions.length}</b></p><p>أعضاء هيئة معاونة: <b>${state.data.assistantPeople.length}</b></p><p>أعضاء هيئة إشراف: <b>${state.data.faculty.length}</b></p></div><div class="settings-card"><h3>ترقية قاعدة البيانات</h3><p class="muted">إذا كنت تستخدم نسخة Supabase القديمة، شغّل الملف <span class="code">supabase/migration_v2.sql</span> مرة واحدة قبل استخدام إدارة المواد والنصاب.</p></div></div>`;$('[data-seed-remote]')?.addEventListener('click',seedRemote);$('[data-export-backup]')?.addEventListener('click',exportBackup);$('[data-import-backup]')?.addEventListener('click',()=>$('#backupFile').click());$('[data-reset-local]')?.addEventListener('click',()=>{if(confirm('استعادة البيانات الأساسية وحذف التعديلات المحلية؟')){state.data=clone(SEED_DATA);normalizeState();localStorage.removeItem(LOCAL_KEY);clearDirty();render();}});}
function exportBackup(){const blob=new Blob([JSON.stringify(state.data,null,2)],{type:'application/json;charset=utf-8'});const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=`zoology-schedule-backup-${new Date().toISOString().slice(0,10)}.json`;a.click();URL.revokeObjectURL(a.href);}
async function importBackup(file){if(!file||!canEdit())return;try{const data=JSON.parse(await file.text());if(!Array.isArray(data.sessions)||!Array.isArray(data.assistantAssignments)||!Array.isArray(data.supervisorAssignments))throw new Error('صيغة النسخة غير صحيحة');const oldIds=new Set(state.data.sessions.map(x=>x.id));state.data=data;normalizeState();const newIds=new Set(state.data.sessions.map(x=>x.id));for(const id of oldIds)if(!newIds.has(id)&&state.remoteSessionIds.has(id))state.deletedSessionIds.add(id);state.dirtySessions=new Set(state.data.sessions.map(x=>x.id));state.dirty=true;updateBadges();scheduleAutoSave();render();toast('تم استيراد النسخة. اضغط حفظ أو انتظر الحفظ التلقائي.');}catch(err){alert(err.message||err);}}
function openLogin(){$('#loginMessage').textContent='';$('#loginDialog').showModal();}
async function login(email,password){if(!state.supabase)return $('#loginMessage').textContent='Supabase غير مفعّل في config.js.';const{error}=await state.supabase.auth.signInWithPassword({email,password});if(error)$('#loginMessage').textContent=error.message;else $('#loginDialog').close();}
async function loginOrLogout(){if(state.mode==='remote'&&state.user){if(confirm('تسجيل الخروج؟'))await state.supabase.auth.signOut();}else openLogin();}
function bindGlobal(){$$('.tab').forEach(b=>b.addEventListener('click',()=>{state.currentView=b.dataset.view;state.search='';render();}));$('#saveBtn').addEventListener('click',()=>saveAll(false));$('#loginBtn').addEventListener('click',loginOrLogout);$$('[data-close-dialog]').forEach(b=>b.addEventListener('click',()=>$('#loginDialog').close()));$('#loginForm').addEventListener('submit',e=>{e.preventDefault();login($('#loginEmail').value,$('#loginPassword').value)});$('#backupFile').addEventListener('change',e=>{importBackup(e.target.files?.[0]);e.target.value='';});window.addEventListener('beforeunload',e=>{if(state.dirty){e.preventDefault();e.returnValue='';}});if('serviceWorker'in navigator&&location.protocol.startsWith('http'))navigator.serviceWorker.register('./sw.js').catch(console.warn);}
async function start(){bindGlobal();const remote=await initSupabase();if(!remote)loadLocalOrSeed();normalizeState();$('#appTitle').textContent=state.data.meta?.appName||SEED_DATA.meta.appName;$('#appSubtitle').textContent=`${state.data.meta?.faculty||SEED_DATA.meta.faculty} — ${state.data.meta?.semester||SEED_DATA.meta.semester}`;render();}
start();
