import "./style.css";
import { BedPlayer, Recorder, unlockAudio } from "./audio";
import { handleRedirect, isLoggedIn, login } from "./auth";
import { Show, TYPE_LABELS } from "./show";
import { tryDuck } from "./spotifyBed";
import { assignSongs, autoSongsUsed } from "./songs";
import { fromNowPlaying, fromPlaylist } from "./songSource";
import * as sp from "./spotify";
import * as store from "./storage";
import type { BedChoice, BedId, Block, BlockType, SongSource, Track } from "./types";
import { BUILD_ID, watchForUpdates } from "./update";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const show = (el: HTMLElement, on: boolean) => el.classList.toggle("hidden", !on);

// ====================== STATE ======================
let blocks: Block[] = store.loadBlocks();
let source: SongSource | null = store.loadSource();
let bedChoice: BedChoice = store.loadBed();
let bedTrack: Track | null = store.loadBedTrack();
let loopEnabled = store.loadLoop();
let deviceId: string | null = null;
let current: Show | null = null;
let resumeFrom: number | null = null; // set when a show was stopped part-way and can be resumed
let resumeTracks: Map<string, Track[]> | null = null;
let nextId = Date.now();
const makeId = () => "b" + nextId++;

// The song picked as talk-over music is never also played in a songs block.
const computeTracks = () =>
  assignSongs(blocks, source?.pool ?? [], source?.offset ?? 0, bedChoice === "spotify" && bedTrack ? [bedTrack.uri] : []);
function save() { store.saveBlocks(blocks); }

const MODE_LABELS: Record<string, string> = { quiet: "🤫 Quiet", record: "🎙️ Recorded", background: "🎶 Background" };
const TYPE_ICONS: Record<BlockType, string> = { songs: "🎵", jingle: "🎤", talk: "🗣️", bed: "🎶", commercial: "📢" };
const SHORT_LABELS: Record<BlockType, string> = { songs: "Songs", jingle: "Jingle", talk: "News", bed: "DJ Talk", commercial: "Ad Break" };

// ====================== DOM ======================
const splashScreen = $("splash-screen");
const builderScreen = $("builder-screen");
const liveScreen = $("live-screen");
const endScreen = $("end-screen");
const blocksList = $("blocks-list");
const addModal = $("add-modal");
const modeModal = $("mode-modal");
const recorderModal = $("recorder-modal");
const songsModal = $("songs-modal");
const pickModal = $("pick-modal");
const allModals = [addModal, modeModal, recorderModal, songsModal, pickModal];

$("app-version-tag").textContent = "v2 · " + BUILD_ID;

// ====================== BLOCK LIST ======================
function renderBlocks() {
  const tracks = computeTracks();
  blocksList.innerHTML = "";
  blocks.forEach((block, index) => {
    const card = document.createElement("div");
    card.className = `block-card ${block.type}`;
    let left: string;
    let right: string;
    if (block.type === "songs") {
      const names = (tracks.get(block.id) ?? []).map(t => t.name).join(" · ");
      left = `<span class="block-icon">🎵</span><span class="block-text">Play <span class="song-count">${block.count}</span> ${block.count === 1 ? "Song" : "Songs"}<span class="song-names">${names ? escapeHtml(names) : "Pick where songs come from ↑"}</span></span>`;
      right = `<button class="num-btn" data-action="minus">−</button><button class="num-btn" data-action="plus">+</button><button class="delete-btn" data-action="delete">×</button>`;
    } else {
      const mode = (MODE_LABELS[block.mode ?? "quiet"] ?? "") + (block.mode === "record" && block.bed ? " + 🎶" : "");
      left = `<span class="block-icon">${TYPE_ICONS[block.type]}</span><span class="block-text">${TYPE_LABELS[block.type]} <span class="block-mode-badge">${mode}</span></span>`;
      right = `<button class="edit-btn" data-action="edit">✎</button><button class="delete-btn" data-action="delete">×</button>`;
    }
    card.innerHTML = `<div class="block-left">${left}</div><div class="block-controls">${right}</div>`;
    card.querySelectorAll<HTMLButtonElement>("[data-action]").forEach(btn => {
      btn.addEventListener("click", e => {
        e.stopPropagation();
        const action = btn.dataset.action;
        if (action === "plus") setCount(block, (block.count ?? 1) + 1);
        else if (action === "minus") setCount(block, (block.count ?? 1) - 1);
        else if (action === "delete") {
          if (block.mode === "record" && !confirm("Delete your recording?")) return;
          if (block.mode === "record") void store.deleteRecording(block.id);
          blocks.splice(index, 1);
          invalidateResume();
          save();
          renderBlocks();
        } else if (action === "edit") openModeModal(block, false);
      });
    });
    if (block.type === "songs") card.addEventListener("click", () => openSongsSheet(block));
    attachCardDrag(card);
    blocksList.appendChild(card);
  });
}

