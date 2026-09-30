const cheerio = require("cheerio");
const { PDFDocument, StandardFonts, rgb } = require("pdf-lib");

const W = 595, H = 842;
const SECTIONS = {
  materials: /materials|supplies/i,
  abbreviations: /abbreviations|terms|stitches/i,
  dimensions: /dimensions|size|measurements/i,
  notes: /notes|tips/i,
};
const COLORS = {
  cream:"#F3E9D2", ivory:"#F5EFDC", white:"#FFFFFF", beige:"#D8C3A5", tan:"#C8A97E", grey:"#9A9A9A", gray:"#9A9A9A",
  black:"#222222", brown:"#7B5B3A", olive:"#6B7A2F", green:"#4E9F5A", sage:"#9CAF88", mint:"#8FD6B4", teal:"#2FA3A3",
  turquoise:"#2FBFBF", blue:"#4A7FD1", navy:"#27406E", sky:"#8EC5F0", purple:"#8E5BC7", lavender:"#B39DDB",
  lilac:"#C3A6E0", violet:"#7B4FC2", pink:"#F06595", blush:"#F4A6B8", rose:"#E0567A", red:"#D93A3A", coral:"#FF6B6B",
  peach:"#FFAB85", orange:"#F2801F", mustard:"#D9A520", yellow:"#F2C230", gold:"#D4A017", burgundy:"#7A1F3D",
  maroon:"#7A1F3D", lime:"#9BCB2E",
};
const NEUTRAL = new Set(["cream","ivory","white","beige","tan","grey","gray","black","brown"]);
const BASES = new Set(["green","yellow","blue","pink","purple","red","orange","brown","grey","gray"]);

// ---------- parsing ----------
const sectionOf = (h) => {
  h = h.trim().replace(/[:*]/g, "");
  if (h.length > 40) return null;
  for (const [k, rx] of Object.entries(SECTIONS)) if (rx.test(h)) return k;
  return null;
};
const cleanTitle = (t) =>
  (t.split(/\s[|–—-]\s/)[0] || "").replace(/\b(free|crochet|pattern|video|tutorials?)\b/gi, "").replace(/\s+/g, " ").trim() || "Crochet Pattern";
const emptyData = () => ({ materials: [], abbreviations: [], dimensions: [], notes: [] });

function parseHtml(html) {
  const $ = cheerio.load(html);
  const title = $('meta[property="og:title"]').attr("content") || $("h1").first().text() || $("title").text();
  const data = emptyData();
  let cur = null;
  const root = $("article").first().length ? $("article").first() : $("body");
  root.find("h1,h2,h3,h4,h5,li,p").each((_, el) => {
    const t = $(el).text().replace(/\s+/g, " ").trim();
    if (!t) return;
    if (/^h\d$/i.test(el.tagName)) cur = sectionOf(t);
    else if (cur && t.length < 260) data[cur].push(t.replace(/^[*\-•\s]+/, ""));
  });
  return { title: cleanTitle(title), data };
}
function parseText(txt) {
  const data = emptyData();
  let cur = null, title = null;
  for (let line of txt.split(/\r?\n/)) {
    line = line.trim();
    if (!line) continue;
    if (title === null) { title = line; continue; }
    const s = line.length < 40 ? sectionOf(line) : null;
    if (s) cur = s;
    else if (cur) data[cur].push(line.replace(/^[*\-•\s]+/, ""));
  }
  return { title: cleanTitle(title || "Crochet Pattern"), data };
}

// ---------- robots + fetch ----------
async function fetchAllowed(url) {
  const u = new URL(url);
  try {
    const r = await fetch(`${u.origin}/robots.txt`);
    if (r.ok) {
      let applies = false;
      for (const raw of (await r.text()).split("\n")) {
        const line = raw.split("#")[0].trim();
        const [k, ...v] = line.split(":"); const val = v.join(":").trim();
        if (/^user-agent$/i.test(k)) applies = val === "*";
        else if (applies && /^disallow$/i.test(k) && val && u.pathname.startsWith(val)) {
          throw new Error("ROBOTS");
        }
      }
    }
  } catch (e) { if (e.message === "ROBOTS") throw e; }
  const res = await fetch(url, { headers: { "User-Agent": "crochet-pdf-maker/1.0 (personal use)" } });
  if (!res.ok) throw new Error("HTTP " + res.status);
  return res.text();
}

