// =====================================================================
// DuoRifa — script principal (varias rifas; ver raffles-config.js)
// =====================================================================
import { db } from "./firebase-config.js";
import {
  doc, runTransaction, collection, addDoc, getDocs, query, where,
  serverTimestamp, onSnapshot, setDoc, arrayUnion
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import { RAFFLES, raffleOf } from "./raffles-config.js";

// ------------------- DATOS DE CONTACTO Y PAGO -------------------
const WHATSAPP_NUMBER = "18295639146";
const PAYMENT_INFO = {
  popular:     { bank: "Banco Popular", accountLabel: "Cuenta de ahorros", account: "859101834",   name: "Ángel Daniel Lagares", cedula: "402-0925011-3" },
  banreservas: { bank: "BanReservas",   accountLabel: "Cuenta de ahorros", account: "9607997324",  name: "Ángel Daniel Lagares", cedula: "402-0925011-3" },
  bhd:         { bank: "Banco BHD",     accountLabel: "Cuenta de ahorros", account: "38406780016", name: "Ángel Daniel Lagares", cedula: "402-0925011-3" },
  qik:         { bank: "Qik",           accountLabel: "Cuenta de ahorros", account: "1013257082",  name: "Ángel Daniel Lagares", cedula: "402-0925011-3" },
  paypal:      { bank: "PayPal",        accountLabel: "Usuario", account: "@AngelLagares592", name: null, cedula: null },
  efectivo:    { bank: "Pago en efectivo", note: "Coordina la entrega con: Ángel Daniel Lagares" }
};

// ------------------- UTILIDADES -------------------
const $ = (id) => document.getElementById(id);
const formatMoney = (n) => `RD$${n.toLocaleString("es-DO")}`;
const formatTicket = (n) => String(n).padStart(5, "0");

// Deja solo dígitos y quita el 1 inicial (código de país) si viene con él
const normalizePhone = (p) => {
  let d = String(p).replace(/\D/g, "");
  if (d.length === 11 && d.startsWith("1")) d = d.slice(1);
  return d;
};

// Referencia a un documento de configuración de una rifa
// (ej.: rdoc(RAFFLES.iphone, "stats") -> raffle/stats_iphone)
const rdoc = (r, k) => doc(db, "raffle", r.docs[k]);

// Chip de un número de boleto; los bendecidos de SU rifa llevan 🍀
const ticketChipHtml = (n, r) => r.blessed.includes(n)
  ? `<span class="ticket-chip ticket-chip-blessed">🍀 ${n}</span>`
  : `<span class="ticket-chip">${n}</span>`;

// Estado de la compra en curso
let R = RAFFLES.kia;            // rifa que el cliente está comprando
let selectedQty = 0, selectedMethod = null, proofFile = null;
let lastTicketNumbers = [], lastPurchaseInfo = null;

//numeros que salieron bendecidos de la rifa kia (para que no se puedan volver a asignar) new Set(['00120', '00121', '...' ])
// Lista negra manual: números que ya salieron. Para tachar uno, agrégalo aquí.
const manuales = { kia: [], iphone: [] };
const claimed  = { kia: new Set(manuales.kia), iphone: new Set(manuales.iphone) };  // raffleId -> Set de bendecidos ya asignados

// Copia texto al portapapeles. Si el navegador no tiene la API moderna
// (o la página no es segura), usa el método antiguo con un textarea.
function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) {
    return navigator.clipboard.writeText(text);
  }
  return new Promise((resolve, reject) => {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.cssText = "position:fixed;top:0;left:0;opacity:0;";
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand("copy") ? resolve() : reject(new Error("copy failed")); }
    catch (err) { reject(err); }
    finally { ta.remove(); }
  });
}

