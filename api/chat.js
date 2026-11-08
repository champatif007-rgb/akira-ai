// Akira AI - secure chat proxy. The Gemini key lives ONLY in Netlify's environment variables.
const MODES = {
  help: "Mode: homework help. ",
  explain: "Mode: explain with one everyday example, then ask one short question to check understanding. ",
  quiz: "Mode: quizzing. Ask ONE question at a time, wait for the answer, say if it was right with a short explanation, then ask the next. ",
  write: "Mode: writing feedback. Give two things done well and two specific improvements. Do not rewrite the whole text. ",
  plan: "Mode: study planner. Make a realistic, simple plan with short breaks. ",
  draw: "Mode: draw and diagram. Always include exactly one picture or table, then explain it in one or two sentences. ",
};
const GRADES = ["Grades 1 to 3", "Grades 4 to 6", "Grades 7 to 9", "Grades 10 to 12", "College"];
const SUBJECTS = ["Any subject", "Math", "Science", "English", "Hindi", "Social science", "Computer science"];
const LANGS = { auto: "Reply in the language the student writes in. ", en: "Reply in simple English. ", hi: "Reply in simple Hindi (Devanagari). ", hinglish: "Reply in Hinglish (Hindi in English letters). " };
const hits = new Map();

function rules(b) {
  let s = "You are Akira, a friendly, patient school tutor. Student level: " + b.grade + ". Subject: " + b.subject + ". Use simple words for this level. Keep answers short and clear, under 180 words unless asked. Do not use markdown symbols like ** or #; use plain sentences and short numbered steps. Only discuss topics suitable for students. If asked for anything unsafe or inappropriate, kindly decline and suggest asking a trusted adult or teacher. If the student seems upset or in danger, respond kindly and encourage talking to a trusted adult. Do not help cheat on a live test. " + LANGS[b.lang];
  s += MODES[b.mode];
  if (b.mode === "help") s += b.guide ? "Guide the student: give a hint or first step, not the final answer, and ask them to try the next step. If they say they are still stuck after trying, give more help. " : "Give a full worked solution with clear steps. ";
  s += (b.visuals || b.mode === "draw")
    ? 'Visuals: when a picture, diagram, flowchart, mind map, timeline, graph or table would help, or the student asks, include it. For a picture or diagram output exactly one SVG in a fenced block: a line ```svg, the SVG code, then a line ```. SVG rules: viewBox="0 0 640 400", first element a white rect covering the canvas, simple shapes, bright readable colors, dark text (#14161f) sans-serif at least 15px, label every part, no scripts, no external images or fonts, fewer than 60 elements. For a table output a fenced block starting with a line ```table, one row per line, columns separated by |, first row headings, then a line ```. Put one or two sentences of explanation outside the block. You cannot make photographs, so draw simple clear vector illustrations; if asked for a photo, say so kindly and draw instead. '
    : "Do not include pictures or tables. ";
  return s;
}

module.exports = async (req, res) => {
  const out = (code, obj) => res.status(code).json(obj);
  if (req.method !== "POST") return out(405, { error: "post_only" });
  const key = process.env.GEMINI_API_KEY;
  if (!key) return out(500, { error: "not_configured" });

  let b = req.body;
  if (typeof b === "string") { try { b = JSON.parse(b); } catch { return out(400, { error: "bad_json" }); } }
  if (!b || typeof b !== "object") return out(400, { error: "bad_json" });
  if (JSON.stringify(b).length > 40000) return out(413, { error: "too_big" });

  const ip = String(req.headers["x-forwarded-for"] || "x").split(",")[0].trim();
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter((t) => now - t < 60000);
  if (recent.length >= 10) return out(429, { error: "rate" });
  recent.push(now); hits.set(ip, recent);

  b.mode = MODES[b.mode] ? b.mode : "help";
  b.grade = GRADES.includes(b.grade) ? b.grade : GRADES[2];
  b.subject = SUBJECTS.includes(b.subject) ? b.subject : SUBJECTS[0];
  b.lang = LANGS[b.lang] ? b.lang : "auto";

  let msgs = (Array.isArray(b.messages) ? b.messages : []).slice(-12)
    .map((m) => ({ role: m.role === "user" ? "user" : "model", parts: [{ text: String(m.text || "").slice(0, 2000) }] }));
  while (msgs.length && msgs[0].role !== "user") msgs.shift();
  if (!msgs.length || msgs[msgs.length - 1].role !== "user") return out(400, { error: "no_question" });

  const model = process.env.GEMINI_MODEL || "gemini-flash-latest";
  const safety = ["HARASSMENT", "HATE_SPEECH", "SEXUALLY_EXPLICIT", "DANGEROUS_CONTENT"].map((c) => ({ category: "HARM_CATEGORY_" + c, threshold: "BLOCK_MEDIUM_AND_ABOVE" }));
  try {
    const r = await fetch("https://generativelanguage.googleapis.com/v1beta/models/" + model + ":generateContent", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({ systemInstruction: { parts: [{ text: rules(b) }] }, contents: msgs, safetySettings: safety, generationConfig: { temperature: 0.6, maxOutputTokens: 2500 } }),
    });
    const j = await r.json();
    if (!r.ok) return out(r.status === 429 ? 429 : 502, { error: r.status === 404 ? "model" : "upstream" });
    const parts = j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts;
    const text = parts ? parts.map((p) => p.text || "").join("") : "";
    return out(200, { text: text || "", blocked: !text });
  } catch (e) {
    return out(502, { error: "upstream" });
  }
};
