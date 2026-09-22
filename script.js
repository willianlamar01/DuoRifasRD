// =====================================================================
// DuoRifa — script principal
// =====================================================================
import { db } from "./firebase-config.js";
import {
  doc, runTransaction, collection, addDoc, getDocs, query, where,
  serverTimestamp, onSnapshot, setDoc, arrayUnion
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";

// ------------------- CONFIGURACIÓN GENERAL -------------------
const TICKET_PRICE = 50;          // RD$ por boleto
const MAX_TICKETS = 100000;       // total de números disponibles (00000-99999)
const MIN_QTY = 5;
const MAX_QTY_PER_PURCHASE = 2000; // ya no se limita a 100: el único techo real es la disponibilidad
const DRAW_DATE = "POR DEFINIR"; // TODO: reemplazar con la fecha real del sorteo
const WHATSAPP_NUMBER = "18295639146"; // Número real de contacto/soporte

// =====================================================================
// DATOS DE PAGO (estructurados por campo, para poder mostrarlos en
// líneas separadas y ofrecer el botón de "Copiar" en el número de cuenta)
// =====================================================================
const PAYMENT_INFO = {
  popular: {
    bank: "Banco Popular",
    accountLabel: "Cuenta de ahorros",
    account: "859101834",
    name: "Ángel Daniel Lagares",
    cedula: "402-0925011-3"
  },
  banreservas: {
    bank: "BanReservas",
    accountLabel: "Cuenta de ahorros",
    account: "9607997324",
    name: "Ángel Daniel Lagares",
    cedula: "402-0925011-3"
  },
  bhd: {
    bank: "Banco BHD",
    accountLabel: "Cuenta de ahorros",
    account: "38406780016",
    name: "Ángel Daniel Lagares",
    cedula: "402-0925011-3"
  },
  qik: {
    bank: "Qik",
    accountLabel: "Cuenta de ahorros",
    account: "1013257082",
    name: "Ángel Daniel Lagares",
    cedula: "402-0925011-3"
  },
  paypal: {
    bank: "PayPal",
    accountLabel: "Usuario",
    account: "@AngelLagares592",
    name: null,
    cedula: null
  },
  efectivo: {
    bank: "Pago en efectivo",
    note: "Coordina la entrega con: Ángel Daniel Lagares"
  }
};

// ------------------- ESTADO -------------------
let selectedQty = 0;
let selectedMethod = null;
let proofFileDataUrl = null;
let proofFile = null;
let lastTicketNumbers = [];
let lastPurchaseInfo = null;

// =====================================================================
// COMPRIMIR IMAGEN A BASE64 (para guardarla dentro del documento de
// Firestore, ya que NO se usa Firebase Storage). Un documento de
// Firestore soporta hasta 1MB, así que reducimos tamaño y calidad.
// =====================================================================
function compressImageToBase64(file, maxWidth = 900, quality = 0.6) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const reader = new FileReader();
    reader.onload = (e) => { img.src = e.target.result; };
    reader.onerror = reject;
    img.onload = () => {
      const scale = Math.min(1, maxWidth / img.width);
      const canvas = document.createElement("canvas");
      canvas.width = img.width * scale;
      canvas.height = img.height * scale;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL("image/jpeg", quality));
    };
    img.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// ------------------- HELPERS DE FORMATO -------------------
const formatMoney = (n) => `RD$${n.toLocaleString("es-DO")}`;
const formatTicket = (n) => String(n).padStart(5, "0");
const normalizePhone = (p) => p.replace(/\D/g, "");

// =====================================================================
// GENERADOR DE NÚMEROS ÚNICOS SIN REPETIR (00000–99999)
// Usa un generador congruencial lineal de ciclo completo: cada índice de
// 0 a 99,999 se transforma en un número "al azar" distinto, y como el
// ciclo cubre TODOS los valores exactamente una vez, nunca hay choques,
// sin necesidad de revisar boletos ya usados uno por uno.
// =====================================================================
function ticketNumberForIndex(index) {
  const m = MAX_TICKETS;   // 100000
  const a = 40501;         // cumple el teorema de Hull-Dobell para m=100000
  const c = 12347;         // coprimo con m
  return (a * index + c) % m;
}

