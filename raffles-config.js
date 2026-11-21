// Configuración de cada rifa. Para agregar otra, copia un bloque y cambia los datos.
// "tags" son los distintivos que se ven en la tarjeta (opcional; si no quieres, bórralo).
export const RAFFLES = {
  kia: {
    id: "kia", name: "Kia 2020 y Kia 2019", badge: "Vehículos", img: "1.jpg",
    tags: ["1er premio · Kia 2020", "2do premio · Kia 2019"],
    price: 50, min: 5, max: 2000, total: 100000, qtys: [5, 10, 20, 30, 50, 100], prize: 5000,
    blessed: ["00120","00925","10310","15545","21305","28790","31100","39855","43100","47610",
              "50112","52370","56412","60440","69930","73450","79200","81080","86110","90920"],
    desc: "Un Kia 2020 full equipo de primer premio y un Kia 2019 de segundo premio, listos para entregar al ganador.",
    draw: "POR DEFINIR", lcg: [40501, 12347],
    docs: { stats: "stats", released: "releasedNumbers", blessed: "blessed" }
  },
  iphone: {
    id: "iphone", name: "2 iPhone 18 Pro Max", badge: "Teléfonos", img: "iphone.jpg",
    tags: ["2 ganadores"],
    price: 5, min: 20, max: 2000, total: 100000, qtys: [20, 50, 100, 200, 500, 1000], prize: 5000,
    blessed: ["11100", "20300", "35100", "47100", "56200"],
    desc: "2 iPhone 18 Pro Max para 2 ganadores, más 5 números bendecidos de RD$5,000 cada uno.",
    draw: "POR DEFINIR", lcg: [61801, 7919],
    docs: { stats: "stats_iphone", released: "releasedNumbers_iphone", blessed: "blessed_iphone" }
  }
};
// Las compras viejas no tienen raffleId: cuentan como Kia
export const raffleOf = (t) => RAFFLES[t?.raffleId] || RAFFLES.kia;