function setCount(block: Block, n: number) {
  block.count = Math.min(12, Math.max(1, n));
  if (block.manual) block.manual = block.manual.slice(0, block.count);
  invalidateResume();
  save();
  renderBlocks();
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

// ====================== PRESS-AND-HOLD DRAG TO REORDER (same as the original app) ======================
const LONG_PRESS_MS = 320;
const DRAG_CANCEL_PX = 10;
let dragCtx: { card: HTMLElement; pointerId: number; startClientY: number; index: number; targetIndex: number; cardHeight: number; tops: number[] } | null = null;

function attachCardDrag(card: HTMLElement) {
  let longPressTimer: number | undefined;
  let startX = 0, startY = 0, lastScrollY = 0;

  const cancelPre = () => {
    clearTimeout(longPressTimer);
    card.removeEventListener("pointermove", onPreMove);
    card.removeEventListener("pointerup", cancelPre);
    card.removeEventListener("pointercancel", cancelPre);
  };
  // The card has touch-action: none (needed for long-press drag on phones), so
  // if the finger moves before the long press fires, scroll the page ourselves.
  function onPreMove(e: PointerEvent) {
    if (Math.abs(e.clientY - startY) > DRAG_CANCEL_PX || Math.abs(e.clientX - startX) > DRAG_CANCEL_PX) {
      cancelPre();
      lastScrollY = e.clientY;
      card.addEventListener("pointermove", onScrollMove);
      card.addEventListener("pointerup", endScroll);
      card.addEventListener("pointercancel", endScroll);
      window.scrollBy(0, startY - e.clientY);
    }
  }
  function onScrollMove(e: PointerEvent) {
    window.scrollBy(0, lastScrollY - e.clientY);
    lastScrollY = e.clientY;
  }
  function endScroll() {
    card.removeEventListener("pointermove", onScrollMove);
    card.removeEventListener("pointerup", endScroll);
    card.removeEventListener("pointercancel", endScroll);
  }
  card.addEventListener("pointerdown", e => {
    if ((e.target as HTMLElement).closest("button")) return;
    if (e.pointerType === "mouse" && e.button !== 0) return;
    startX = e.clientX;
    startY = e.clientY;
    card.addEventListener("pointermove", onPreMove);
    card.addEventListener("pointerup", cancelPre);
    card.addEventListener("pointercancel", cancelPre);
    longPressTimer = window.setTimeout(() => {
      cancelPre();
      beginDrag(card, e.pointerId, e.clientY);
    }, LONG_PRESS_MS);
  });
}

function beginDrag(card: HTMLElement, pointerId: number, clientY: number) {
  const siblings = Array.from(blocksList.children) as HTMLElement[];
  const index = siblings.indexOf(card);
  const listTop = blocksList.getBoundingClientRect().top;
  dragCtx = {
    card, pointerId, startClientY: clientY, index, targetIndex: index,
    cardHeight: card.getBoundingClientRect().height,
    tops: siblings.map(el => el.getBoundingClientRect().top - listTop)
  };
  try { card.setPointerCapture(pointerId); } catch { /* ignore */ }
  card.classList.add("dragging");
  document.addEventListener("pointermove", onDragMove);
  document.addEventListener("pointerup", onDragEnd);
  document.addEventListener("pointercancel", onDragEnd);
  navigator.vibrate?.(15);
}

function onDragMove(e: PointerEvent) {
  if (!dragCtx || e.pointerId !== dragCtx.pointerId) return;
  e.preventDefault();
  const d = dragCtx;
  const deltaY = e.clientY - d.startClientY;
  d.card.style.transform = `translateY(${deltaY}px)`;
  const siblings = Array.from(blocksList.children) as HTMLElement[];
  const center = d.tops[d.index] + d.cardHeight / 2 + deltaY;
  let pos = 0;
  siblings.forEach((el, i) => {
    if (i !== d.index && center > d.tops[i] + el.getBoundingClientRect().height / 2) pos++;
  });
  const target = Math.min(Math.max(pos, 0), siblings.length - 1);
  if (target !== d.targetIndex) {
    d.targetIndex = target;
    siblings.forEach((el, i) => {
      if (i === d.index) return;
      let shift = 0;
      if (target > d.index && i > d.index && i <= target) shift = -(d.cardHeight + 12);
      else if (target < d.index && i < d.index && i >= target) shift = d.cardHeight + 12;
      el.style.transform = shift ? `translateY(${shift}px)` : "";
    });
  }
}

function onDragEnd(e: PointerEvent) {
  if (!dragCtx || e.pointerId !== dragCtx.pointerId) return;
  const { index, targetIndex } = dragCtx;
  document.removeEventListener("pointermove", onDragMove);
  document.removeEventListener("pointerup", onDragEnd);
  document.removeEventListener("pointercancel", onDragEnd);
  dragCtx = null;
  if (targetIndex !== index) {
    const [moved] = blocks.splice(index, 1);
    blocks.splice(targetIndex, 0, moved);
    invalidateResume();
    save();
  }
  renderBlocks();
}

// ====================== MODALS + PHONE BACK BUTTON ======================
let modalHistoryPushed = false;
function openModal(m: HTMLElement) {
  allModals.forEach(x => show(x, x === m));
  if (!modalHistoryPushed) {
    modalHistoryPushed = true;
    history.pushState({ djrafModal: true }, "");
  }
}
function hideModalsInternal() {
  keepTakeIfAny();
  allModals.forEach(x => show(x, false));
  cancelRecording();
}
function closeAllModals() {
  hideModalsInternal();
  if (modalHistoryPushed) {
    modalHistoryPushed = false;
    goBack();
  }
}

let showHistoryPushed = false;
// history.back() is answered a moment later by a popstate event. If a new
// pop-up opened in that moment, that late event looked like the phone's back
// button and closed it (caught in live testing). So count the backs we trigger
// ourselves and ignore their popstate events.
let ownBacks = 0;
function goBack() {
  ownBacks++;
  history.back();
}

window.addEventListener("popstate", () => {
  if (ownBacks > 0) { ownBacks--; return; }
  if (modalHistoryPushed) {
    modalHistoryPushed = false;
    hideModalsInternal();
    return;
  }
  if (showHistoryPushed && current?.running) {
    // The phone's back button/edge swipe mid-show pauses rather than stopping it.
    history.pushState({ djrafShow: true }, "");
    if (!current.paused) void current.togglePause().then(() => { pauseBtn.textContent = "Resume"; });
    return;
  }
  if (showHistoryPushed) {
    showHistoryPushed = false;
    exitToBuilderInternal();
  }
});

// ---------- add block ----------
$("add-block-btn").addEventListener("click", () => openModal(addModal));
$("close-modal").addEventListener("click", closeAllModals);
document.querySelectorAll<HTMLButtonElement>(".block-type-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    const type = btn.dataset.type as BlockType;
    if (type === "songs") {
      blocks.push({ id: makeId(), type, count: 3 });
      invalidateResume();
      save();
      renderBlocks();
      closeAllModals();
      return;
    }
    openModeModal({ id: makeId(), type, mode: "quiet" }, true);
  });
});