// =====================================================================
// RESERVA DE NÚMEROS (con reciclaje de compras fraudulentas eliminadas)
// Primero usa los números que el admin haya liberado en "raffle/releasedNumbers"
// (por ejemplo, tras eliminar una compra fraudulenta) y solo genera números
// nuevos con el contador global si la bolsa de reciclados no alcanza.
// Todo ocurre dentro de una misma transacción atómica, así que nunca dos
// compradores pueden recibir el mismo número, ni siquiera si compran al
// mismo tiempo.
//
// IMPORTANTE: "soldCount" aquí es solo un contador INTERNO para repartir
// números sin choques — sube en cada intento de compra (incluso uno que
// termine siendo fraudulento). NO se usa para la barra de progreso
// pública; eso lo maneja un contador aparte, "verifiedCount", que solo
// sube cuando el admin verifica el pago (ver admin.js).
// =====================================================================
async function reserveTicketNumbers(qty) {
  const counterRef = doc(db, "raffle", "stats");
  const releasedRef = doc(db, "raffle", "releasedNumbers");
  let numbers = [];

  await runTransaction(db, async (transaction) => {
    // 1. Leer la bolsa de números reciclados (si existe)
    const releasedSnap = await transaction.get(releasedRef);
    const releasedPool = releasedSnap.exists() ? (releasedSnap.data().numbers || []) : [];

    // 2. Tomar primero de la bolsa lo que se pueda
    const reused = releasedPool.slice(0, qty);
    const remainingPool = releasedPool.slice(reused.length);
    const stillNeeded = qty - reused.length;

    // 3. Si no alcanza, generar los que falten con el contador de siempre
    let newNumbers = [];
    if (stillNeeded > 0) {
      const counterSnap = await transaction.get(counterRef);
      const current = counterSnap.exists() ? (counterSnap.data().soldCount || 0) : 0;

      if (current + stillNeeded > MAX_TICKETS) {
        throw new Error("No quedan suficientes boletos disponibles.");
      }

      for (let i = 0; i < stillNeeded; i++) {
        newNumbers.push(formatTicket(ticketNumberForIndex(current + i)));
      }
      transaction.set(counterRef, { soldCount: current + stillNeeded }, { merge: true });
    }

    // 4. Actualizar la bolsa, quitando los números que se acaban de usar
    transaction.set(releasedRef, { numbers: remainingPool }, { merge: true });

    numbers = [...reused, ...newNumbers];
  });

  return numbers;
}

// =====================================================================
// PROGRESO EN VIVO (todos los visitantes ven el mismo número)
// Lee "verifiedCount" — el contador que SOLO sube cuando el admin marca
// una compra como verificada, para que el % reflejado sea de ventas
// reales confirmadas y no de intentos de compra (incluyendo fraudes).
// =====================================================================
function listenToProgress() {
  const statsRef = doc(db, "raffle", "stats");
  onSnapshot(statsRef, (snap) => {
    const verified = snap.exists() ? (snap.data().verifiedCount || 0) : 0;
    updateProgressUI(verified);
  }, (err) => {
    console.error("No se pudo leer el progreso:", err);
  });
}

function updateProgressUI(sold) {
  const pct = Math.min(100, (sold / MAX_TICKETS) * 100);
  document.getElementById("progressPercent").textContent = `${pct.toFixed(1)}%`;
  document.getElementById("progressFill").style.width = `${pct}%`;
  document.getElementById("progressTrack").setAttribute("aria-valuenow", pct.toFixed(0));

  const note = document.getElementById("drawDateNote");
  if (pct >= 80) {
    document.getElementById("drawDateText").textContent = DRAW_DATE;
    note.hidden = false;
  } else {
    note.hidden = true;
  }
}

// =====================================================================
// MODAL DE COMPRA (abrir / cerrar)
// =====================================================================
const buyModal = document.getElementById("buyModal");
const buyModalBackdrop = document.getElementById("buyModalBackdrop");
const buyModalClose = document.getElementById("buyModalClose");
const navBuyBtn = document.getElementById("navBuyBtn");
const heroBuyBtn = document.getElementById("heroBuyBtn");

