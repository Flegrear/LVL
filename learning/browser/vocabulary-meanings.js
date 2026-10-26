// Presentation uses one sense; imported Anki note fields remain unchanged.
export function primaryMeaning(value) {
  return String(value || "").split(/[;\n|]/).map((part) => part.trim()).find(Boolean) || "";
}

// Frequent English function words are especially unreliable in reverse-derived dictionary
// entries. These common EN→ES senses override those entries, including inflected lemmas.
const EN_ES = Object.freeze({
  you: "tú", i: "yo", the: "el", to: "a", a: "un", be: "ser", it: "ello", and: "y", that: "eso",
  of: "de", in: "en", what: "qué", we: "nosotros", me: "yo", this: "esto", he: "él", for: "para",
  my: "mi", on: "sobre", have: "tener", your: "tu", do: "hacer", no: "no", not: "no", are: "ser",
  don: "no", know: "saber", can: "poder", with: "con", but: "pero", all: "todo", so: "así",
  just: "solo", there: "allí", here: "aquí", they: "ellos", like: "gustar", will: "auxiliar de futuro",
  get: "obtener", she: "ella", go: "ir", if: "si", right: "correcto", out: "fuera", about: "acerca de",
  up: "arriba", at: "en", him: "él", now: "ahora", oh: "oh", one: "uno", come: "venir", well: "bien",
  her: "ella", how: "cómo", yeah: "sí", want: "querer", think: "pensar", as: "como", see: "ver",
  good: "bueno", who: "quién", why: "por qué", from: "de", let: "dejar", his: "su", yes: "sí",
  when: "cuándo", time: "tiempo", an: "un", okay: "bien", back: "atrás", look: "mirar", us: "nosotros",
  would: "auxiliar condicional", them: "ellos", where: "dónde", were: "ser", take: "tomar", then: "entonces",
  or: "o", our: "nuestro", tell: "decir", really: "realmente", man: "hombre", some: "algunos",
  say: "decir", hey: "oye", need: "necesitar", something: "algo", too: "también", more: "más",
  way: "camino", down: "abajo", could: "poder", must: "deber", should: "deber", may: "poder",
});

export function bundledMeaning(language, row) {
  if (String(language).toUpperCase() === "EN") {
    const word = String(row.word || "").toLowerCase();
    const lemma = String(row.lemma || "").toLowerCase();
    if (EN_ES[word] || EN_ES[lemma]) return EN_ES[word] || EN_ES[lemma];
  }
  return primaryMeaning(row.gloss);
}