// ---------- colors ----------
function yarnColors(materials) {
  const toks = materials.join(" ").toLowerCase().match(/[a-z]+/g) || [];
  const found = [];
  for (let i = 0; i < toks.length; i++) {
    let w = toks[i];
    if (!COLORS[w]) continue;
    const nxt = toks[i + 1] || "";
    if (BASES.has(w) && COLORS[nxt] && !BASES.has(nxt)) { w = nxt; i++; }
    else if (!BASES.has(w) && BASES.has(nxt)) i++;
    if (!found.includes(w)) found.push(w);
  }
  return found;
}
const hex2rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
function rgb2hsv([r, g, b]) {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn; let h = 0;
  if (d) { if (mx === r) h = ((g - b) / d) % 6; else if (mx === g) h = (b - r) / d + 2; else h = (r - g) / d + 4; h /= 6; if (h < 0) h += 1; }
  return [h, mx ? d / mx : 0, mx];
}
function hsv2rgb([h, s, v]) {
  const f = (n) => { const k = (n + h * 6) % 6; return v - v * s * Math.max(0, Math.min(k, 4 - k, 1)); };
  return [f(5), f(3), f(1)];
}
const mixc = (a, b, t) => a.map((x, i) => x * (1 - t) + b[i] * t);
const C = (a) => rgb(a[0], a[1], a[2]);
function palette(hex) {
  let [h, s, v] = rgb2hsv(hex2rgb(hex));
  s = Math.max(0.45, Math.min(s, 0.85));
  const frame = hsv2rgb([h, s, Math.max(0.55, Math.min(v, 0.9))]);
  return {
    frame: C(frame), bg: C(mixc(frame, [1, 1, 1], 0.25)), card: C(mixc(frame, [1, 1, 1], 0.93)),
    box: C(mixc(frame, [1, 1, 1], 0.88)), accent: C(hsv2rgb([h, Math.min(1, s + 0.1), Math.min(v, 0.68)])),
    label: C(hsv2rgb([(h + 0.12) % 1, 0.55, 0.8])), dark: rgb(0.13, 0.13, 0.13), grey: rgb(0.55, 0.55, 0.55),
  };
}