// Reduce la foto del comprobante para guardarla en Firestore (base64)
function compressImageToBase64(file, maxWidth = 900, quality = 0.6) {
  return new Promise((resolve, reject) => {
    const img = new Image(), reader = new FileReader();
    reader.onload = (e) => { img.src = e.target.result; };
    reader.onerror = reject;
    img.onload = () => {
      const s = Math.min(1, maxWidth / img.width), c = document.createElement("canvas");
      c.width = img.width * s; c.height = img.height * s;
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      resolve(c.toDataURL("image/jpeg", quality));
    };
    img.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// =====================================================================
// TARJETAS DE RIFAS
// Se dibujan desde raffles-config.js: una tarjeta por rifa.
// "tags" (opcional) son los distintivos de la rifa, ej. "1er premio · Kia 2020".
// =====================================================================
function renderCards() {
  $("raffleGrid").innerHTML = Object.values(RAFFLES).map((r) => `
    <article class="rc">
      <div class="rc-img"><img src="${r.img}" alt="${r.name}"><span class="rc-badge">${r.badge}</span></div>
      ${(r.tags || []).length ? `<div class="rc-tags">${r.tags.map((t) => `<span>${t}</span>`).join("")}</div>` : ""}
      <div class="rc-prize"><span>Si te sale uno de estos números te ganas</span><strong>${formatMoney(r.prize)}</strong></div>
      <p class="rc-counts" id="rc-counts-${r.id}"></p>
      <div class="rc-nums" id="rc-nums-${r.id}"></div>
      <div class="rc-body">
        <h3>${r.name}</h3>
        <p class="rc-desc">${r.desc}</p>
        <p class="rc-draw" id="rc-draw-${r.id}" hidden>Sorteo: ${r.draw}</p>
        <div class="rc-prog"><span>Progreso: <b id="rc-pct-${r.id}">0%</b></span><div class="rc-track"><i id="rc-fill-${r.id}"></i></div></div>
        <div class="rc-buy"><div><strong>${formatMoney(r.price)}</strong><small>Mín. ${r.min} boletos</small></div>
          <button type="button" class="btn btn-primary btn-neon" data-raffle="${r.id}">Jugar</button></div>
      </div>
    </article>`).join("");

  // Botón "Jugar": abre la compra de ESA rifa
  document.querySelectorAll("[data-raffle]").forEach((b) =>
    b.addEventListener("click", () => openBuyModal(b.dataset.raffle)));
}

// Números bendecidos de una rifa: los ya asignados salen tachados
function renderBlessed(r) {
  const c = claimed[r.id] || new Set();
  const blessedHtml = r.blessed.map((n) => c.has(n) === true
    ? `<span class="rc-num out" title="Ya fue asignado">${n}<small>Salió</small></span>`
    : `<span class="rc-num">${n}</span>`).join("");

  $(`rc-nums-${r.id}`).innerHTML = blessedHtml;
  const out = r.blessed.filter((n) => c.has(n)).length;
  $(`rc-counts-${r.id}`).textContent = `${r.blessed.length - out} disponibles · ${out} ya salieron`;
}

// Barra de progreso. La fecha del sorteo aparece al llegar al 80%
function updateProgress(r, n) {
  const pct = Math.min(100, (n / r.total) * 100);
  $(`rc-pct-${r.id}`).textContent = `${Math.floor(pct)}%`;
  $(`rc-fill-${r.id}`).style.width = `${pct}%`;
  $(`rc-draw-${r.id}`).hidden = pct < 80;
}

// Escucha en vivo el progreso y los bendecidos de una rifa
function listen(r) {
  onSnapshot(rdoc(r, "blessed"), (s) => {
    claimed[r.id] = new Set(s.exists() ? s.data().claimed || [] : []);
  }, console.error);
  onSnapshot(rdoc(r, "stats"), (s) =>
    updateProgress(r, s.exists() ? s.data().verifiedCount || 0 : 0), console.error);
}

// Marca como "ya salidos" los bendecidos que tocaron en una compra
async function claimBlessedNumbers(nums, r) {
  const won = nums.filter((n) => r.blessed.includes(n));
  if (!won.length) return;
  try { await setDoc(rdoc(r, "blessed"), { claimed: arrayUnion(...won) }, { merge: true }); }
  catch (err) { console.error("No se pudieron marcar los números bendecidos:", err); }
}

// =====================================================================
// RESERVA DE NÚMEROS (por rifa)
// Generador congruencial de ciclo completo: reparte los 100,000 números
// sin repetir dentro de cada rifa. Cada rifa tiene su contador
// (soldCount) y su bolsa de números reciclados (released).
// =====================================================================
const numberForIndex = (i, r) => (r.lcg[0] * i + r.lcg[1]) % r.total;

async function reserveTicketNumbers(qty, r) {
  const counterRef = rdoc(r, "stats"), releasedRef = rdoc(r, "released");
  let numbers = [];
  await runTransaction(db, async (tx) => {
    // 1) Primero se usan los números liberados (compras eliminadas)
    const rs = await tx.get(releasedRef);
    const pool = rs.exists() ? rs.data().numbers || [] : [];
    const reused = pool.slice(0, qty), rest = pool.slice(reused.length), need = qty - reused.length;
    // 2) Si faltan, se generan nuevos a partir del contador
    const fresh = [];
    if (need > 0) {
      const cs = await tx.get(counterRef);
      const cur = cs.exists() ? cs.data().soldCount || 0 : 0;
      if (cur + need > r.total) throw new Error("No quedan suficientes boletos disponibles.");
      for (let i = 0; i < need; i++) fresh.push(formatTicket(numberForIndex(cur + i, r)));
      tx.set(counterRef, { soldCount: cur + need }, { merge: true });
    }
    tx.set(releasedRef, { numbers: rest }, { merge: true });
    numbers = [...reused, ...fresh];
  });
  return numbers;
}

// =====================================================================
// MODAL DE COMPRA
// =====================================================================
const buyModal = $("buyModal"), stepQuantity = $("stepQuantity"), stepForm = $("stepForm"), stepConfirm = $("stepConfirm");
const qtyOptions = $("qtyOptions"), qtyCustom = $("qtyCustom"), goToFormBtn = $("goToFormBtn");
const closeBuyModal = () => { buyModal.hidden = true; document.body.classList.remove("modal-open"); };
$("buyModalBackdrop").addEventListener("click", closeBuyModal);
$("buyModalClose").addEventListener("click", closeBuyModal);
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !buyModal.hidden) closeBuyModal(); });