// ---------- how should it work (quiet / record / record + music / music) ----------
let target: Block | null = null;
let targetIsNew = false;
function openModeModal(block: Block, isNew: boolean) {
  target = block;
  targetIsNew = isNew;
  $("mode-modal-title").textContent = `How should "${TYPE_LABELS[block.type]}" work?`;
  openModal(modeModal);
}
$("close-mode-modal").addEventListener("click", closeAllModals);
document.querySelectorAll<HTMLButtonElement>(".mode-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    if (!target) return;
    const mode = btn.dataset.mode;
    if (mode === "quiet" || mode === "background") {
      if (target.mode === "record") {
        if (!confirm("This will delete your recording. OK?")) return;
        void store.deleteRecording(target.id);
      }
      target.mode = mode;
      target.bed = null;
      target.bedTrack = undefined;
      finalize();
    } else {
      openRecorder(mode === "record-bg" ? recordingBed() : null);
    }
  });
});

// Recordings with music use the app's own music: turning a Spotify song down
// on a phone turns the whole phone down, which would make his voice quiet too.
function recordingBed(): BedId {
  return bedChoice === "spotify" ? "chill" : bedChoice;
}

function finalize() {
  if (!target) return;
  if (targetIsNew) blocks.push(target);
  invalidateResume();
  save();
  renderBlocks();
  closeAllModals();
}

// ---------- recorder ----------
const recorder = new Recorder();
const recordBed = new BedPlayer();
const recMain = $<HTMLButtonElement>("recorder-main-btn");
const recTimer = $("recorder-timer");
const recPreview = $<HTMLAudioElement>("recorder-preview");
const recSave = $("recorder-save-btn");
const recRetry = $("recorder-retry-btn");
let recBed: BedId | null = null;
let recBlob: Blob | null = null;
let recSeconds = 0;
let recInterval: number | null = null;
const RECORD_LIMIT_S = 60;
const fmtLimit = "1:00";

function resetRecorderUI() {
  show(recMain, true);
  recMain.textContent = "⏺ Start Recording";
  show(recTimer, false);
  recTimer.textContent = "00:00";
  show(recPreview, false);
  recPreview.removeAttribute("src");
  show(recSave, false);
  show(recRetry, false);
  recBlob = null;
  $("close-recorder-modal").textContent = "Cancel";
}
function openRecorder(bed: BedId | null) {
  recBed = bed;
  resetRecorderUI();
  $("recorder-hint").textContent = bed
    ? `Tap the button and talk — ${bedName(bed)} music plays while you record, and plays under it on air.`
    : "Tap the button, say your bit, then tap stop.";
  openModal(recorderModal);
}
const bedName = (b: BedId) => ({ chill: "chill", hype: "hype", serious: "serious" })[b];
const fmt = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