// ---------- crochet types + image prompts ----------
const TYPES = {
  bag: { label: "Bag / purse", kw: ["bag","tote","purse","pouch","clutch","backpack","handbag","satchel","crossbody"],
    hero: "Handmade crochet {T} in {col} cotton yarn, front view with strap, styled on a rustic wooden table, soft natural light, product photography, shallow depth of field --ar 3:4",
    flat: "Flat lay on light linen: balls of {col} cotton yarn, a crochet hook, scissors, yarn needle and bag lining fabric, top-down view, clean minimal style --ar 16:9",
    tech: "Macro photo of hands crocheting dense sturdy stitches for a bag in {col} cotton yarn, focus on hook and stitch texture, white background --ar 16:9",
    s1: "Top-down photo of the base of a crochet bag in progress in {col} cotton yarn, hook still in the work, neutral background --ar 16:9",
    s2: "A crochet {T} body laid flat showing the sides and strap attachment points, {col} cotton yarn, top-down, crisp stitch detail --ar 16:9",
    asm: "Clean instructional crochet diagram on cream background: labeled parts of a {T} (body, flap, strap), dotted seam lines, curved folding arrows, flat vector illustration, pastel {col} accents, hand-drawn style, clear labels --ar 4:3",
    asmDesc: "Assembly diagram: body, flap, strap, seam lines",
    life: "A hand holding the finished crochet {T} by its strap in a sunny cafe, only the hand and bag visible, boho style, soft daylight --ar 4:5" },
  amigurumi: { label: "Amigurumi / toy", kw: ["amigurumi","doll","plush","plushie","toy","bunny","bear","cat","dog","dumpling","animal","stuffed","safety eyes","stuffing","fiberfill","kawaii"],
    hero: "Cute amigurumi {T} crocheted in {col} yarn with safety eyes and a kawaii face, sitting on a soft neutral surface, soft studio light, macro product photo, shallow depth of field --ar 1:1",
    flat: "Flat lay on light linen: small balls of {col} yarn, a 2mm crochet hook, safety eyes, toy stuffing, stitch marker and yarn needle, top-down view, clean minimal style --ar 16:9",
    tech: "Macro photo of hands working single crochet rounds of a small amigurumi in {col} yarn with a tiny hook, white background --ar 16:9",
    s1: "A partly finished amigurumi {T} in {col} yarn being stuffed, held in a hand, neutral background --ar 16:9",
    s2: "Close-up of the face of a {col} amigurumi with safety eyes, embroidered smile and blushed cheeks, macro, soft light --ar 16:9",
    asm: "Clean instructional crochet diagram on cream background: all parts of an amigurumi {T} (body, head, limbs, ears) laid out, labeled, with arrows showing where each part is sewn on, flat vector illustration, pastel {col} accents, hand-drawn style --ar 4:3",
    asmDesc: "Diagram: parts of the toy and where to sew them",
    life: "The finished amigurumi {T} in {col} sitting on a cozy nursery shelf with small props, soft daylight, kawaii style --ar 4:5" },
  blanket: { label: "Blanket / throw", kw: ["blanket","afghan","throw","bedspread","lapghan","baby blanket","quilt"],
    hero: "A large handmade crochet {T} in {col} yarn draped over a sofa, soft window light, cozy home interior --ar 4:3",
    flat: "Flat lay on light linen: skeins of {col} yarn, a large crochet hook, scissors, yarn needle and a measuring tape, top-down view, clean minimal style --ar 16:9",
    tech: "Macro photo of the stitch pattern of a crochet blanket in {col} yarn, texture and stitch definition, natural light --ar 16:9",
    s1: "A crochet blanket panel in progress resting on a lap, {col} yarn, hook in the work, bright neutral background --ar 16:9",
    s2: "The corner of a crochet blanket with a border round being added, {col} yarn, close-up --ar 16:9",
    asm: "Clean instructional crochet diagram on cream background: a numbered grid showing how panels or squares of a {T} are laid out and joined, border around the edge, flat vector illustration, pastel {col} accents, clear labels --ar 4:3",
    asmDesc: "Diagram: layout of panels, joining and border",
    life: "The finished crochet {T} in {col} folded over a wooden rocking chair beside a basket of yarn, cozy lifestyle photo --ar 4:5" },
  wearable: { label: "Garment / wearable", kw: ["sweater","cardigan","top","vest","dress","shawl","poncho","tee","crop","skirt","shrug","garment","tank","jumper","pullover","sleeve","sleeves"],
    hero: "A handmade crochet {T} in {col} yarn hanging on a wooden hanger against a neutral wall, soft light, fashion flat-lay style, no person --ar 3:4",
    flat: "Flat lay on light linen: balls of {col} yarn, a crochet hook, stitch markers, tape measure, scissors and yarn needle, top-down view, clean minimal style --ar 16:9",
    tech: "Macro photo of the drape and stitch texture of crochet garment fabric in {col} yarn, natural light --ar 16:9",
    s1: "A crochet garment panel laid flat with a tape measure across it, {col} yarn, top-down, neutral background --ar 16:9",
    s2: "Close-up of a crochet sleeve being joined at the armhole, {col} yarn, bright neutral background --ar 16:9",
    asm: "Clean sewing schematic on cream background: front, back and sleeves of a {T} with measurements labeled, seam lines dotted, flat vector illustration, pastel {col} accents, clear labels --ar 4:3",
    asmDesc: "Schematic: pieces, measurements and seams",
    life: "The finished crochet {T} in {col} folded on a wooden table next to a potted plant, soft daylight, lifestyle photo --ar 4:5" },
  accessory: { label: "Hat / scarf / accessory", kw: ["hat","beanie","scarf","cowl","gloves","mittens","headband","bandana","socks","slippers","earwarmer","balaclava","beret","bucket hat"],
    hero: "A handmade crochet {T} in {col} yarn styled on a neutral mannequin head or folded on a wooden surface, soft natural light, product photography --ar 4:5",
    flat: "Flat lay on light linen: balls of {col} yarn, a crochet hook, stitch marker, scissors and yarn needle, top-down view, clean minimal style --ar 16:9",
    tech: "Macro photo of hands crocheting in the round with {col} yarn, focus on the hook and stitches, white background --ar 16:9",
    s1: "A crochet {T} in progress laid flat, {col} yarn, hook in the work, neutral background --ar 16:9",
    s2: "The finished edge or brim of a crochet {T} in {col} yarn, close-up of the ribbing or border, natural light --ar 16:9",
    asm: "Clean instructional crochet diagram on cream background: construction of a {T} with labeled sections and arrows showing the direction of work, flat vector illustration, pastel {col} accents, hand-drawn style --ar 4:3",
    asmDesc: "Diagram: sections and direction of work",
    life: "The finished crochet {T} in {col} styled outdoors in autumn light, cozy lifestyle photo, no face visible --ar 4:5" },
  decor: { label: "Home decor", kw: ["coaster","rug","basket","planter","hanger","pillow","cushion","doily","runner","wreath","curtain","garland","ornament","decor","holder","cover","mat","placemat"],
    hero: "A handmade crochet {T} in {col} cotton yarn styled on a minimal home shelf with a plant, soft natural light, interior photography --ar 4:3",
    flat: "Flat lay on light linen: balls of {col} cotton yarn, a crochet hook, scissors and yarn needle, top-down view, clean minimal style --ar 16:9",
    tech: "Macro photo of hands crocheting flat rounds in {col} cotton yarn, focus on stitches, white background --ar 16:9",
    s1: "The first rounds of a crochet {T} lying flat in {col} cotton yarn, top-down, neutral background --ar 16:9",
    s2: "The finished edge of a crochet {T} in {col} cotton yarn, close-up of the border, natural light --ar 16:9",
    asm: "Clean instructional crochet diagram on cream background: concentric rounds or layered pieces of a {T} labeled with arrows, flat vector illustration, pastel {col} accents, hand-drawn style --ar 4:3",
    asmDesc: "Diagram: rounds / layers and how they fit",
    life: "The finished crochet {T} in {col} in use in a cozy living room, soft daylight, lifestyle photo --ar 4:5" },
  small: { label: "Small item / motif", kw: ["keychain","earrings","flower","bookmark","patch","applique","motif","charm","brooch","scrunchie","bow","sunflower","daisy"],
    hero: "A tiny handmade crochet {T} in {col} cotton yarn on a white surface, macro product photo, soft studio light --ar 1:1",
    flat: "Flat lay on light linen: small amounts of {col} cotton yarn, a small crochet hook, scissors and yarn needle, top-down view, clean minimal style --ar 16:9",
    tech: "Extreme macro photo of hands crocheting a small {T} in {col} yarn with a tiny hook, white background --ar 16:9",
    s1: "A crochet {T} in progress held between fingers, {col} yarn, neutral background --ar 16:9",
    s2: "Several finished crochet {T} pieces in {col} arranged on a white surface, top-down --ar 16:9",
    asm: "Clean instructional crochet diagram on cream background: a {T} with its parts labeled and arrows showing how they are attached, flat vector illustration, pastel {col} accents --ar 4:3",
    asmDesc: "Diagram: parts and how they are attached",
    life: "The finished crochet {T} in {col} used as an accessory (on a bag or as a keychain), soft daylight, lifestyle macro --ar 4:5" },
  generic: { label: "General", kw: [],
    hero: "Handmade crochet {T} in {col} cotton yarn, styled on a rustic wooden table, soft warm natural light, cozy handmade aesthetic, shallow depth of field, product photography --ar 3:4",
    flat: "Flat lay on a light linen background: balls of {col} cotton yarn, a crochet hook, small scissors and a yarn needle, top-down view, soft natural light, clean minimal style --ar 16:9",
    tech: "Close-up macro photo of hands crocheting with {col} cotton yarn, clear focus on the hook and stitches, white background --ar 16:9",
    s1: "Close-up of the first rounds of a crochet project in {col} cotton yarn held in a hand with a hook, bright neutral background --ar 16:9",
    s2: "A finished crochet piece in {col} cotton yarn laid flat on a white surface, top-down view, crisp stitch detail --ar 16:9",
    asm: "Clean instructional crochet assembly diagram on cream background: labeled parts of a {T}, dotted seam lines, curved arrows, flat vector illustration, pastel {col} accents, hand-drawn style, clear labels --ar 4:3",
    asmDesc: "Assembly diagram with labeled parts and arrows",
    life: "Lifestyle photo of the finished crochet {T} in {col}, soft daylight, cozy boho style --ar 4:5" },
};