// Fija la cantidad y recalcula el total de la rifa actual
function setQuantity(q) {
  q = Math.max(0, Math.min(R.max, Math.floor(q || 0)));
  selectedQty = q;
  $("selectedQty").textContent = q.toLocaleString("es-DO");
  $("totalAmount").textContent = formatMoney(q * R.price);
  goToFormBtn.disabled = q < R.min;
}

const clearActive = () => qtyOptions.querySelectorAll(".qty-btn").forEach((b) => {
  b.classList.remove("active"); b.setAttribute("aria-pressed", "false");
});

// Los botones de cantidad dependen de la rifa (cantidades y precio)
function renderQtyOptions() {
  qtyOptions.innerHTML = R.qtys.map((q) => `
    <button type="button" class="qty-btn" data-qty="${q}" aria-pressed="false">
      <span class="qty-btn-left"><span class="qty-btn-num">${q}</span><span class="qty-btn-label">boletos</span></span>
      <span class="qty-btn-right"><span class="qty-btn-price">${formatMoney(q * R.price)}</span><span class="qty-btn-indicator" aria-hidden="true"></span></span>
    </button>`).join("");
}

// Un solo manejador para todos los botones de cantidad
qtyOptions.addEventListener("click", (e) => {
  const btn = e.target.closest(".qty-btn");
  if (!btn) return;
  clearActive(); btn.classList.add("active"); btn.setAttribute("aria-pressed", "true");
  qtyCustom.value = ""; setQuantity(parseInt(btn.dataset.qty, 10));
  // Animación al tocar; se limpia sola cuando termina
  btn.classList.remove("tap-effect"); void btn.offsetWidth; btn.classList.add("tap-effect");
  btn.addEventListener("animationend", () => btn.classList.remove("tap-effect"), { once: true });
});