// The first time, the phone asks permission to use the mic. Until he answers,
// say so on the button (it used to just sit there) and ignore extra taps, which
// would otherwise start a second recorder.
let micStarting = false;
recMain.addEventListener("click", async () => {
  if (recorder.recording) { void finishRecording(); return; }
  if (micStarting) return;
  micStarting = true;
  recMain.textContent = "🎤 Tap “Allow” to use the microphone…";
  void unlockAudio(); // recording itself doesn't need the sound engine
  try {
    await recorder.start();
  } catch {
    recMain.textContent = "⏺ Start Recording";
    alert("Couldn't use the microphone. Please allow microphone access and try again.");
    return;
  } finally {
    micStarting = false;
  }
  if (recorderModal.classList.contains("hidden")) { void recorder.stop(); return; } // closed while waiting
  if (recBed) void recordBed.start(recBed, 0.3);
  recSeconds = 0;
  recTimer.textContent = `0:00 / ${fmtLimit}`;
  show(recTimer, true);
  recMain.textContent = "⏹ Stop Recording";
  recInterval = window.setInterval(() => {
    recSeconds++;
    recTimer.textContent = `${fmt(recSeconds)} / ${fmtLimit}`;
    if (recSeconds >= RECORD_LIMIT_S) void finishRecording();
  }, 1000);
});

async function finishRecording() {
  if (recInterval !== null) { clearInterval(recInterval); recInterval = null; }
  recordBed.stop(600);
  const blob = await recorder.stop();
  if (!blob) return;
  recBlob = blob;
  recPreview.src = URL.createObjectURL(blob);
  show(recPreview, true);
  show(recMain, false);
  show(recSave, true);
  show(recRetry, true);
  $("close-recorder-modal").textContent = "🗑 Throw it away";
}
// Closing the recorder any way other than "Throw it away" keeps a finished take.
function keepTakeIfAny() {
  if (recBlob && target && !recorderModal.classList.contains("hidden")) void keepTake();
}
async function keepTake() {
  if (!target || !recBlob) return;
  const blob = recBlob;
  recBlob = null;
  await store.saveRecording(target.id, blob);
  target.mode = "record";
  target.bed = recBed;
  target.bedTrack = undefined;
  if (targetIsNew) blocks.push(target);
  targetIsNew = false;
  invalidateResume();
  save();
  renderBlocks();
}
function cancelRecording() {
  if (recInterval !== null) { clearInterval(recInterval); recInterval = null; }
  if (recorder.recording) void recorder.stop();
  if (recordBed.playing) recordBed.stop(300);
  recPreview.pause();
}
recRetry.addEventListener("click", resetRecorderUI);
$("close-recorder-modal").addEventListener("click", () => { recBlob = null; closeAllModals(); });
recSave.addEventListener("click", async () => {
  await keepTake();
  closeAllModals();
});

// ---------- songs block sheet ----------
let sheetBlock: Block | null = null;
function openSongsSheet(block: Block) {
  sheetBlock = block;
  renderSongsSheet();
  openModal(songsModal);
}
function renderSongsSheet() {
  const b = sheetBlock;
  if (!b) return;
  $("songs-count").textContent = String(b.count ?? 1);
  $("songs-modal-title").textContent = source ? `Songs from ${source.name}` : "Songs";
  const list = computeTracks().get(b.id) ?? [];
  const el = $("songs-list");
  el.innerHTML = "";
  if (!source) {
    el.innerHTML = `<p class="recorder-hint">Choose where songs come from first (top of the screen).</p>`;
    return;
  }
  list.forEach((t, i) => {
    const row = document.createElement("div");
    row.className = "pick-row";
    row.innerHTML = `<span>${i + 1}. ${escapeHtml(t.name)}<small>${escapeHtml(t.artist)}${b.manual?.[i] ? " · your pick" : ""}</small></span><button class="swap" aria-label="Swap song">🔁</button>`;
    row.querySelector("button")!.addEventListener("click", () => openSwap(b, i));
    el.appendChild(row);
  });
  $("songs-hint").textContent = list.length < (b.count ?? 1) ? "Not enough songs in this playlist — pick another one." : "Tap 🔁 to swap a song.";
}
$("songs-minus").addEventListener("click", () => { if (sheetBlock) { setCount(sheetBlock, (sheetBlock.count ?? 1) - 1); renderSongsSheet(); } });
$("songs-plus").addEventListener("click", () => { if (sheetBlock) { setCount(sheetBlock, (sheetBlock.count ?? 1) + 1); renderSongsSheet(); } });
$("songs-done").addEventListener("click", closeAllModals);

