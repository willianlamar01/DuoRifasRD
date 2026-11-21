// =====================================================================
// DuoRifa — Panel Admin (varias rifas; ver raffles-config.js)
// Las compras se cargan por páginas para no gastar lecturas de Firebase.
// =====================================================================
import { db, auth } from "./firebase-config.js";
import {
  signInWithEmailAndPassword, signOut, onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";
import {
  collection, onSnapshot, doc, runTransaction, arrayUnion, arrayRemove,
  query, where, orderBy, limit, startAfter, getDocs, getCountFromServer, increment
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import { RAFFLES, raffleOf } from "./raffles-config.js";

const PAGE = 20; // compras por página
const formatMoney = (n) => `RD$${(n || 0).toLocaleString("es-DO")}`;

// Escapa TODO texto que viene de la base de datos antes de mostrarlo.
function escapeHtml(str) {
  return String(str ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}

// Solo se acepta como comprobante una imagen en base64 (data:image/...)
const safeProofSrc = (v) =>
  typeof v === "string" && v.startsWith("data:image/") ? v : "";

// Un número de boleto válido son exactamente 5 dígitos
const isValidTicketNumber = (n) => typeof n === "string" && /^\d{5}$/.test(n);

// Referencia a un documento de configuración de una rifa
const rdoc = (r, key) => doc(db, "raffle", r.docs[key]);

// ------------------- ELEMENTOS -------------------
const loginScreen = document.getElementById("loginScreen");
const panelScreen = document.getElementById("panelScreen");
const loginForm = document.getElementById("loginForm");
const loginBtn = document.getElementById("loginBtn");
const loginError = document.getElementById("loginError");
const userEmailEl = document.getElementById("userEmail");
const logoutBtn = document.getElementById("logoutBtn");

const ticketsList = document.getElementById("ticketsList");
const statPending = document.getElementById("statPending");
const statVerified = document.getElementById("statVerified");
const statTickets = document.getElementById("statTickets");
const tabs = document.querySelectorAll(".admin-tab");

const proofModal = document.getElementById("proofModal");
const proofModalImg = document.getElementById("proofModalImg");
const proofModalClose = document.getElementById("proofModalClose");
const proofModalCloseBtn = document.getElementById("proofModalCloseBtn");

const winnerNumberInput = document.getElementById("winnerNumberInput");
const winnerSearchBtn = document.getElementById("winnerSearchBtn");
const winnerResult = document.getElementById("winnerResult");

// ------------------- ESTADO -------------------
const RAFFLE_IDS = Object.keys(RAFFLES);
const DEFAULT_ID = RAFFLE_IDS[0]; // las compras viejas (sin raffleId) son de esta rifa (Kia)
let currentRaffleId = DEFAULT_ID;
let currentFilter = "pendiente";
let tickets = [];       // compras cargadas en pantalla
let lastDoc = null;     // para pedir la página siguiente
let hasMore = false;
let loading = false;
let viewToken = 0;      // evita mezclar resultados al cambiar de rifa o pestaña
let unsubStats = null;

const visibleTickets = () => tickets.filter((t) => raffleOf(t).id === currentRaffleId);

// =====================================================================
// SELECTOR DE RIFA (se crea desde aquí, justo encima de las pestañas)
// =====================================================================
(function buildRaffleSelector() {
  const anchor = tabs[0]?.parentElement;
  if (!anchor) return;

  const wrap = document.createElement("div");
  wrap.style.cssText = "display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:0 0 14px;";

  const label = document.createElement("label");
  label.htmlFor = "raffleSelect";
  label.textContent = "Rifa:";
  label.style.cssText = "font-weight:700;";

  const select = document.createElement("select");
  select.id = "raffleSelect";
  select.style.cssText = "padding:10px 12px;border-radius:10px;font:inherit;max-width:100%;";
  Object.values(RAFFLES).forEach((r) => {
    const opt = document.createElement("option");
    opt.value = r.id;
    opt.textContent = r.name;
    select.appendChild(opt);
  });
  select.value = currentRaffleId;
  select.addEventListener("change", () => {
    currentRaffleId = select.value;
    watchStats();
    refreshCounts();
    loadTickets(true);
    refreshWinnerSearch();
  });

  wrap.append(label, select);
  anchor.parentNode.insertBefore(wrap, anchor);
})();

// =====================================================================
// LOGIN / LOGOUT
// =====================================================================
loginForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  loginError.hidden = true;
  loginBtn.disabled = true;
  loginBtn.textContent = "Entrando...";

  const email = document.getElementById("loginEmail").value.trim();
  const password = document.getElementById("loginPassword").value;

  try {
    await signInWithEmailAndPassword(auth, email, password);
  } catch (err) {
    console.error(err);
    loginError.textContent = "Correo o contraseña incorrectos.";
    loginError.hidden = false;
  } finally {
    loginBtn.disabled = false;
    loginBtn.textContent = "Entrar";
  }
});

logoutBtn.addEventListener("click", async () => {
  await signOut(auth);
});

onAuthStateChanged(auth, (user) => {
  if (user) {
    loginScreen.hidden = true;
    panelScreen.hidden = false;
    userEmailEl.textContent = user.email;
    watchStats();
    refreshCounts();
    loadTickets(true);
  } else {
    loginScreen.hidden = false;
    panelScreen.hidden = true;
    if (unsubStats) { unsubStats(); unsubStats = null; }
    tickets = [];
  }
});

// =====================================================================
// CONTADORES
// - "Boletos vendidos": se lee de raffle/stats (o stats_iphone), 1 lectura.
// - Pendientes y Verificados: consultas de conteo (1 lectura por cada 1,000).
// =====================================================================
function watchStats() {
  if (unsubStats) unsubStats();
  unsubStats = onSnapshot(rdoc(RAFFLES[currentRaffleId], "stats"), (s) => {
    const n = s.exists() ? s.data().verifiedCount || 0 : 0;
    statTickets.textContent = n.toLocaleString("es-DO");
  }, console.error);
}

async function countTickets(status, raffleId) {
  const c = [];
  if (raffleId) c.push(where("raffleId", "==", raffleId));
  c.push(where("status", "==", status));
  const snap = await getCountFromServer(query(collection(db, "tickets"), ...c));
  return snap.data().count;
}

// Las compras viejas no tienen raffleId y cuentan como Kia:
// Kia = total - lo que pertenece a las demás rifas.
async function countForRaffle(status) {
  if (currentRaffleId !== DEFAULT_ID) return countTickets(status, currentRaffleId);
  const others = RAFFLE_IDS.filter((id) => id !== DEFAULT_ID);
  const [total, ...rest] = await Promise.all([
    countTickets(status),
    ...others.map((id) => countTickets(status, id))
  ]);
  return total - rest.reduce((a, b) => a + b, 0);
}

async function refreshCounts() {
  const token = viewToken;
  try {
    const [p, v] = await Promise.all([countForRaffle("pendiente"), countForRaffle("verificado")]);
    if (token !== viewToken) return;
    statPending.textContent = p;
    statVerified.textContent = v;
  } catch (err) {
    console.error(err);
  }
}

// =====================================================================
// LISTAR COMPRAS POR PÁGINAS
// =====================================================================
function ticketsQuery(after) {
  const c = [];
  if (currentRaffleId !== DEFAULT_ID) c.push(where("raffleId", "==", currentRaffleId));
  if (currentFilter === "pendiente") c.push(where("status", "==", "pendiente"));
  if (currentFilter === "verificado") c.push(where("status", "==", "verificado"));
  c.push(orderBy("createdAt", "desc"));
  if (after) c.push(startAfter(after));
  c.push(limit(PAGE));
  return query(collection(db, "tickets"), ...c);
}

async function loadTickets(reset) {
  if (reset) {
    viewToken++;
    tickets = []; lastDoc = null; hasMore = false; loading = false;
    ticketsList.innerHTML = `<p class="admin-empty">Cargando compras...</p>`;
  } else if (loading) {
    return;
  }
  const token = viewToken;
  loading = true;
  try {
    const snap = await getDocs(ticketsQuery(lastDoc));
    if (token !== viewToken) return;
    snap.docs.forEach((d) => tickets.push({ id: d.id, ...d.data() }));
    if (snap.docs.length) lastDoc = snap.docs[snap.docs.length - 1];
    hasMore = snap.docs.length === PAGE;
    renderTickets();
  } catch (err) {
    console.error(err);
    if (token === viewToken) {
      ticketsList.innerHTML = `<p class="admin-empty">No se pudieron cargar las compras. Si es la primera vez, abre la consola (Ctrl+Shift+J): si pide un índice, abre el enlace que aparece, presiona «Crear índice» y vuelve a probar en unos minutos.</p>`;
    }
  } finally {
    if (token === viewToken) loading = false;
  }
}

function renderTickets() {
  const list = visibleTickets();

  if (list.length === 0 && !hasMore) {
    ticketsList.innerHTML = `<p class="admin-empty">No hay compras en esta categoría.</p>`;
    return;
  }

  ticketsList.innerHTML = "";
  list.forEach((t) => {
    const isVerified = t.status === "verificado";
    const card = document.createElement("div");
    card.className = "ticket-card";

    const numbersText = (Array.isArray(t.ticketNumbers) ? t.ticketNumbers : []).join(", ");
    const dateText = t.createdAt?.toDate
      ? t.createdAt.toDate().toLocaleString("es-DO", { dateStyle: "short", timeStyle: "short" })
      : "";
    const safeId = escapeHtml(t.id);

    card.innerHTML = `
      <div class="ticket-info">
        <div class="ticket-name">${escapeHtml(t.fullName || "Sin nombre")} · ${escapeHtml(t.phone || "")}</div>
        <div class="ticket-meta">${escapeHtml(t.quantity || 0)} boletos · ${formatMoney(Number(t.total) || 0)} · ${escapeHtml(t.paymentMethod || "")} ${dateText ? "· " + escapeHtml(dateText) : ""}</div>
        <div class="ticket-numbers">${escapeHtml(numbersText)}</div>
      </div>
      <div class="ticket-actions">
        <span class="ticket-status ${isVerified ? "verificado" : "pendiente"}">${isVerified ? "Verificado" : "Pendiente"}</span>
        ${isVerified
          ? `<button class="btn btn-unverify" data-id="${safeId}" data-action="unverify">Deshacer</button>`
          : `<button class="btn btn-verify" data-id="${safeId}" data-action="verify">Verificar</button>`
        }
        <button class="btn btn-reject" data-id="${safeId}" data-action="reject">Eliminar</button>
      </div>
    `;

    const proofSrc = safeProofSrc(t.proofImage);
    const img = document.createElement("img");
    img.className = "ticket-thumb";
    img.alt = `Comprobante de ${t.fullName || "cliente"}`;
    if (proofSrc) {
      img.src = proofSrc;
      img.addEventListener("click", () => openProofModal(proofSrc));
    }
    card.prepend(img);

    ticketsList.appendChild(card);
  });

  ticketsList.querySelectorAll("[data-action]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const action = btn.dataset.action;
      if (action === "reject") handleReject(btn.dataset.id);
      else handleStatusChange(btn.dataset.id, action, btn);
    });
  });

  if (hasMore) {
    const more = document.createElement("button");
    more.className = "btn btn-ghost";
    more.style.cssText = "display:block;margin:16px auto;";
    more.textContent = "Cargar más";
    more.addEventListener("click", () => { more.disabled = true; loadTickets(false); });
    ticketsList.appendChild(more);
  }
}