qtyCustom.addEventListener("input", () => {
  clearActive();
  const v = parseInt(qtyCustom.value, 10);
  setQuantity(isNaN(v) ? 0 : v);
});
// Al salir del campo, la cantidad se ajusta al mínimo y máximo de la rifa
qtyCustom.addEventListener("blur", () => {
  let v = parseInt(qtyCustom.value, 10);
  if (isNaN(v)) return;
  v = Math.max(R.min, Math.min(R.max, v)); qtyCustom.value = v; setQuantity(v);
});

function resetPurchase() {
  $("purchaseForm").reset(); $("proofPreview").hidden = true; proofFile = null;
  $("proofFileName").textContent = "Ningún archivo seleccionado";
  selectedMethod = null;
  document.querySelectorAll(".pm-btn").forEach((b) => b.classList.remove("active"));
  $("paymentDetails").hidden = true; qtyCustom.value = "";
  renderQtyOptions(); setQuantity(0);
}

// Abre la compra de una rifa: cantidades, precio y mínimo son los de ELLA
function openBuyModal(id) {
  R = RAFFLES[id]; resetPurchase();
  $("buyRaffleName").textContent = R.name; $("qtyMinLabel").textContent = R.min;
  qtyCustom.min = R.min; qtyCustom.max = R.max;
  stepForm.hidden = stepConfirm.hidden = true; stepQuantity.hidden = false;
  buyModal.hidden = false; document.body.classList.add("modal-open");
}

goToFormBtn.addEventListener("click", () => {
  $("confirmQty").textContent = selectedQty.toLocaleString("es-DO");
  $("confirmTotal").textContent = formatMoney(selectedQty * R.price);
  stepQuantity.hidden = true; stepForm.hidden = false;
  stepForm.scrollIntoView({ behavior: "smooth", block: "start" });
});
$("backToQtyBtn").addEventListener("click", () => { stepForm.hidden = true; stepQuantity.hidden = false; });

// =====================================================================
// MÉTODO DE PAGO
// =====================================================================
const paymentDetails = $("paymentDetails");
document.querySelectorAll(".pm-btn").forEach((btn) => btn.addEventListener("click", () => {
  document.querySelectorAll(".pm-btn").forEach((b) => b.classList.remove("active"));
  btn.classList.add("active"); selectedMethod = btn.dataset.method;
  paymentDetails.hidden = false; renderPaymentDetails(selectedMethod);
}));

function renderPaymentDetails(method) {
  const i = PAYMENT_INFO[method];
  if (!i) { paymentDetails.innerHTML = ""; return; }
  if (method === "efectivo") {
    paymentDetails.innerHTML = `<div class="pd-row"><span class="pd-label">Método</span><span class="pd-value">${i.bank}</span></div><p class="pd-note">${i.note}</p>`;
    return;
  }
  const row = (l, v) => `<div class="pd-row"><span class="pd-label">${l}</span><span class="pd-value">${v}</span></div>`;
  paymentDetails.innerHTML = row("Banco", i.bank) + `
    <div class="pd-row"><span class="pd-label">${i.accountLabel}</span>
      <span class="pd-value-copy"><span class="pd-value pd-value-mono">${i.account}</span>
      <button type="button" class="pd-copy-btn" data-copy="${i.account}">Copiar</button></span></div>`
    + (i.name ? row("A nombre de", i.name) : "") + (i.cedula ? row("Cédula", i.cedula) : "");

  // Botón "Copiar" (con respaldo para navegadores viejos)
  const b = paymentDetails.querySelector(".pd-copy-btn");
  b.addEventListener("click", () => {
    copyText(b.dataset.copy).then(() => {
      b.textContent = "¡Copiado!"; b.classList.add("copied");
      setTimeout(() => { b.textContent = "Copiar"; b.classList.remove("copied"); }, 1500);
    }).catch(() => alert("No se pudo copiar. Número: " + b.dataset.copy));
  });
}
const paymentMethodLabel = (m) => PAYMENT_INFO[m]?.bank || m;