function openBuyModal() {
  buyModal.hidden = false;
  document.body.classList.add("modal-open");
}

function closeBuyModal() {
  buyModal.hidden = true;
  document.body.classList.remove("modal-open");
}

navBuyBtn.addEventListener("click", (e) => { e.preventDefault(); openBuyModal(); });
heroBuyBtn.addEventListener("click", (e) => { e.preventDefault(); openBuyModal(); });
buyModalBackdrop.addEventListener("click", closeBuyModal);
buyModalClose.addEventListener("click", closeBuyModal);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !buyModal.hidden) closeBuyModal();
});

// =====================================================================
// PASO 1: SELECCIÓN DE CANTIDAD
// =====================================================================
const qtyButtons = document.querySelectorAll(".qty-btn");
const qtyCustomInput = document.getElementById("qtyCustom");
const selectedQtyEl = document.getElementById("selectedQty");
const totalAmountEl = document.getElementById("totalAmount");
const goToFormBtn = document.getElementById("goToFormBtn");

function setQuantity(qty) {
  qty = Math.max(0, Math.min(MAX_QTY_PER_PURCHASE, Math.floor(qty || 0)));
  selectedQty = qty;
  selectedQtyEl.textContent = qty.toLocaleString("es-DO");
  totalAmountEl.textContent = formatMoney(qty * TICKET_PRICE);
  goToFormBtn.disabled = qty < MIN_QTY;
}

// Dispara el efecto de "sello" (tap-effect) en un botón de cantidad:
// se agrega la clase, se fuerza un reflow para poder reiniciar la
// animación aunque se clickee el mismo botón varias veces seguidas, y
// se quita la clase automáticamente cuando termina la animación
// "qtyTapPunch" (definida en styles.css), sin afectar el brillo
// constante que corre por separado.
function playTapEffect(btn) {
  btn.classList.remove("tap-effect");
  void btn.offsetWidth; // fuerza reinicio de la animación
  btn.classList.add("tap-effect");
  btn.addEventListener("animationend", function handler(e) {
    if (e.animationName === "qtyTapPunch") {
      btn.classList.remove("tap-effect");
      btn.removeEventListener("animationend", handler);
    }
  });
}

qtyButtons.forEach((btn) => {
  btn.addEventListener("click", () => {
    qtyButtons.forEach((b) => {
      b.classList.remove("active");
      b.setAttribute("aria-pressed", "false");
    });
    btn.classList.add("active");
    btn.setAttribute("aria-pressed", "true");
    qtyCustomInput.value = "";
    setQuantity(parseInt(btn.dataset.qty, 10));
    playTapEffect(btn);
  });
});

qtyCustomInput.addEventListener("input", () => {
  qtyButtons.forEach((b) => {
    b.classList.remove("active");
    b.setAttribute("aria-pressed", "false");
  });
  const val = parseInt(qtyCustomInput.value, 10);
  setQuantity(isNaN(val) ? 0 : val);
});

qtyCustomInput.addEventListener("blur", () => {
  if (qtyCustomInput.value === "") return;
  let val = parseInt(qtyCustomInput.value, 10);
  if (isNaN(val)) return;
  val = Math.max(MIN_QTY, Math.min(MAX_QTY_PER_PURCHASE, val));
  qtyCustomInput.value = val;
  setQuantity(val);
});

const stepQuantity = document.getElementById("stepQuantity");
const stepForm = document.getElementById("stepForm");
const stepConfirm = document.getElementById("stepConfirm");

goToFormBtn.addEventListener("click", () => {
  document.getElementById("confirmQty").textContent = selectedQty.toLocaleString("es-DO");
  document.getElementById("confirmTotal").textContent = formatMoney(selectedQty * TICKET_PRICE);
  stepQuantity.hidden = true;
  stepForm.hidden = false;
  stepForm.scrollIntoView({ behavior: "smooth", block: "start" });
});

document.getElementById("backToQtyBtn").addEventListener("click", () => {
  stepForm.hidden = true;
  stepQuantity.hidden = false;
});

