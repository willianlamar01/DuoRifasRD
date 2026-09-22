// =====================================================================
// DuoRifa — Panel Admin
// =====================================================================
import { db, auth } from "./firebase-config.js";
import {
  signInWithEmailAndPassword, signOut, onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";
import {
  collection, onSnapshot, doc, updateDoc, deleteDoc, setDoc, arrayUnion,
  query, orderBy, increment
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";

const formatMoney = (n) => `RD$${(n || 0).toLocaleString("es-DO")}`;

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
let unsubscribeTickets = null;

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
// =====================================================================
function listenToTickets() {
  const q = query(collection(db, "tickets"), orderBy("createdAt", "desc"));
  unsubscribeTickets = onSnapshot(q, (snap) => {
    allTickets = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderStats();
    renderTickets();
    // Si ya había una búsqueda de ganador activa, la refrescamos con los
    // datos más recientes (por ejemplo, si el estado cambió a verificado)
    if (winnerResult && !winnerResult.hidden && winnerNumberInput.value.trim() !== "") {
      searchWinner();
    }
  }, (err) => {
    console.error(err);
    ticketsList.innerHTML = `<p class="admin-empty">Ocurrió un error cargando las compras.</p>`;
  });
}

function renderStats() {
  const pending = allTickets.filter((t) => t.status !== "verificado");
  const verified = allTickets.filter((t) => t.status === "verificado");
  const totalTickets = verified.reduce((sum, t) => sum + (t.quantity || 0), 0);

  statPending.textContent = pending.length;
  statVerified.textContent = verified.length;
  statTickets.textContent = totalTickets.toLocaleString("es-DO");
}

function renderTickets() {
  let filtered = allTickets;
  if (currentFilter === "pendiente") {
    filtered = allTickets.filter((t) => t.status !== "verificado");
  } else if (currentFilter === "verificado") {
    filtered = allTickets.filter((t) => t.status === "verificado");
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

    const numbersText = (t.ticketNumbers || []).join(", ");
    const dateText = t.createdAt?.toDate
      ? t.createdAt.toDate().toLocaleString("es-DO", { dateStyle: "short", timeStyle: "short" })
      : "";

    card.innerHTML = `
      <img class="ticket-thumb" src="${t.proofImage || ""}" alt="Comprobante de ${t.fullName || "cliente"}" data-img="${t.proofImage || ""}">
      <div class="ticket-info">
        <div class="ticket-name">${escapeHtml(t.fullName || "Sin nombre")} · ${escapeHtml(t.phone || "")}</div>
        <div class="ticket-meta">${t.quantity || 0} boletos · ${formatMoney(t.total)} · ${escapeHtml(t.paymentMethod || "")} ${dateText ? "· " + dateText : ""}</div>
        <div class="ticket-numbers">${numbersText}</div>
      </div>
      <div class="ticket-actions">
        <span class="ticket-status ${isVerified ? "verificado" : "pendiente"}">${isVerified ? "Verificado" : "Pendiente"}</span>
        ${isVerified
          ? `<button class="btn btn-unverify" data-id="${t.id}" data-action="unverify">Deshacer</button>`
          : `<button class="btn btn-verify" data-id="${t.id}" data-action="verify">Verificar</button>`
        }
        <button class="btn btn-reject" data-id="${t.id}" data-action="reject">Eliminar</button>
      </div>
    `;

    card.querySelector(".ticket-thumb").addEventListener("click", (e) => {
      const src = e.target.getAttribute("data-img");
      if (src) openProofModal(src);
    });

    ticketsList.appendChild(card);
  });

  ticketsList.querySelectorAll("[data-action]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const action = btn.dataset.action;
      if (action === "reject") {
        handleReject(btn.dataset.id);
      } else {
        handleStatusChange(btn.dataset.id, action);
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
// =====================================================================
async function handleStatusChange(ticketId, action) {
  const ticket = allTickets.find((t) => t.id === ticketId);
  if (!ticket) return;

  const newStatus = action === "verify" ? "verificado" : "pendiente";
  const qty = ticket.quantity || 0;

  try {
    await updateDoc(doc(db, "tickets", ticketId), { status: newStatus });

    const statsRef = doc(db, "raffle", "stats");
    await setDoc(
      statsRef,
      { verifiedCount: increment(action === "verify" ? qty : -qty) },
      { merge: true }
    );
  } catch (err) {
    console.error(err);
    alert("No se pudo actualizar el estado. Intenta de nuevo.");
  }
}

// =====================================================================
// ELIMINAR COMPRA FRAUDULENTA
// Borra el ticket por completo y libera sus números en la "bolsa"
// (raffle/releasedNumbers) para que un comprador real los pueda recibir
// en su próxima compra. Ver reserveTicketNumbers() en script.js.
// Si el ticket eliminado ya estaba marcado como "verificado", también
// se descuenta del contador público verifiedCount, para que el
// progreso siga siendo exacto.
// =====================================================================
async function handleReject(ticketId) {
  const ticket = allTickets.find((t) => t.id === ticketId);
  if (!ticket) return;

  const numbersText = (ticket.ticketNumbers || []).join(", ");
  const confirmMsg =
    `¿Eliminar esta compra por completo?\n\n` +
    `${ticket.fullName || "Sin nombre"} · ${ticket.phone || ""}\n` +
    `Números: ${numbersText}\n\n` +
    `Esta acción NO se puede deshacer. Los números quedarán disponibles ` +
    `para asignarse a otro comprador en una próxima compra.`;

  if (!confirm(confirmMsg)) return;

  try {
    // 1. Liberar los números a la bolsa (se crea el documento si no existe)
    const poolRef = doc(db, "raffle", "releasedNumbers");
    await setDoc(
      poolRef,
      { numbers: arrayUnion(...(ticket.ticketNumbers || [])) },
      { merge: true }
    );

    // 2. Si ya estaba verificado, descontarlo del progreso público
    if (ticket.status === "verificado") {
      const statsRef = doc(db, "raffle", "stats");
      await setDoc(
        statsRef,
        { verifiedCount: increment(-(ticket.quantity || 0)) },
        { merge: true }
      );
    }

    // 3. Borrar el ticket fraudulento
    await deleteDoc(doc(db, "tickets", ticketId));
  } catch (err) {
    console.error(err);
    alert("No se pudo eliminar la compra. Intenta de nuevo.");
  }
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
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
// lo que el admin escriba (solo dígitos, rellenado a 5) antes de buscar
// dentro de allTickets, que ya viene en vivo desde listenToTickets().
// =====================================================================
function formatWinnerNumber(raw) {
  const digits = (raw || "").replace(/\D/g, "");
  if (!digits) return null;
  return digits.padStart(5, "0").slice(-5);
}

function searchWinner() {
  const num = formatWinnerNumber(winnerNumberInput.value);
  winnerResult.hidden = false;

  if (!num) {
    winnerResult.innerHTML = `<p class="winner-empty">Escribe un número de boleto válido.</p>`;
    return;
  }

  const match = allTickets.find((t) => (t.ticketNumbers || []).includes(num));

  if (!match) {
    winnerResult.innerHTML = `<p class="winner-empty">El número <strong>${num}</strong> no fue vendido a nadie.</p>`;
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
        <p><strong>${escapeHtml(match.fullName || "Sin nombre")}</strong> · ${match.phone || ""}</p>
        <p>${match.quantity || 0} boletos · ${formatMoney(match.total)} · ${escapeHtml(match.paymentMethod || "")} ${dateText ? "· " + dateText : ""}</p>
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