// Foto del comprobante + vista previa
$("proofFile").addEventListener("change", (e) => {
  const f = e.target.files[0];
  if (!f) { $("proofFileName").textContent = "Ningún archivo seleccionado"; return; }
  proofFile = f; $("proofFileName").textContent = f.name;
  const rd = new FileReader();
  rd.onload = (ev) => { $("proofPreview").src = ev.target.result; $("proofPreview").hidden = false; };
  rd.readAsDataURL(f);
});

// =====================================================================
// ENVÍO DE LA COMPRA
// Se guarda con raffleId para que cada rifa cuente por separado.
// Si algo falla después de reservar los números, se devuelven a la bolsa.
// =====================================================================
const submitBtn = $("submitPurchaseBtn");
$("purchaseForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const fullName = $("fullName").value.trim(), phone = normalizePhone($("phone").value);
  if (!fullName) return alert("Escribe tu nombre completo.");
  if (phone.length < 10) return alert("Escribe un número de teléfono válido.");
  if (!selectedMethod) return alert("Elige un método de pago.");
  if (!proofFile) return alert("Sube la foto de tu comprobante de pago.");
  if (selectedQty < R.min || selectedQty > R.max)
    return alert(`La cantidad de boletos debe estar entre ${R.min} y ${R.max.toLocaleString("es-DO")}.`);

  submitBtn.disabled = true; submitBtn.textContent = "Procesando...";
  const r = R; let ticketNumbers = null;   // r fija la rifa aunque el modal cambie
  try {
    const proofBase64 = await compressImageToBase64(proofFile);
    if (proofBase64.length > 900000) throw new Error("La imagen del comprobante es muy grande. Intenta con una foto más pequeña o una captura de pantalla.");
    ticketNumbers = await reserveTicketNumbers(selectedQty, r);
    const total = selectedQty * r.price;
    await addDoc(collection(db, "tickets"), {
      raffleId: r.id, fullName, phone, quantity: selectedQty, total, paymentMethod: selectedMethod,
      ticketNumbers, proofImage: proofBase64, status: "pendiente", createdAt: serverTimestamp()
    });
    await claimBlessedNumbers(ticketNumbers, r);
    lastTicketNumbers = ticketNumbers;
    lastPurchaseInfo = { fullName, phone, quantity: selectedQty, total, paymentMethod: selectedMethod, raffle: r };
    showConfirmation();
  } catch (err) {
    console.error(err);
    if (ticketNumbers) {
      try { await setDoc(rdoc(r, "released"), { numbers: arrayUnion(...ticketNumbers) }, { merge: true }); }
      catch (re) { console.error("No se pudieron liberar los números:", re); }
    }
    alert("Hubo un problema registrando tu compra. Por favor intenta de nuevo. " + (err.message || ""));
  } finally {
    submitBtn.disabled = false; submitBtn.textContent = "Ya realicé el pago";
  }
});

function showConfirmation() {
  const p = lastPurchaseInfo;
  stepForm.hidden = true; stepConfirm.hidden = false;
  stepConfirm.scrollIntoView({ behavior: "smooth", block: "start" });
  $("confirmTicketNumbers").innerHTML = lastTicketNumbers.map((n) => ticketChipHtml(n, p.raffle)).join("");
  const msg = encodeURIComponent(
    `Hola, soy ${p.fullName}.\nAcabo de comprar ${p.quantity} boletos de la rifa "${p.raffle.name}" por un total de ${formatMoney(p.total)}.\n` +
    `Método de pago: ${paymentMethodLabel(p.paymentMethod)}.\nMi número de teléfono: ${p.phone}.\nAdjunto mi comprobante de pago.`);
  $("sendProofWhatsapp").href = `https://wa.me/${WHATSAPP_NUMBER}?text=${msg}`;
}
$("newPurchaseBtn").addEventListener("click", () => {
  resetPurchase(); stepConfirm.hidden = true; stepQuantity.hidden = false;
  stepQuantity.scrollIntoView({ behavior: "smooth", block: "start" });
});