function detectType(title, data) {
  const body = [...data.materials, ...data.notes, ...data.dimensions].join(" ");
  let best = "generic", top = 0;
  for (const [k, t] of Object.entries(TYPES)) {
    let sc = 0;
    for (const kw of t.kw) {
      const rx = new RegExp(`\\b${kw.replace(/\s+/g, "\\s+")}s?\\b`, "i");
      if (rx.test(title)) sc += 3;
      if (rx.test(body)) sc += 1;
    }
    if (sc > top) { top = sc; best = k; }
  }
  return best;
}

// ---------- PDF ----------
const safe = (s) => s.replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/[–—]/g, "-").replace(/[^\x20-\x7E\xA0-\xFF]/g, "?");

class Doc {
  constructor(pdf, font, bold, pal) { Object.assign(this, { pdf, font, bold, pal, n: 0, prompts: [] }); this.newPage(); }
  newPage() {
    const p = this.pal; this.page = this.pdf.addPage([W, H]);
    this.page.drawRectangle({ x: 0, y: 0, width: W, height: H, color: p.bg });
    this.rr(28, 28, W - 56, H - 56, 22, p.frame);
    this.rr(46, 46, W - 92, H - 92, 16, p.card);
    this.y = H - 82;
  }
  rr(x, y, w, h, r, color, opt = {}) {
    const path = `M ${r} 0 H ${w - r} A ${r} ${r} 0 0 1 ${w} ${r} V ${h - r} A ${r} ${r} 0 0 1 ${w - r} ${h} H ${r} A ${r} ${r} 0 0 1 0 ${h - r} V ${r} A ${r} ${r} 0 0 1 ${r} 0 Z`;
    this.page.drawSvgPath(path, { x, y: y + h, color, ...opt });
  }
  wrap(text, font, size, width) {
    const out = []; let line = "";
    for (const w of safe(text).split(/\s+/)) {
      const t = line ? line + " " + w : w;
      if (font.widthOfTextAtSize(t, size) > width && line) { out.push(line); line = w; } else line = t;
    }
    if (line) out.push(line); return out;
  }
  need(h) { if (this.y - h < 74) this.newPage(); }
  heading(s, size = 22) {
    this.need(size * 2 + 60);
    if (this.y < H - 90) this.y -= 18;
    this.page.drawText(safe(s), { x: 72, y: this.y, size, font: this.bold, color: this.pal.dark });
    this.y -= size * 1.6;
  }
  bullets(items, size = 12) {
    for (const it of items) {
      const lines = this.wrap(it, this.font, size, W - 72 - 90);
      this.need(lines.length * size * 1.4 + 4);
      this.page.drawCircle({ x: 78, y: this.y + size * 0.3, size: 2.2, color: this.pal.dark });
      for (const ln of lines) { this.page.drawText(ln, { x: 90, y: this.y, size, font: this.font, color: this.pal.dark }); this.y -= size * 1.4; }
      this.y -= 3;
    }
  }
  para(s, size = 11, color) {
    for (const ln of this.wrap(s, this.font, size, W - 144)) { this.need(size * 1.4); this.page.drawText(ln, { x: 72, y: this.y, size, font: this.font, color: color || this.pal.dark }); this.y -= size * 1.4; }
  }
  lines(label, n) {
    for (let i = 1; i <= n; i++) {
      this.need(24);
      this.page.drawText(`${label} ${i}:`, { x: 72, y: this.y, size: 12, font: this.font, color: this.pal.dark });
      this.page.drawLine({ start: { x: 130, y: this.y - 2 }, end: { x: W - 72, y: this.y - 2 }, thickness: 0.5, color: this.pal.grey });
      this.y -= 24;
    }
  }
  placeholder(h, desc, prompt) {
    this.need(h + 10); this.n++;
    const w = W - 144, y0 = this.y - h;
    this.rr(72, y0, w, h, 10, this.pal.box, { borderColor: this.pal.grey, borderWidth: 1, borderDashArray: [5, 4] });
    const t = `IMAGE ${this.n}`;
    this.page.drawText(t, { x: 72 + w / 2 - this.bold.widthOfTextAtSize(t, 13) / 2, y: y0 + h / 2 + 8, size: 13, font: this.bold, color: this.pal.label });
    let ly = y0 + h / 2 - 8;
    for (const ln of this.wrap(desc, this.font, 9, w - 30)) {
      this.page.drawText(ln, { x: 72 + w / 2 - this.font.widthOfTextAtSize(ln, 9) / 2, y: ly, size: 9, font: this.font, color: this.pal.grey }); ly -= 12;
    }
    this.prompts.push({ n: this.n, desc, prompt });
    this.y = y0 - 18;
  }
  center(s, y, size, font, color) {
    this.page.drawText(s, { x: W / 2 - font.widthOfTextAtSize(s, size) / 2, y, size, font, color });
  }
}

