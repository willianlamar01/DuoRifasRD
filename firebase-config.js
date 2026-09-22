// =====================================================================
// CONFIGURACIÓN DE FIREBASE — DuoRifa
// =====================================================================
// 1. Crea un proyecto gratis en https://console.firebase.google.com
// 2. Dentro del proyecto, agrega una "app web" y copia el objeto de
//    configuración que te da Firebase (son datos públicos, es normal
//    que vayan en el código del frontend).
// 3. Activa "Firestore Database" (modo producción) y "Authentication"
//    (método Email/Password, para el panel admin).
// 4. Pega tus datos reales reemplazando los valores de ejemplo abajo.
// NOTA: ya NO se usa Firebase Storage — la foto del comprobante se
// guarda como texto base64 directo dentro del documento de Firestore,
// para no requerir el plan Blaze (tarjeta de crédito).
// =====================================================================

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";

const firebaseConfig = {
  apiKey: "AIzaSyCrdyQPsN-eaYtRQu23a-hvpgn0fGT3TJc",
  authDomain: "duorifa.firebaseapp.com",
  projectId: "duorifa",
  storageBucket: "duorifa.firebasestorage.app",
  messagingSenderId: "836114009663",
  appId: "1:836114009663:web:e99ed41d47061e76d7b2a"
};

const app = initializeApp(firebaseConfig);

export const db = getFirestore(app);
export const auth = getAuth(app);