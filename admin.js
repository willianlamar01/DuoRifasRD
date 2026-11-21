// =====================================================================
// DuoRifa — Panel Admin (varias rifas; ver raffles-config.js)
// =====================================================================
import { db, auth } from "./firebase-config.js";
import {
  signInWithEmailAndPassword, signOut, onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";
import {
  collection, onSnapshot, doc, runTransaction, arrayUnion, arrayRemove,
  query, orderBy, increment
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import { RAFFLES, raffleOf } from "./raffles-config.js";

const formatMoney = (n) => `RD$${(n || 0).toLocaleString("es-DO")}`;

// Escapa TODO texto que viene de la base de datos antes de mostrarlo.
// Los clientes controlan lo que guardan en Firestore (nombre, teléfono,
// números, etc.), así que nunca se debe insertar como HTML sin escapar.
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
// (ej.: rdoc(RAFFLES.iphone, "stats") -> raffle/stats_iphone)
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

let allTickets = [];
let currentFilter = "pendiente";
let currentRaffleId = Object.keys(RAFFLES)[0]; // rifa que se está viendo
let unsubscribeTickets = null;

// Compras de la rifa elegida. Las compras viejas, que no tienen
// raffleId, cuentan como Kia (ver raffleOf en raffles-config.js).
const ticketsOfCurrentRaffle = () =>
  allTickets.filter((t) => raffleOf(t).id === currentRaffleId);

// =====================================================================
// SELECTOR DE RIFA
// Se crea desde aquí, así que no hace falta tocar admin.html.
// Va justo encima de las pestañas.
// =====================================================================
(function buildRaffleSelector() {
  const anchor = tabs[0]?.parentElement;
  if (!anchor) return;

  const wrap = document.createElement("div");
  wrap.style.cssText =
    "display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:0 0 14px;";

  const label = document.createElement("label");
  label.htmlFor = "raffleSelect";
  label.textContent = "Rifa:";
  label.style.cssText = "font-weight:700;";

  const select = document.createElement("select");
  select.id = "raffleSelect";
  select.style.cssText =
    "padding:10px 12px;border-radius:10px;font:inherit;max-width:100%;";
  Object.values(RAFFLES).forEach((r) => {
    const opt = document.createElement("option");
    opt.value = r.id;
    opt.textContent = r.name;
    select.appendChild(opt);
  });
  select.value = currentRaffleId;
  select.addEventListener("change", () => {
    currentRaffleId = select.value;
    renderStats();
    renderTickets();
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
    // onAuthStateChanged se encarga de mostrar el panel
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
    listenToTickets();
  } else {
    loginScreen.hidden = false;
    panelScreen.hidden = true;
    if (unsubscribeTickets) { unsubscribeTickets(); unsubscribeTickets = null; }
  }
});

// =====================================================================
// LISTAR COMPRAS EN VIVO
// Se escuchan TODAS las compras (de todas las rifas) y se filtran por
// la rifa elegida en el selector.
// =====================================================================
function listenToTickets() {
  const q = query(collection(db, "tickets"), orderBy("createdAt", "desc"));
  unsubscribeTickets = onSnapshot(q, (snap) => {
    allTickets = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderStats();
    renderTickets();
    // Si ya había una búsqueda de ganador activa, la refrescamos con los
    // datos más recientes (por ejemplo, si el estado cambió a verificado)
    refreshWinnerSearch();
  }, (err) => {
    console.error(err);
    ticketsList.innerHTML = `<p class="admin-empty">Ocurrió un error cargando las compras.</p>`;
  });
}

function renderStats() {
  const mine = ticketsOfCurrentRaffle();
  const pending = mine.filter((t) => t.status !== "verificado");
  const verified = mine.filter((t) => t.status === "verificado");
  const totalTickets = verified.reduce((sum, t) => sum + (t.quantity || 0), 0);

  statPending.textContent = pending.length;
  statVerified.textContent = verified.length;
  statTickets.textContent = totalTickets.toLocaleString("es-DO");
}

function renderTickets() {
  const mine = ticketsOfCurrentRaffle();
  // Cualquier pestaña que no sea Pendientes o Verificados muestra todas
  let filtered = mine;
  if (currentFilter === "pendiente") {
    filtered = mine.filter((t) => t.status !== "verificado");
  } else if (currentFilter === "verificado") {
    filtered = mine.filter((t) => t.status === "verificado");
  }

  if (filtered.length === 0) {
    ticketsList.innerHTML = `<p class="admin-empty">No hay compras en esta categoría.</p>`;
    return;
  }

  ticketsList.innerHTML = "";
  filtered.forEach((t) => {
    const isVerified = t.status === "verificado";
    const card = document.createElement("div");
    card.className = "ticket-card";

    const numbersText = (Array.isArray(t.ticketNumbers) ? t.ticketNumbers : []).join(", ");
    const dateText = t.createdAt?.toDate
      ? t.createdAt.toDate().toLocaleString("es-DO", { dateStyle: "short", timeStyle: "short" })
      : "";
    const safeId = escapeHtml(t.id);

    // Todo texto de la base de datos pasa por escapeHtml
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

    // La imagen se crea con el DOM (no con HTML en texto), y solo si es data:image/
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
      if (action === "reject") {
        handleReject(btn.dataset.id);
      } else {
        handleStatusChange(btn.dataset.id, action, btn);
      }
    });
  });
}

// =====================================================================
// VERIFICAR / DESHACER
// El contador público "verifiedCount" (el que alimenta la barra de
// progreso que ve todo el mundo) SOLO se mueve aquí: sube al verificar
// una compra, baja si se deshace. Así el progreso reflejado es siempre
// de ventas reales confirmadas, nunca de simples intentos de compra
// (que pueden incluir fraudes). El contador "soldCount" en script.js
// sigue siendo un contador interno aparte, usado solo para repartir
// números de boleto sin choques.
//
// Cada compra actualiza el contador de SU rifa (según su raffleId; las
// compras viejas sin raffleId cuentan como Kia): Kia -> raffle/stats,
// iPhone -> raffle/stats_iphone.
//
// Se hace dentro de una transacción: el estado del ticket y el contador
// cambian juntos o no cambian, y si se hace doble clic no se cuenta dos
// veces (si el ticket ya está en el estado pedido, no se hace nada).
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
      if (data.status === newStatus) return; // ya estaba así

      const qty = Number.isInteger(data.quantity) ? data.quantity : 0;
      const r = raffleOf(data);

      transaction.update(ticketRef, { status: newStatus });
      transaction.set(
        rdoc(r, "stats"),
        { verifiedCount: increment(newStatus === "verificado" ? qty : -qty) },
        { merge: true }
      );
    });
  } catch (err) {
    console.error(err);
    alert("No se pudo actualizar el estado. Intenta de nuevo.");
    if (btn) btn.disabled = false;
  }
}