function openSwap(b: Block, slot: number) {
  const used = new Set([...computeTracks().values()].flat().map(t => t.uri));
  const rows: PickRow[] = [{ title: "🎲 Let the app choose", onPick: () => setManual(b, slot, null) }];
  for (const t of source?.pool ?? []) {
    if (used.has(t.uri)) continue;
    rows.push({ title: t.name, sub: t.artist, onPick: () => setManual(b, slot, t) });
  }
  openPicker("Pick a song", rows, () => openModal(songsModal));
}
function setManual(b: Block, slot: number, t: Track | null) {
  const manual = (b.manual ?? []).slice(0, b.count ?? 1);
  while (manual.length < (b.count ?? 1)) manual.push(null);
  manual[slot] = t;
  b.manual = manual.some(Boolean) ? manual : undefined;
  invalidateResume();
  save();
  renderBlocks();
  renderSongsSheet();
  openModal(songsModal);
}

// ---------- generic picker ----------
interface PickRow { title: string; sub?: string; onPick: () => void }
let pickBack: (() => void) | null = null;
function openPicker(title: string, rows: PickRow[], back: (() => void) | null = null) {
  pickBack = back;
  $("pick-title").textContent = title;
  const el = $("pick-list");
  el.innerHTML = "";
  for (const r of rows) {
    const b = document.createElement("button");
    b.className = "pick-row";
    b.innerHTML = `<span>${escapeHtml(r.title)}${r.sub ? `<small>${escapeHtml(r.sub)}</small>` : ""}</span>`;
    b.addEventListener("click", r.onPick);
    el.appendChild(b);
  }
  openModal(pickModal);
}
$("close-pick-modal").addEventListener("click", () => (pickBack ? pickBack() : closeAllModals()));

// ====================== WHERE SONGS COME FROM ======================
function renderSource(message?: string) {
  $("source-name").textContent = source ? source.name : "Nothing picked yet";
  $("source-hint").textContent = message ?? (source ? `${source.pool.length} songs ready` : "Play a playlist in Spotify, then tap “Use what's playing”.");
}
function setSource(s: SongSource) {
  source = s;
  store.saveSource(s);
  invalidateResume();
  renderSource();
  renderBlocks();
}
async function needLogin(): Promise<boolean> {
  if (isLoggedIn()) return false;
  alert("Please connect Spotify first!");
  return true;
}
$("use-playing-btn").addEventListener("click", async () => {
  if (await needLogin()) return;
  renderSource("Checking Spotify…");
  const r = await fromNowPlaying();
  if (r.ok) setSource(r.source);
  else renderSource(r.message);
});
$("choose-playlist-btn").addEventListener("click", async () => {
  if (await needLogin()) return;
  renderSource("Loading your playlists…");
  let lists: sp.PlaylistInfo[] = [];
  try { lists = await sp.getMyPlaylists(); } catch { /* shown below */ }
  renderSource();
  if (!lists.length) { renderSource("Couldn't load your playlists."); return; }
  openPicker("Choose a playlist", lists.map(p => ({
    title: p.name,
    sub: p.tracks ? `${p.tracks} songs` : undefined,
    onPick: async () => {
      closeAllModals();
      renderSource("Loading songs…");
      const r = await fromPlaylist(p.id, p.name);
      if (r.ok) setSource(r.source);
      else renderSource(r.message);
    }
  })));
});

// ====================== BACKGROUND MUSIC CHOICE ======================
const previewBed = new BedPlayer();
let previewTimer: number | null = null;
let previewingSpotify = false;
function renderBeds() {
  document.querySelectorAll<HTMLButtonElement>(".bed-pill").forEach(b => b.classList.toggle("selected", b.dataset.bed === bedChoice));
  const line = $("bed-song");
  show(line, bedChoice === "spotify" && !!bedTrack);
  line.textContent = bedTrack ? `🎵 ${bedTrack.name} – ${bedTrack.artist}` : "";
}
function chooseBed(c: BedChoice) {
  bedChoice = c;
  store.saveBed(c);
  renderBeds();
  invalidateResume();
  renderBlocks(); // the songs blocks may change if the talk-over song was in them
}
document.querySelectorAll<HTMLButtonElement>(".bed-pill").forEach(b => {
  b.addEventListener("click", () => {
    const c = b.dataset.bed as BedChoice;
    if (c === "spotify") { pickBedSong(); return; }
    chooseBed(c);
    if (previewBed.playing) void startPreview();
  });
});
function pickBedSong() {
  if (!source?.pool.length) {
    renderSource("First choose where songs come from, then pick a song to talk over.");
    return;
  }
  openPicker("Pick a song to talk over", source.pool.map(t => ({
    title: t.name,
    sub: t.artist,
    onPick: () => {
      bedTrack = t;
      store.saveBedTrack(t);
      chooseBed("spotify");
      closeAllModals();
    }
  })));
}
async function startPreview() {
  stopPreview();
  if (bedChoice === "spotify" && bedTrack) {
    if (!deviceId && !(await ensureDevice())) return;
    previewingSpotify = true;
    await sp.setRepeat(deviceId!, "off");
    await sp.playUris(deviceId!, [bedTrack.uri]);
  } else {
    await unlockAudio();
    await previewBed.start(bedChoice === "spotify" ? "chill" : bedChoice, 0.7);
  }
  $("bed-preview-btn").textContent = "⏹ Stop";
  previewTimer = window.setTimeout(stopPreview, 10000);
}
function stopPreview() {
  if (previewBed.playing) previewBed.stop(500);
  if (previewingSpotify && deviceId) void sp.pause(deviceId);
  previewingSpotify = false;
  $("bed-preview-btn").textContent = "▶ Listen";
  if (previewTimer !== null) { clearTimeout(previewTimer); previewTimer = null; }
}
$("bed-preview-btn").addEventListener("click", () => (previewBed.playing || previewingSpotify ? stopPreview() : void startPreview()));