async function buildPdf(title, data, hex, source, typeKey) {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica), bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const pal = palette(hex), colors = yarnColors(data.materials);
  const col = colors.length ? colors.slice(0, 2).join(" and ") : "natural";
  const d = new Doc(pdf, font, bold, pal), T = title.toLowerCase();
  const ty = TYPES[typeKey] || TYPES.generic;
  const F = (t) => t.replace(/\{T\}/g, T).replace(/\{col\}/g, col);

  d.placeholder(400, `Hero photo: the finished ${T} (${col} yarn)`, F(ty.hero));
  let yy = d.y - 24;
  for (const ln of [...d.wrap(title.toUpperCase(), bold, 32, W - 140), "CROCHET PATTERN"]) { d.center(ln, yy, 32, bold, pal.accent); yy -= 42; }
  if (source) d.center(safe("Inspired by: " + source).slice(0, 90), 62, 9, font, pal.grey);
  d.newPage();

  if (data.materials.length) {
    d.heading("Materials"); d.bullets(data.materials);
    d.placeholder(150, `Flat lay: ${col} yarn and tools`, F(ty.flat));
  }
  if (data.abbreviations.length) { d.heading("Abbreviations"); d.bullets(data.abbreviations); }
  if (data.dimensions.length) { d.heading("Dimensions"); d.bullets(data.dimensions); }
  if (data.notes.length) {
    d.heading("Notes & Tips"); d.bullets(data.notes);
    d.placeholder(150, "Close-up of the main technique", F(ty.tech));
  }
  d.newPage(); d.heading(`The ${title}`);
  d.para("Write the rounds / rows in your own words:", 11, pal.grey); d.y -= 6; d.lines("Round", 8);
  d.placeholder(170, "Step photo: work in progress", F(ty.s1));
  d.placeholder(170, "Step photo: detail / finished part", F(ty.s2));
  d.newPage(); d.heading("Assembly", 28);
  for (let i = 1; i <= 3; i++) d.para(`${i}. ______________________________________________`, 12);
  d.y -= 8;
  d.placeholder(260, ty.asmDesc, F(ty.asm));
  d.placeholder(200, "Photo: the finished project in use", F(ty.life));
  d.newPage();
  d.rr(70, 332, W - 140, 180, 20, pal.frame);
  d.center("THANK YOU FOR", 440, 26, bold, pal.card); d.center("CROCHETING WITH ME", 400, 26, bold, pal.card);
  d.center("Personal use only. Please credit the original designer.", 120, 10, font, pal.grey);

  return { bytes: await pdf.save(), prompts: d.prompts, colors };
}