// =====================================================================
// ELIMINAR COMPRA FRAUDULENTA
// En UNA sola transacción, y siempre dentro de la rifa de la compra:
//  1. Libera sus números a la bolsa de esa rifa (releasedNumbers) para
//     que un comprador real los reciba en su próxima compra (solo
//     números válidos de 5 dígitos, por si el ticket traía datos raros).
//  2. Si estaba verificado, lo descuenta del progreso público de esa rifa.
//  3. Si tenía números bendecidos DE ESA RIFA, los quita de su documento
//     blessed para que dejen de verse tachados.
//  4. Borra el ticket.
// Si algo falla, no se aplica nada (antes los números podían quedar
// liberados con el ticket todavía existiendo).
// =====================================================================
async function handleReject(ticketId) {
  const ticket = allTickets.find((t) => t.id === ticketId);
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
        transaction.set(
          rdoc(r, "released"),
          { numbers: arrayUnion(...numbers) },
          { merge: true }
        );
      }

      if (data.status === "verificado" && Number.isInteger(data.quantity)) {
        transaction.set(
          rdoc(r, "stats"),
          { verifiedCount: increment(-data.quantity) },
          { merge: true }
        );
      }

      if (blessedToFree.length > 0) {
        transaction.set(
          rdoc(r, "blessed"),
          { claimed: arrayRemove(...blessedToFree) },
          { merge: true }
        );
      }

      transaction.delete(ticketRef);
    });
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
    renderTickets();
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
// Los números se guardan como texto de 5 dígitos con ceros a la
// izquierda (ver formatTicket() en script.js), así que aquí normalizamos
// lo que el admin escriba (solo dígitos, rellenado a 5) antes de buscar.
// La búsqueda es SOLO dentro de la rifa elegida: las dos rifas usan
// números de 00000 a 99999, así que el mismo número puede existir en
// ambas y pertenecer a compradores distintos.
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

function searchWinner() {
  const num = formatWinnerNumber(winnerNumberInput.value);
  const raffle = RAFFLES[currentRaffleId];
  winnerResult.hidden = false;

  if (!num) {
    winnerResult.innerHTML = `<p class="winner-empty">Escribe un número de boleto válido.</p>`;
    return;
  }

  const match = ticketsOfCurrentRaffle().find(
    (t) => Array.isArray(t.ticketNumbers) && t.ticketNumbers.includes(num)
  );

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