// ====================== LOOP ======================
const loopToggle = $<HTMLInputElement>("loop-toggle");
loopToggle.checked = loopEnabled;
loopToggle.addEventListener("change", () => { loopEnabled = loopToggle.checked; store.saveLoop(loopEnabled); });

// ====================== SPOTIFY CONNECTION ======================
function showLoggedOut() {
  show($("source-login-btn"), true);
  show($("source-actions"), false);
  show($("login-btn"), true);
  show($("spotify-connected"), false);
  show($("device-hint"), false);
}
function showConnected() {
  show($("source-login-btn"), false);
  show($("source-actions"), true);
  show($("login-btn"), false);
  show($("device-hint"), false);
  show($("spotify-connected"), true);
}
function showNeedsDevice(msg?: string) {
  show($("source-login-btn"), false);
  show($("source-actions"), true);
  show($("login-btn"), false);
  show($("spotify-connected"), false);
  show($("device-hint"), true);
  $("device-hint-text").textContent = msg ?? "Open the Spotify app on this phone (so it shows up as a speaker), then tap Refresh.";
}

async function ensureDevice(): Promise<boolean> {
  if (!isLoggedIn()) { showLoggedOut(); return false; }
  let devices: sp.Device[];
  try {
    devices = await sp.getDevices();
  } catch (e) {
    if (e instanceof sp.SpotifyError && e.status === 401) { showLoggedOut(); return false; }
    deviceId = null;
    showNeedsDevice("Couldn't reach Spotify — check the internet, then tap Refresh.");
    return false;
  }
  const d = devices.find(x => x.is_active) ?? devices.find(x => x.type === "Smartphone") ?? devices[0];
  if (!d) { deviceId = null; showNeedsDevice(); return false; }
  deviceId = d.id;
  showConnected();
  return true;
}
$("login-btn").addEventListener("click", () => void login());
$("source-login-btn").addEventListener("click", () => void login());
// Coming back from the Spotify app: look for the phone as a speaker again, so
// he rarely has to tap Refresh.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && isLoggedIn() && !current?.running) void ensureDevice();
});
$("refresh-device-btn").addEventListener("click", () => void ensureDevice());

// ====================== LIVE SHOW ======================
const statusLabel = $("status-label");
const statusMain = $("status-main");
const statusSub = $("status-sub");
const progressFill = $("progress-fill");
const timeElapsed = $("time-elapsed");
const timeRemaining = $("time-remaining");
const skipBtn = $("skip-song-btn");
const finishedBtn = $("finished-talking-btn");
const pauseBtn = $("pause-btn");
const trouble = $("trouble");