// =====================================================================
// VERIFICAR / DESHACER
// El contador público "verifiedCount" solo se mueve aquí, dentro de una
// transacción, en el documento de stats de la rifa de la compra.
// =====================================================================
async function handleStatusChange(ticketId, action, btn) {
  const newStatus = action === "verify" ? "verificado" : "pendiente";
  if (btn) btn.disabled = true;

  try {
    await runTransaction(db, async (transaction) => {
      const ticketRef = doc(db, "tickets", ticketId);
      const snap = await transaction.get(ticketRef);
      if (!snap.exists()) return;

      const data = snap.data();
      if (data.status === newStatus) return;

      const qty = Number.isInteger(data.quantity) ? data.quantity : 0;
      const r = raffleOf(data);

      transaction.update(ticketRef, { status: newStatus });
      transaction.set(
        rdoc(r, "stats"),
        { verifiedCount: increment(newStatus === "verificado" ? qty : -qty) },
        { merge: true }
      );
    });

    // Se actualiza la lista en pantalla sin volver a leer Firebase
    const t = tickets.find((x) => x.id === ticketId);
    if (t) t.status = newStatus;
    if (currentFilter === "pendiente" || currentFilter === "verificado") {
      tickets = tickets.filter((x) => x.id !== ticketId);
    }
    renderTickets();
    refreshCounts();
    refreshWinnerSearch();
  } catch (err) {
    console.error(err);
    alert("No se pudo actualizar el estado. Intenta de nuevo.");
    if (btn) btn.disabled = false;
  }
}