// =====================================================================
// VERIFICAR BOLETO POR TELÉFONO
// El cliente elige la rifa. Las compras viejas (sin raffleId) cuentan como Kia.
// =====================================================================
const verifyResults = $("verifyResults");
const verifyRaffle = $("verifyRaffle");
verifyRaffle.innerHTML = Object.values(RAFFLES)
  .map((r) => `<option value="${r.id}">${r.name}</option>`).join("");

$("verifyForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const phone = normalizePhone($("verifyPhone").value);
  const chosen = RAFFLES[verifyRaffle.value];
  if (phone.length < 10) return alert("Escribe un número de teléfono válido.");
  verifyResults.hidden = false; verifyResults.innerHTML = "<p>Buscando tus boletos...</p>";
  try {
    const snap = await getDocs(query(collection(db, "tickets"), where("phone", "in", [phone, "1" + phone])));
    const mine = snap.docs.filter((s) => raffleOf(s.data()).id === chosen.id);
    if (!mine.length) {
      verifyResults.innerHTML = `<p>No encontramos compras de la rifa "${chosen.name}" con ese número de teléfono. Si compraste en otra rifa, cámbiala arriba.</p>`;
      return;
    }
    verifyResults.innerHTML = "";
    mine.forEach((s) => {
      const d = s.data(), ok = d.status === "verificado";
      const item = document.createElement("div");
      item.className = "verify-item";
      item.innerHTML = `<div><strong>${d.quantity} boletos</strong> · ${formatMoney(d.total)} · ${chosen.name}
        <div class="ticket-numbers">${(d.ticketNumbers || []).map((n) => ticketChipHtml(n, chosen)).join("")}</div></div>
        <span class="verify-status ${ok ? "status-verificado" : "status-pendiente"}">${ok ? "Verificado" : "Pendiente (hasta 24h)"}</span>`;
      verifyResults.appendChild(item);
    });
  } catch (err) {
    console.error(err);
    verifyResults.innerHTML = "<p>Ocurrió un error al buscar tus boletos. Intenta de nuevo.</p>";
  }
});

// =====================================================================
// MENÚ MÓVIL
// =====================================================================
const navToggle = $("navToggle"), mainNav = $("mainNav");
navToggle.addEventListener("click", () => navToggle.setAttribute("aria-expanded", String(mainNav.classList.toggle("open"))));
mainNav.querySelectorAll("a").forEach((a) => a.addEventListener("click", () => {
  mainNav.classList.remove("open"); navToggle.setAttribute("aria-expanded", "false");
}));

// =====================================================================
// INICIO
// =====================================================================
renderCards();
Object.values(RAFFLES).forEach((r) => { renderBlessed(r); listen(r); });
setQuantity(0);

// =====================================================================
// VISOR DE IMAGEN (LIGHTBOX): galería de vehículos + tarjetas de rifa
// =====================================================================
(function () {
  const lb = $("lightbox"), img = $("lightboxImg");
  if (!lb || !img) return;
  const open = (el) => {
    img.src = el.src; img.alt = el.alt; lb.hidden = false;
    document.body.classList.add("modal-open");
  };
  const close = () => {
    lb.hidden = true; img.src = ""; document.body.classList.remove("modal-open");
  };

  // Galería de vehículos (se duplica para el carrusel continuo)
  const track = $("galleryTrack");
  if (track) {
    track.innerHTML += track.innerHTML;
    track.addEventListener("click", (e) => {
      const g = e.target.closest(".gallery-img");
      if (g) open(g);
    });
  }

  // Imagen de cada tarjeta de rifa (Kia, iPhone...)
  $("raffleGrid").addEventListener("click", (e) => {
    const p = e.target.closest(".rc-img img");
    if (p) open(p);
  });

  $("lightboxClose").addEventListener("click", close);
  lb.addEventListener("click", (e) => { if (e.target === lb) close(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !lb.hidden) close(); });
})();


// Lee en vivo los bendecidos de los Kia que ya salieron
export function escucharBendecidosKia(db, callback) {
  return onSnapshot(
    collection(db, "numerosbendeficosrifaki5"),
    (snap) => callback(snap.docs.map((d) => d.data().number)),
    (err) => console.error("No se pudo leer los bendecidos:", err)
  );
}