// =====================================================================
// PASO 2: MÉTODO DE PAGO
// =====================================================================
const pmButtons = document.querySelectorAll(".pm-btn");
const paymentDetails = document.getElementById("paymentDetails");

pmButtons.forEach((btn) => {
  btn.addEventListener("click", () => {
    pmButtons.forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    selectedMethod = btn.dataset.method;
    paymentDetails.hidden = false;
    renderPaymentDetails(selectedMethod);
  });
});

// Construye la tarjeta de datos de pago en líneas separadas (banco, cuenta,
// nombre, cédula) y agrega el botón de "Copiar" junto al número de cuenta.
function renderPaymentDetails(method) {
  const info = PAYMENT_INFO[method];
  if (!info) {
    paymentDetails.innerHTML = "";
    return;
  }

  // Caso especial: efectivo no tiene número de cuenta que copiar
  if (method === "efectivo") {
    paymentDetails.innerHTML = `
      <div class="pd-row">
        <span class="pd-label">Método</span>
        <span class="pd-value">${info.bank}</span>
      </div>
      <p class="pd-note">${info.note}</p>
    `;
    return;
  }

  paymentDetails.innerHTML = `
    <div class="pd-row">
      <span class="pd-label">Banco</span>
      <span class="pd-value">${info.bank}</span>
    </div>
    <div class="pd-row">
      <span class="pd-label">${info.accountLabel}</span>
      <span class="pd-value-copy">
        <span class="pd-value pd-value-mono">${info.account}</span>
        <button type="button" class="pd-copy-btn" data-copy="${info.account}">Copiar</button>
      </span>
    </div>
    ${info.name ? `
    <div class="pd-row">
      <span class="pd-label">A nombre de</span>
      <span class="pd-value">${info.name}</span>
    </div>` : ""}
    ${info.cedula ? `
    <div class="pd-row">
      <span class="pd-label">Cédula</span>
      <span class="pd-value">${info.cedula}</span>
    </div>` : ""}
  `;

  const copyBtn = paymentDetails.querySelector(".pd-copy-btn");
  if (copyBtn) {
    copyBtn.addEventListener("click", () => copyToClipboard(copyBtn));
  }
}

// Copia el número de cuenta al portapapeles y muestra una confirmación
// visual breve en el mismo botón.
function copyToClipboard(btn) {
  const text = btn.dataset.copy;

  const showCopied = () => {
    const original = btn.textContent;
    btn.textContent = "¡Copiado!";
    btn.classList.add("copied");
    setTimeout(() => {
      btn.textContent = original;
      btn.classList.remove("copied");
    }, 1500);
  };

  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(showCopied).catch(() => {
      alert("No se pudo copiar automáticamente. Número: " + text);
    });
  } else {
    // Respaldo para navegadores muy antiguos sin la API Clipboard
    const tempInput = document.createElement("input");
    tempInput.value = text;
    document.body.appendChild(tempInput);
    tempInput.select();
    try {
      document.execCommand("copy");
      showCopied();
    } catch {
      alert("No se pudo copiar automáticamente. Número: " + text);
    }
    document.body.removeChild(tempInput);
  }
}

// Devuelve una línea de texto legible del método de pago, usada en el
// mensaje de WhatsApp de confirmación.
function paymentMethodLabel(method) {
  const info = PAYMENT_INFO[method];
  return info ? info.bank : method;
}

// ------------------- VISTA PREVIA DEL COMPROBANTE -------------------
const proofFileInput = document.getElementById("proofFile");
const proofPreview = document.getElementById("proofPreview");
const proofFileNameEl = document.getElementById("proofFileName");

proofFileInput.addEventListener("change", () => {
  const file = proofFileInput.files[0];
  if (!file) {
    proofFileNameEl.textContent = "Ningún archivo seleccionado";
    return;
  }
  proofFile = file;
  proofFileNameEl.textContent = file.name;
  const reader = new FileReader();
  reader.onload = (e) => {
    proofFileDataUrl = e.target.result;
    proofPreview.src = proofFileDataUrl;
    proofPreview.hidden = false;
  };
  reader.readAsDataURL(file);
});

// =====================================================================
// ENVÍO DE LA COMPRA
// =====================================================================
const purchaseForm = document.getElementById("purchaseForm");
const submitPurchaseBtn = document.getElementById("submitPurchaseBtn");