// =====================================================================
// ELIMINAR COMPRA FRAUDULENTA (una sola transacción, dentro de su rifa)
// =====================================================================
async function handleReject(ticketId) {
  const ticket = tickets.find((t) => t.id === ticketId);
  if (!ticket) return;

  const numbersText = (Array.isArray(ticket.ticketNumbers) ? ticket.ticketNumbers : []).join(", ");
  const confirmMsg =
    `¿Eliminar esta compra por completo?\n\n` +
    `Rifa: ${raffleOf(ticket).name}\n` +
    `${ticket.fullName || "Sin nombre"} · ${ticket.phone || ""}\n` +
    `Números: ${numbersText}\n\n` +
    `Esta acción NO se puede deshacer. Los números quedarán disponibles ` +
    `para asignarse a otro comprador en una próxima compra.`;

  if (!confirm(confirmMsg)) return;

  try {
    await runTransaction(db, async (transaction) => {
      const ticketRef = doc(db, "tickets", ticketId);
      const snap = await transaction.get(ticketRef);
      if (!snap.exists()) return;

      const data = snap.data();
      const r = raffleOf(data);
      const numbers = (Array.isArray(data.ticketNumbers) ? data.ticketNumbers : [])
        .filter(isValidTicketNumber);
      const blessedToFree = numbers.filter((n) => r.blessed.includes(n));

      if (numbers.length > 0) {
        transaction.set(rdoc(r, "released"), { numbers: arrayUnion(...numbers) }, { merge: true });
      }
      if (data.status === "verificado" && Number.isInteger(data.quantity)) {
        transaction.set(rdoc(r, "stats"), { verifiedCount: increment(-data.quantity) }, { merge: true });
      }
      if (blessedToFree.length > 0) {
        transaction.set(rdoc(r, "blessed"), { claimed: arrayRemove(...blessedToFree) }, { merge: true });
      }
      transaction.delete(ticketRef);
    });

    tickets = tickets.filter((t) => t.id !== ticketId);
    renderTickets();
    refreshCounts();
    refreshWinnerSearch();
  } catch (err) {
    console.error(err);
    alert("No se pudo eliminar la compra. Intenta de nuevo.");
  }
}