let noticeUntil = 0;
const clock = (s: number) => { const t = Math.max(0, Math.round(s)); return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`; };

const ui = {
  status(label: string, main: string, sub: string) {
    statusLabel.textContent = label;
    statusMain.textContent = main;
    statusSub.textContent = sub;
  },
  progress(elapsed: number, duration: number | null) {
    if (duration && duration > 0 && isFinite(duration)) {
      progressFill.style.width = Math.min(100, Math.max(0, (elapsed / duration) * 100)) + "%";
      timeElapsed.textContent = clock(elapsed);
      timeRemaining.textContent = "-" + clock(duration - elapsed);
    } else {
      progressFill.style.width = "100%";
      timeElapsed.textContent = clock(elapsed);
      timeRemaining.textContent = "";
    }
  },
  buttons(kind: "songs" | "talk" | "clip") {
    show(skipBtn, kind === "songs");
    show(finishedBtn, kind !== "songs");
    finishedBtn.textContent = kind === "clip" ? "Skip recording → Next" : "I'm finished talking → Next";
  },
  current(i: number) {
    const nb = blocks[i + 1];
    $("next-up").textContent = "Next up: " + (nb ? (nb.type === "songs" ? `Play ${nb.count} ${nb.count === 1 ? "Song" : "Songs"}` : TYPE_LABELS[nb.type]) : loopEnabled ? "Loop → start again" : "End of show");
    renderTimetable(i);
  },
  songList(tracks: Track[] | null, playing: number) {
    const el = $("run-list");
    show(el, !!tracks && tracks.length > 1);
    if (!tracks) return;
    el.innerHTML = tracks.map((t, i) => {
      const state = i < playing ? "played" : i === playing ? "now" : "";
      const mark = i < playing ? "✓" : i === playing ? "▶" : String(i + 1);
      return `<li class="${state}"><span class="run-mark">${mark}</span><span class="run-title">${escapeHtml(t.name)}<small>${escapeHtml(t.artist)}</small></span></li>`;
    }).join("");
  },
  notice(msg: string) {
    noticeUntil = Date.now() + 8000;
    show(trouble, true);
    trouble.textContent = msg;
    setTimeout(() => { if (Date.now() >= noticeUntil && trouble.textContent === msg) show(trouble, false); }, 8100);
  },
  trouble(msg: string | null) {
    if (!msg && Date.now() < noticeUntil) return; // let a reminder finish showing
    show(trouble, !!msg);
    trouble.textContent = msg ? `🔌 ${msg}` : "";
  },
  finished() {
    releaseWakeLock();
    finishShow();
  }
};

function renderTimetable(currentIndex: number) {
  const el = $("timetable");
  el.innerHTML = "";
  blocks.forEach((b, i) => {
    const chip = document.createElement("div");
    chip.className = `timetable-chip ${b.type}`;
    if (i < currentIndex) chip.classList.add("played");
    if (i === currentIndex) chip.classList.add("current");
    chip.innerHTML = `<span class="tt-icon">${TYPE_ICONS[b.type]}</span><span class="tt-label">${b.type === "songs" ? `${b.count} ${b.count === 1 ? "Song" : "Songs"}` : SHORT_LABELS[b.type]}</span>`;
    el.appendChild(chip);
  });
  (el.children[currentIndex] as HTMLElement | undefined)?.scrollIntoView({ behavior: "smooth", inline: "start", block: "nearest" });
}

let wakeLock: { release(): Promise<void> } | null = null;
async function keepAwake() {
  try { wakeLock = await (navigator as unknown as { wakeLock: { request(t: string): Promise<{ release(): Promise<void> }> } }).wakeLock.request("screen"); } catch { /* not supported */ }
}
function releaseWakeLock() { void wakeLock?.release().catch(() => {}); wakeLock = null; }

async function startShow(from: number, tracks: Map<string, Track[]>) {
  if (!blocks.length) { alert("Add at least one block!"); return; }
  await unlockAudio();
  stopPreview();
  current?.stop();
  current = new Show(blocks, tracks, deviceId, () => ({ choice: bedChoice, track: bedTrack }), ui, () => {
    if (!loopEnabled) return null;
    advanceSource();
    return computeTracks();
  });
  resumeFrom = null;
  resumeTracks = null;
  pauseBtn.textContent = "Pause everything";
  show(builderScreen, false);
  show(endScreen, false);
  show(liveScreen, true);
  if (!showHistoryPushed) { showHistoryPushed = true; history.pushState({ djrafShow: true }, ""); }
  void keepAwake();
  updateStartLabel();
  await current.start(from);
}

let starting = false;
async function prepareAndStart(from: number) {
  starting = true;
  try { await prepareAndStartInner(from); } finally { starting = false; }
}
async function prepareAndStartInner(from: number) {
  if (!isLoggedIn()) { alert("Please connect Spotify first!"); return; }
  const hasSongs = blocks.some(b => b.type === "songs");
  if (hasSongs && !(await ensureDevice())) {
    alert("Open the Spotify app on this phone, then try again.");
    return;
  }
  if (hasSongs && !source) {
    const r = await fromNowPlaying();
    if (!r.ok) { alert(r.message); return; }
    setSource(r.source);
  }
  await startShow(from, from > 0 && resumeTracks ? resumeTracks : computeTracks());
}

// The next show carries on through the playlist instead of repeating these songs.
function advanceSource() {
  if (!source) return;
  source = { ...source, offset: source.offset + autoSongsUsed(blocks) };
  store.saveSource(source);
}

function finishShow() {
  current = null;
  advanceSource();
  renderBlocks();
  show(liveScreen, false);
  show(endScreen, true);
  updateStartLabel();
}

function invalidateResume() { resumeFrom = null; resumeTracks = null; updateStartLabel(); }

function updateStartLabel() {
  const canResume = resumeFrom !== null;
  $("start-show-btn").textContent = canResume ? "▶ Resume Show" : "▶ Start Show";
  show($("restart-show-link"), canResume);
}

function exitToBuilderInternal() {
  if (current?.running) {
    resumeFrom = current.index;
    resumeTracks = computeTracks();
    current.stop();
    if (deviceId) void sp.pause(deviceId);
  }
  current = null;
  releaseWakeLock();
  show(liveScreen, false);
  show(endScreen, false);
  show(builderScreen, true);
  updateStartLabel();
}
function exitToBuilder() {
  exitToBuilderInternal();
  if (showHistoryPushed) { showHistoryPushed = false; goBack(); }
}

$("start-show-btn").addEventListener("click", () => void prepareAndStart(resumeFrom ?? 0));
$("restart-show-link").addEventListener("click", () => { invalidateResume(); void prepareAndStart(0); });
skipBtn.addEventListener("click", () => current?.skipSong());
finishedBtn.addEventListener("click", () => current?.finishedTalking());
pauseBtn.addEventListener("click", async () => {
  if (!current) return;
  await current.togglePause();
  pauseBtn.textContent = current.paused ? "Resume" : "Pause everything";
});
$("stop-show-btn").addEventListener("click", exitToBuilder);
$("play-again-btn").addEventListener("click", () => void prepareAndStart(0));
$("back-to-builder-btn").addEventListener("click", exitToBuilder);

// ====================== PHONE CHECK (tap the version number) ======================
// For the parent: checks, on this actual phone, the things that behave
// differently on a phone than on a computer.
let checking = false;
$("app-version-tag").addEventListener("click", async () => {
  if (checking || current?.running) return;
  if (!isLoggedIn()) { alert("Connect Spotify first, then tap the version number again."); return; }
  if (!(await ensureDevice()) || !deviceId) { alert("Open the Spotify app on this phone first, then tap the version number again."); return; }
  checking = true;
  $("app-version-tag").textContent = "Checking this phone…";
  const lines: string[] = [];
  try {
    const d = (await sp.getDevices()).find(x => x.id === deviceId);
    lines.push(`Spotify speaker: ${d?.name ?? "?"} (${d?.type ?? "?"})`);
    let before: number | null = null;
    const target = Math.max(5, (d?.volume_percent ?? 60) - 25);
    const ok = await tryDuck(deviceId, target, v => { before = v; });
    if (ok && before !== null) await sp.setVolume(deviceId, before);
    lines.push(ok
      ? "✅ Talk-over with a Spotify song: the app can turn Spotify down and back up by itself."
      : "⚠️ Talk-over with a Spotify song: Spotify won't let the app change the volume on this phone. Raf will be asked to turn it down with the volume buttons (and back up after). Chill / Hype / Serious don't need this.");
    try {
      const q = await sp.getQueue();
      lines.push(q.length ? "✅ “Use what's playing” can read the songs coming up." : "ℹ️ Play a playlist in Spotify so “Use what's playing” has songs to read.");
    } catch { lines.push("⚠️ Couldn't read Spotify's up-next list — use “Choose playlist” instead."); }
    try {
      const mic = await navigator.permissions.query({ name: "microphone" as PermissionName });
      lines.push(mic.state === "granted" ? "✅ Microphone allowed." : "ℹ️ Microphone: the phone will ask the first time he records — tap Allow.");
    } catch { /* not supported */ }
  } finally {
    checking = false;
    $("app-version-tag").textContent = "v2 · " + BUILD_ID;
  }
  alert(lines.join("\n\n"));
});

// ====================== SPLASH (same as the original app) ======================
const SPLASH_DURATION_MS = 4200;
const SPLASH_TAP_HINT_DELAY_MS = 1900;
const SPLASH_PHRASES = ["Warming up the mic", "Tuning the antenna", "Cueing up the tunes", "Dusting off the turntable"];

function runSplash() {
  if (new URLSearchParams(location.search).has("code")) {
    show(splashScreen, false);
    show(builderScreen, true);
    return;
  }
  let i = 0;
  const phrase = $("splash-phrase");
  const interval = setInterval(() => { i = (i + 1) % SPLASH_PHRASES.length; phrase.textContent = SPLASH_PHRASES[i]; }, 900);
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    clearInterval(interval);
    void unlockAudio();
    splashScreen.classList.add("splash-fade-out");
    setTimeout(() => { show(splashScreen, false); show(builderScreen, true); }, 400);
  };
  setTimeout(finish, SPLASH_DURATION_MS);
  setTimeout(() => show($("splash-tap-hint"), true), SPLASH_TAP_HINT_DELAY_MS);
  splashScreen.addEventListener("click", finish, { once: true });
}

// ====================== INIT ======================
async function init() {
  renderBlocks();
  renderSource();
  renderBeds();
  updateStartLabel();
  await handleRedirect();
  if (isLoggedIn()) await ensureDevice();
  else showLoggedOut();
}

watchForUpdates(() => starting || !!current?.running || recorder.recording || !recorderModal.classList.contains("hidden"));
runSplash();
void init();

// Handy for testing from the browser console.
(window as unknown as { djraf: unknown }).djraf = { get show() { return current; }, get source() { return source; }, blocks: () => blocks };