// ---------- handler ----------
const json = (code, obj) => ({ statusCode: code, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) });

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return json(405, { error: "POST only" });
  try {
    const { url, content, color, type } = JSON.parse(event.body || "{}");
    let parsed, source = null;
    if (content && content.trim()) {
      parsed = /<\s*(html|body|h[1-6]|li|p)\b/i.test(content) ? parseHtml(content) : parseText(content);
      source = url || null;
    } else if (url) {
      try { parsed = parseHtml(await fetchAllowed(url)); source = url; }
      catch (e) {
        if (e.message === "ROBOTS") return json(422, { error: "robots", message: "Had l-site kay-mna3 l-acces l-automatique. Sjjl l-page mn l-browser (Ctrl+S) w up-loadiha, wla copy-paste l-text dyal Materials/Abbreviations/Dimensions/Notes." });
        return json(502, { error: "fetch", message: "Ma9drtch njbd l-page: " + e.message });
      }
    } else return json(400, { error: "empty", message: "3ti URL wla upload/paste l-page." });

    const { title, data } = parsed;
    if (!Object.values(data).some((a) => a.length)) return json(422, { error: "parse", message: "Ma l9it la Materials la Abbreviations la Dimensions la Notes f had l-page." });

    const colors = yarnColors(data.materials);
    const accent = colors.find((c) => !NEUTRAL.has(c));
    const hex = /^#[0-9a-f]{6}$/i.test(color || "") ? color : accent ? COLORS[accent] : "#FF6B6B";
    const typeKey = TYPES[type] ? type : detectType(title, data);
    const { bytes, prompts } = await buildPdf(title, data, hex, source, typeKey);
    return json(200, { title, type: typeKey, typeLabel: TYPES[typeKey].label, color: hex, yarnColors: colors, pdf: Buffer.from(bytes).toString("base64"), prompts });
  } catch (e) {
    return json(500, { error: "server", message: String(e.message || e) });
  }
};