// ------------------- TABS -------------------
tabs.forEach((tab) => {
  tab.addEventListener("click", () => {
    tabs.forEach((t) => t.classList.remove("active"));
    tab.classList.add("active");
    currentFilter = tab.dataset.filter;
    loadTickets(true);
  });
});

// ------------------- MODAL COMPROBANTE -------------------
function openProofModal(src) {
  proofModalImg.src = src;
  proofModal.hidden = false;
}
function closeProofModal() {
  proofModal.hidden = true;
  proofModalImg.src = "";
}
proofModalClose.addEventListener("click", closeProofModal);
proofModalCloseBtn.addEventListener("click", closeProofModal);

// =====================================================================
// BUSCAR GANADOR POR NÚMERO DE BOLETO
// Consulta solo ese número en Firebase y se queda con la compra de la
// rifa elegida (el mismo número puede existir en las dos rifas).
// =====================================================================
function formatWinnerNumber(raw) {
  const digits = (raw || "").replace(/\D/g, "");
  if (!digits) return null;
  return digits.padStart(5, "0").slice(-5);
}

function refreshWinnerSearch() {
  if (winnerResult && !winnerResult.hidden && winnerNumberInput.value.trim() !== "") {
    searchWinner();
  }
}

async function searchWinner() {
  const num = formatWinnerNumber(winnerNumberInput.value);
  const raffle = RAFFLES[currentRaffleId];
  winnerResult.hidden = false;

  if (!num) {
    winnerResult.innerHTML = `<p class="winner-empty">Escribe un número de boleto válido.</p>`;
    return;
  }

  winnerResult.innerHTML = `<p class="winner-empty">Buscando...</p>`;
  let match = null;
  try {
    const snap = await getDocs(query(collection(db, "tickets"), where("ticketNumbers", "array-contains", num)));
    match = snap.docs.map((d) => ({ id: d.id, ...d.data() }))
      .find((t) => raffleOf(t).id === currentRaffleId) || null;
  } catch (err) {
    console.error(err);
    winnerResult.innerHTML = `<p class="winner-empty">No se pudo buscar. Intenta de nuevo.</p>`;
    return;
  }

  if (!match) {
    winnerResult.innerHTML = `<p class="winner-empty">El número <strong>${num}</strong> no fue vendido a nadie en la rifa «${escapeHtml(raffle.name)}».</p>`;
    return;
  }

  const isVerified = match.status === "verificado";
  const dateText = match.createdAt?.toDate
    ? match.createdAt.toDate().toLocaleString("es-DO", { dateStyle: "short", timeStyle: "short" })
    : "";

  winnerResult.innerHTML = `
    <div class="winner-card">
      <div class="winner-card-header">
        <span class="winner-number">${num}</span>
        <span class="ticket-status ${isVerified ? "verificado" : "pendiente"}">${isVerified ? "Verificado" : "Pendiente"}</span>
      </div>
      <div class="winner-info">
        <p><strong>${escapeHtml(match.fullName || "Sin nombre")}</strong> · ${escapeHtml(match.phone || "")}</p>
        <p>${escapeHtml(match.quantity || 0)} boletos · ${formatMoney(Number(match.total) || 0)} · ${escapeHtml(match.paymentMethod || "")} ${dateText ? "· " + escapeHtml(dateText) : ""}</p>
        <p>Rifa: ${escapeHtml(raffle.name)}</p>
      </div>
      ${!isVerified ? `<p class="winner-warning">⚠️ Esta compra todavía no está verificada. Confirma el pago antes de anunciar al ganador.</p>` : ""}
    </div>
  `;
}

winnerSearchBtn.addEventListener("click", searchWinner);
winnerNumberInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    searchWinner();
  }
});