purchaseForm.addEventListener("submit", async (e) => {
  e.preventDefault();

  const fullName = document.getElementById("fullName").value.trim();
  const phone = normalizePhone(document.getElementById("phone").value);

  if (!fullName) { alert("Escribe tu nombre completo."); return; }
  if (phone.length < 10) { alert("Escribe un número de teléfono válido."); return; }
  if (!selectedMethod) { alert("Elige un método de pago."); return; }
  if (!proofFile) { alert("Sube la foto de tu comprobante de pago."); return; }
  if (selectedQty < MIN_QTY || selectedQty > MAX_QTY_PER_PURCHASE) {
    alert(`La cantidad de boletos debe estar entre ${MIN_QTY} y ${MAX_QTY_PER_PURCHASE.toLocaleString("es-DO")}.`);
    return;
  }

  submitPurchaseBtn.disabled = true;
  submitPurchaseBtn.textContent = "Procesando...";

  let ticketNumbers = null;

  try {
    // 1. Comprimir la foto y validar su tamaño ANTES de reservar números
    //    (si la imagen falla aquí, no se toca ningún número de boleto)
    const proofBase64 = await compressImageToBase64(proofFile);
    if (proofBase64.length > 900000) {
      throw new Error("La imagen del comprobante es muy grande. Intenta con una foto más pequeña o una captura de pantalla.");
    }

    // 2. Recién aquí reservar números únicos de boleto
    ticketNumbers = await reserveTicketNumbers(selectedQty);

    // 3. Guardar la compra en Firestore como "pendiente"
    //    (esto NO afecta la barra de progreso pública — solo sube
    //    cuando el admin verifique el pago)
    const total = selectedQty * TICKET_PRICE;
    await addDoc(collection(db, "tickets"), {
      fullName,
      phone,
      quantity: selectedQty,
      total,
      paymentMethod: selectedMethod,
      ticketNumbers,
      proofImage: proofBase64,
      status: "pendiente",
      createdAt: serverTimestamp()
    });

    // 4. Mostrar confirmación (los números se ven de una vez, marcados
    //    como "Pendiente" hasta que el admin los verifique)
    lastTicketNumbers = ticketNumbers;
    lastPurchaseInfo = { fullName, phone, quantity: selectedQty, total, paymentMethod: selectedMethod };
    showConfirmation();

  } catch (err) {
    console.error(err);

    // Si ya se habían reservado números pero el guardado falló después,
    // los devolvemos a la bolsa de reciclados para que no se pierdan
    if (ticketNumbers) {
      try {
        const releasedRef = doc(db, "raffle", "releasedNumbers");
        await setDoc(releasedRef, { numbers: arrayUnion(...ticketNumbers) }, { merge: true });
      } catch (releaseErr) {
        console.error("No se pudieron liberar los números tras el error:", releaseErr);
      }
    }

    alert("Hubo un problema registrando tu compra. Por favor intenta de nuevo. " + (err.message || ""));
  } finally {
    submitPurchaseBtn.disabled = false;
    submitPurchaseBtn.textContent = "Ya realicé el pago";
  }
});

function showConfirmation() {
  stepForm.hidden = true;
  stepConfirm.hidden = false;
  stepConfirm.scrollIntoView({ behavior: "smooth", block: "start" });

  // Pintar los números de boleto como chips (estado: pendiente de verificación)
  const chipsContainer = document.getElementById("confirmTicketNumbers");
  chipsContainer.innerHTML = lastTicketNumbers
    .map((n) => `<span class="ticket-chip">${n}</span>`)
    .join("");

  const waMsg = encodeURIComponent(
    `Hola, soy ${lastPurchaseInfo.fullName}.\n` +
    `Acabo de comprar ${lastPurchaseInfo.quantity} boletos de DuoRifa por un total de ${formatMoney(lastPurchaseInfo.total)}.\n` +
    `Método de pago: ${paymentMethodLabel(lastPurchaseInfo.paymentMethod)}.\n` +
    `Mi número de teléfono: ${lastPurchaseInfo.phone}.\n` +
    `Adjunto mi comprobante de pago.`
  );
  document.getElementById("sendProofWhatsapp").href = `https://wa.me/${WHATSAPP_NUMBER}?text=${waMsg}`;
}

document.getElementById("newPurchaseBtn").addEventListener("click", () => {
  purchaseForm.reset();
  proofPreview.hidden = true;
  proofFile = null;
  proofFileNameEl.textContent = "Ningún archivo seleccionado";
  selectedMethod = null;
  pmButtons.forEach((b) => b.classList.remove("active"));
  paymentDetails.hidden = true;
  qtyButtons.forEach((b) => {
    b.classList.remove("active");
    b.setAttribute("aria-pressed", "false");
  });
  qtyCustomInput.value = "";
  setQuantity(0);
  stepConfirm.hidden = true;
  stepQuantity.hidden = false;
  stepQuantity.scrollIntoView({ behavior: "smooth", block: "start" });
});

// =====================================================================
// VERIFICAR BOLETO POR TELÉFONO
// =====================================================================
const verifyForm = document.getElementById("verifyForm");
const verifyResults = document.getElementById("verifyResults");

verifyForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const phone = normalizePhone(document.getElementById("verifyPhone").value);
  if (phone.length < 10) { alert("Escribe un número de teléfono válido."); return; }

  verifyResults.hidden = false;
  verifyResults.innerHTML = "<p>Buscando tus boletos...</p>";

  try {
    const q = query(collection(db, "tickets"), where("phone", "==", phone));
    const snap = await getDocs(q);

    if (snap.empty) {
      verifyResults.innerHTML = "<p>No encontramos compras con ese número de teléfono.</p>";
      return;
    }

    verifyResults.innerHTML = "";
    snap.forEach((docSnap) => {
      const data = docSnap.data();
      const item = document.createElement("div");
      item.className = "verify-item";
      const isVerified = data.status === "verificado";
      const statusClass = isVerified ? "status-verificado" : "status-pendiente";
      const statusLabel = isVerified ? "Verificado" : "Pendiente (hasta 24h)";
      const numbersHtml = `<div class="ticket-numbers">${(data.ticketNumbers || [])
        .map((n) => `<span class="ticket-chip">${n}</span>`)
        .join("")}</div>`;
      item.innerHTML = `
        <div>
          <strong>${data.quantity} boletos</strong> · ${formatMoney(data.total)}
          ${numbersHtml}
        </div>
        <span class="verify-status ${statusClass}">${statusLabel}</span>
      `;
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
const navToggle = document.getElementById("navToggle");
const mainNav = document.getElementById("mainNav");

navToggle.addEventListener("click", () => {
  const isOpen = mainNav.classList.toggle("open");
  navToggle.setAttribute("aria-expanded", String(isOpen));
});

mainNav.querySelectorAll("a").forEach((link) => {
  link.addEventListener("click", () => {
    mainNav.classList.remove("open");
    navToggle.setAttribute("aria-expanded", "false");
  });
});

// =====================================================================
// INICIO
// =====================================================================
setQuantity(0);
listenToProgress();
// ============ GALERÍA: duplicar imágenes para loop infinito + lightbox ============
(function () {
  const track = document.getElementById("galleryTrack");
  if (!track) return;

  // Duplica las imágenes una vez para que el loop del 50% no se note
  track.innerHTML += track.innerHTML;

  const lightbox = document.getElementById("lightbox");
  const lightboxImg = document.getElementById("lightboxImg");
  const lightboxClose = document.getElementById("lightboxClose");

  track.addEventListener("click", (e) => {
    const img = e.target.closest(".gallery-img");
    if (!img) return;
    lightboxImg.src = img.src;
    lightboxImg.alt = img.alt;
    lightbox.hidden = false;
    document.body.classList.add("modal-open");
  });

  function closeLightbox() {
    lightbox.hidden = true;
    lightboxImg.src = "";
    document.body.classList.remove("modal-open");
  }

  lightboxClose.addEventListener("click", closeLightbox);
  lightbox.addEventListener("click", (e) => {
    if (e.target === lightbox) closeLightbox();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !lightbox.hidden) closeLightbox();
  });
})();