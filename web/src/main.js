// Plumeline 데모 화면: 시나리오를 한 사건씩 계약에 보내고 계약에서 다시 읽은 상태로 지도·표·화물 여권을 그린다
import artifact from "./generated/Plumeline.json";
import { Scenario, ROLES, unix, sceneId, periodName } from "./scenario.js";

const $ = (id) => document.getElementById(id);
const fmtDate = (t) => new Date(t * 1000).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
const fmtShort = (t) => new Date(t * 1000).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
const tCH4 = (kg) => (kg / 1000).toLocaleString("en-US", { maximumFractionDigits: kg >= 100000 ? 0 : 1 });
const pct = (ppm) => (ppm / 10000).toFixed(ppm < 1000 ? 3 : 2) + " %";
const short = (h) => `${h.slice(0, 10)}…${h.slice(-6)}`;
const params = new URLSearchParams(location.search);

const ERROR_TEXT = {
  AccessControlUnauthorizedAccount: "the caller does not hold the role this function needs",
  OverAllocated: "that site-month has fewer unsold tonnes left than requested: the same gas cannot be sold twice",
  SceneAlreadyPosted: "this satellite scene was already posted for this site",
  ObservationOutOfOrder: "observations must arrive in time order",
  NoReport: "there is no report for that month",
  NotVerified: "the month has not been signed by an accredited verifier",
  SelfVerification: "an operator cannot verify itself",
};

let data, sc, state, playing = false, busy = false, plumes = [];

async function loadJSON(path) {
  const r = await fetch(path);
  if (!r.ok) throw new Error(`${path}: ${r.status}`);
  return r.json();
}

async function boot() {
  data = await loadJSON("./data/scenario.json");
  plumes = await loadJSON("./plumes/index.json");
  await reset();
  wire();
  if (!params.has("video")) $("intro").hidden = false;
  if (params.get("until")) await runUntil(params.get("until"));
  window.plumeline.ready = true;
}

async function reset() {
  playing = false;
  sc = new Scenario(artifact, data);
  await sc.setup();
  state = await sc.read();
  drawTimeline();
  drawAll(null);
  await drawVerify();
}

async function next() {
  if (busy || sc.done) return null;
  busy = true;
  try {
    const step = await sc.step();
    state = await sc.read();
    drawAll(step);
    return step;
  } finally {
    busy = false;
  }
}

/** How much an event deserves the event card when several run at once. */
function notability(step) {
  const e = step.event;
  const logs = step.records.flatMap((r) => r.logs.map((l) => l.eventName));
  if (step.records.some((r) => !r.ok)) return 6;
  if (logs.includes("CaseOpened") || logs.includes("CaseClosed")) return 5;
  if (e.type === "cargo") return 5;
  if (logs.some((n) => n === "SatelliteEstimatePosted") && step.records[0].logs[0]?.args.discrepancy) return 4;
  if (e.type === "report" && step.flagged) return 4;
  if (e.type === "observation" && e.detected) return 3;
  if (e.type === "remediation" || e.type === "transfer") return 3;
  return 1;
}

async function runUntil(iso) {
  let best = null;
  while (!sc.done && unix(sc.events[sc.cursor].at) <= unix(iso)) {
    busy = true;
    const step = await sc.step();
    busy = false;
    if (step.event.type === "report") {
      const rep = await sc.chain.call("reports", [step.event.site, step.event.period]);
      step.flagged = rep[9];
    }
    if (!best || notability(step) >= notability(best)) best = step;
  }
  sc.chain.setTime(unix(iso));
  state = await sc.read();
  drawAll(best);
  return best;
}

async function play() {
  playing = !playing;
  $("play").textContent = playing ? "Pause" : "Play";
  while (playing && !sc.done) {
    const step = await next();
    const slow = step && (step.event.type === "cargo" || (step.event.type === "observation" && step.event.detected));
    await new Promise((r) => setTimeout(r, slow ? 2600 : 900));
  }
  playing = false;
  $("play").textContent = "Play";
}

function wire() {
  $("next").onclick = () => next();
  $("play").onclick = () => play();
  $("reset").onclick = async () => {
    $("reset").disabled = true;
    await reset();
    $("reset").disabled = false;
  };
  $("start").onclick = () => {
    $("intro").hidden = true;
    play();
  };
  drawAttacks();
}

// ---------------------------------------------------------------- timeline
function drawTimeline() {
  const el = $("timeline");
  const t0 = unix(data.start), t1 = unix(data.end);
  const x = (t) => `${((t - t0) / (t1 - t0)) * 100}%`;
  let html = "";
  for (let m = 6; m <= 10; m++) {
    const t = Date.UTC(2026, m - 1, 1) / 1000;
    html += `<span class="month" style="left:${x(t)}">${new Date(t * 1000).toLocaleString("en-GB", { month: "short", timeZone: "UTC" })}</span>`;
  }
  data.events.forEach((e, i) => {
    const cls = e.type === "cargo" ? "cargo" : e.type === "observation" && e.detected ? "det" : "";
    html += `<span class="tick ${cls}" data-i="${i}" style="left:${x(unix(e.at))}"></span>`;
  });
  html += `<span class="head" id="head" style="left:0"></span>`;
  el.innerHTML = html;
}

function drawHead() {
  const t0 = unix(data.start), t1 = unix(data.end);
  $("head").style.left = `${Math.min(100, ((state.now - t0) / (t1 - t0)) * 100)}%`;
  document.querySelectorAll(".timeline .tick").forEach((n) => n.classList.toggle("done", Number(n.dataset.i) < sc.cursor));
}

// ---------------------------------------------------------------- map
const W = 1000, Hh = 760, PLANT = [905, 700];
function siteStatus(s) {
  if (!s.openCaseId) return s.casesOpened ? "closed" : "clear";
  const c = state.cases.find((k) => k.id === s.openCaseId);
  if (c.overdue) return "overdue";
  return c.status === "Remediation claimed" ? "claimed" : "open";
}
const COLOR = { clear: "#3ddc97", closed: "#3ddc97", open: "#ff7a1a", claimed: "#ffc145", overdue: "#ff4d5e" };

function drawMap(step) {
  const svg = $("map");
  let g = `<defs><radialGradient id="glow"><stop offset="0" stop-color="#ff7a1a" stop-opacity="0.55"/><stop offset="1" stop-color="#ff7a1a" stop-opacity="0"/></radialGradient></defs>`;
  for (let i = 0; i < 14; i++) {
    g += `<path d="M0 ${40 + i * 44} C 250 ${20 + i * 44}, 520 ${80 + i * 44}, 1000 ${30 + i * 44}" stroke="#15213a" stroke-width="1" fill="none"/>`;
  }
  const hub = [820, 600];
  for (const s of state.sites) {
    const [x, y] = [s.xy[0] * W, s.xy[1] * Hh];
    g += `<path class="pipe flow" d="M${x} ${y} Q ${(x + hub[0]) / 2} ${y + 60} ${hub[0]} ${hub[1]}"/>`;
  }
  g += `<path class="pipe flow" d="M${hub[0]} ${hub[1]} L ${PLANT[0]} ${PLANT[1]}"/>`;
  g += `<rect x="${PLANT[0] - 46}" y="${PLANT[1] - 22}" width="92" height="44" rx="8" fill="#14203a" stroke="#5aa9ff" stroke-width="2"/>`;
  g += `<text x="${PLANT[0]}" y="${PLANT[1] + 5}" text-anchor="middle" class="site-label" style="font-size:14px">Coastline LNG</text>`;
  if (step && step.event.type === "observation") {
    const s = state.sites[step.event.site - 1];
    const [x, y] = [s.xy[0] * W, s.xy[1] * Hh];
    // Tanager swath (strip roughly along the track, ~30 km wide on the ground; drawn schematically)
    g += `<g transform="rotate(-14 ${x} ${y})"><rect class="swath" x="-60" y="${y - 70}" width="1120" height="140"><animate attributeName="opacity" from="1" to="0.25" dur="2.2s" fill="freeze"/></rect></g>`;
  }
  for (const s of state.sites) {
    const [x, y] = [s.xy[0] * W, s.xy[1] * Hh];
    const st = siteStatus(s);
    const hot = st === "open" || st === "overdue";
    if (hot) g += `<circle cx="${x}" cy="${y}" r="56" fill="url(#glow)"/>`;
    const isNow = step && step.event.site === s.id;
    if (isNow) g += `<circle class="ring" cx="${x}" cy="${y}" r="20" stroke="${step.event.type === "observation" && step.event.detected ? "#ff7a1a" : "#e6edf7"}"><animate attributeName="r" from="16" to="46" dur="1.4s" repeatCount="2"/><animate attributeName="opacity" from="1" to="0" dur="1.4s" repeatCount="2"/></circle>`;
    g += `<circle class="site-dot" cx="${x}" cy="${y}" r="13" fill="${COLOR[st]}" stroke="#0b1220" stroke-width="3"/>`;
    const lx = s.xy[0] > 0.75 ? x - 20 : x + 22;
    const anchor = s.xy[0] > 0.75 ? "end" : "start";
    g += `<text x="${lx}" y="${y - 4}" text-anchor="${anchor}" class="site-label">${s.name}</text>`;
    const label = { clear: "no open case", closed: "case closed by satellite", open: "super-emitter case open", claimed: "repair claimed", overdue: "case overdue" }[st];
    g += `<text x="${lx}" y="${y + 15}" text-anchor="${anchor}" class="site-sub">${s.operator} · ${label}</text>`;
  }
  g += `<text x="16" y="${Hh - 14}" class="site-sub">Positions are schematic. Each site replays the real Tanager history of one anonymized Permian source.</text>`;
  svg.innerHTML = g;
}

// ---------------------------------------------------------------- event card
function plumeFor(scene) {
  return plumes.find((p) => p.startsWith(scene));
}

function describe(step) {
  if (!step) {
    return { cls: "", when: fmtDate(state.now), what: "Contract deployed, roles granted, six sites and the persistence model registered", why: `${state.blocks.length} setup transactions in the in-browser EVM. Press Play or Next event.` };
  }
  const e = step.event;
  const r = step.records[0];
  const s = e.site ? state.sites[e.site - 1] : null;
  const pub = fmtDate(unix(e.at));
  switch (e.type) {
    case "observation": {
      const opened = r.logs.find((l) => l.eventName === "CaseOpened");
      const closed = r.logs.find((l) => l.eventName === "CaseClosed");
      const risk = step.records[1]?.logs.find((l) => l.eventName === "CaseRiskScored");
      if (e.detected) {
        const rate = e.quantified ? `${e.rateKgH.toLocaleString()} ± ${e.sigmaKgH.toLocaleString()} kg/h` : "plume seen, rate not quantified (cloud)";
        return {
          cls: "det",
          when: `Tanager overpass ${fmtDate(unix(e.t))} · published ${pub}`,
          what: `Methane plume at ${s.name}: ${rate}`,
          why: (opened ? `Above 100 kg/h, so the contract opened case #${opened.args.caseId}. ${s.operator} has 10 days to answer. ` : "The open case counts another detection. ") +
            (risk ? `Model oracle: ${(Number(risk.args.riskBps) / 100).toFixed(0)} % chance it is still emitting at the next overpass.` : ""),
          img: plumeFor(e.scene),
        };
      }
      return {
        cls: "clear",
        when: `Tanager overpass ${fmtDate(unix(e.t))} · published ${pub}`,
        what: `Clear overpass over ${s.name}`,
        why: closed ? `Nothing above the detection limit after the repair claim: the satellite closed case #${closed.args.caseId}.` : "No plume above the detection limit. Clear overpasses are evidence too, and they are the only way to close a case.",
      };
    }
    case "estimate": {
      const m = s.months[e.period];
      const what = e.estimateKg
        ? `${periodName(e.period)} satellite estimate for ${s.name}: ${tCH4(e.estimateKg)} t CH₄ (floor ${tCH4(e.lowKg)} t)`
        : `${periodName(e.period)} satellite estimate for ${s.name}: nothing above the detection limit`;
      let why;
      if (!m.gasTonnes) why = `No ${periodName(e.period)} report from ${s.operator} yet. When it arrives, the contract compares it with this floor.`;
      else if (m.discrepancy) why = `Even the conservative floor is above the ${tCH4(m.reportedKg)} t the operator reported. The month is flagged for reconciliation and cargoes now count ${tCH4(m.reconciledKg)} t.`;
      else why = `${e.d} detection(s) in ${e.n} overpass(es). The floor stays below the ${tCH4(m.reportedKg)} t reported, so the report stands.`;
      return { cls: m.discrepancy ? "alarm" : "", when: `Model oracle · ${pub}`, what, why };
    }
    case "report": {
      const m = s.months[e.period];
      return {
        cls: m.discrepancy ? "alarm" : "",
        when: `${s.operator} · ${pub}`,
        what: `${periodName(e.period)} report for ${s.name}: ${e.gasTonnes.toLocaleString()} t gas, ${tCH4(e.reportedKg)} t CH₄`,
        why: m.discrepancy
          ? `The satellite floor for ${periodName(e.period)} is already ${tCH4(m.satLowKg)} t, above this report. The month is flagged on arrival and cargoes count ${tCH4(m.reconciledKg)} t.`
          : "The report file stays off chain; its hash is on chain.",
      };
    }
    case "verify":
      return { cls: "", when: `Accredited verifier · ${pub}`, what: `${periodName(e.period)} report for ${s.name} verified`, why: "Only verified site-months can be sold into a cargo." };
    case "remediation":
      return { cls: "", when: `${s.operator} · ${pub}`, what: `Repair claimed at ${s.name}`, why: `"${e.note}". The case stays open until a later satellite overpass sees nothing.` };
    case "cargo": {
      if (!r.ok) {
        return { cls: "alarm", when: `Coastline LNG · ${pub}`, what: `Second cargo ${e.ref} refused: ${r.error.name}`, why: `It tried to sell ${e.allocations[0].tonnes.toLocaleString()} t of Alder Gas Plant's August gas. ${ERROR_TEXT[r.error.name] || ""}.` };
      }
      const c = state.cargoes.find((k) => k.ref === e.ref);
      return { cls: "cargo", when: `Coastline LNG · ${pub}`, what: `Cargo ${e.ref} loaded: ${c.tonnes.toLocaleString()} t LNG, ${pct(c.intensityPpm)} methane intensity`, why: `Built from ${c.allocations.length} verified site-months. ${c.openCasesAtMint} supplying site had an open super-emitter case at loading.` };
    }
    case "transfer":
      return { cls: "cargo", when: `${pub}`, what: `Passport for ${e.ref} transferred to the EU importer`, why: "The importer holds the token and reads the cargo's methane live from the contract." };
  }
  return { cls: "", when: pub, what: e.type, why: "" };
}

function drawEvent(step) {
  const d = describe(step);
  const card = $("eventCard");
  card.className = `event-card ${d.cls}`;
  card.innerHTML = `${d.img ? `<img src="./plumes/${d.img}" alt="Methane plume image from Carbon Mapper"/>` : ""}<div class="when">${d.when}</div><div class="what">${d.what}</div><div class="why">${d.why}</div>`;
}

// ---------------------------------------------------------------- cases
function drawCases(step) {
  const t = $("cases");
  let html = `<tr><th>Case</th><th>Site</th><th>Opened</th><th class="num">Peak kg/h</th><th class="num">Seen</th><th>Model risk</th><th>Status</th></tr>`;
  if (!state.cases.length) html += `<tr class="empty"><td colspan="7">No super-emitter detected yet</td></tr>`;
  const touched = step?.event.site;
  for (const c of state.cases) {
    const s = state.sites[c.siteId - 1];
    const st = c.status === "Closed" ? ["closed", `Closed · clear pass ${fmtShort(c.closedAt)}`] : c.status === "Remediation claimed" ? ["claimed", "Repair claimed"] : c.overdue ? ["overdue", `Overdue since ${fmtShort(c.respondBy)}`] : ["open", `Open · answer by ${fmtShort(c.respondBy)}`];
    html += `<tr class="${touched === c.siteId ? "flash" : ""}"><td>#${c.id}</td><td>${s.name}</td><td>${fmtShort(c.openedAt)}</td><td class="num">${c.peakKgH.toLocaleString()}</td><td class="num">${c.detections}</td>` +
      `<td><div class="risk"><div class="bar"><i style="width:${c.riskBps / 100}%"></i></div>${(c.riskBps / 100).toFixed(0)} %</div></td><td><span class="pill ${st[0]}">${st[1]}</span></td></tr>`;
  }
  t.innerHTML = html;
}

// ---------------------------------------------------------------- reconciliation
function drawRecon() {
  let html = `<div class="recon"><div class="h">Site</div>${data.periods.map((p) => `<div class="h">${periodName(p)} 2026</div>`).join("")}`;
  for (const s of state.sites) {
    html += `<div class="site">${s.name}<small>${s.kind}</small></div>`;
    for (const p of data.periods) {
      const m = s.months[p];
      if (!m.gasTonnes) {
        html += `<div class="cell none">not reported yet</div>`;
        continue;
      }
      const sat = m.hasEstimate ? (m.satEstimateKg ? `satellite ${tCH4(m.satEstimateKg)} · floor ${tCH4(m.satLowKg)}` : "satellite: clear") : "no satellite estimate";
      html += `<div class="cell ${m.discrepancy ? "flag" : ""}">${m.verified ? `<span class="v">verified</span>` : ""}<div class="r">reported ${tCH4(m.reportedKg)}</div><div class="s">${sat}</div>${m.discrepancy ? `<div class="s">reconciliation required → ${tCH4(m.reconciledKg)}</div>` : ""}</div>`;
    }
  }
  $("recon").innerHTML = html + "</div>";
}

// ---------------------------------------------------------------- cargo
function drawCargo() {
  const c = state.cargoes[0];
  if (!c) {
    $("cargo").innerHTML = `<div class="cargo-empty">No cargo loaded yet.<br/>Coastline LNG loads its first cargo on 12 Sep 2026.</div>`;
    return;
  }
  const limit = data.maxIntensityPpm;
  const scale = Math.max(limit * 3, c.intensityPpm * 1.1);
  const atMint = Math.floor((c.reconciledKgAtMint * 1000) / c.tonnes);
  const over = !c.withinLimit;
  const owner = ROLES[c.owner] || c.owner;
  $("cargo").innerHTML = `<div class="cargo-card">
    <div class="ref">${c.ref}</div>
    <div class="meta">${c.tonnes.toLocaleString()} t LNG · loaded ${fmtDate(c.mintedAt)} · holder: ${owner}</div>
    <div class="two"><div><small>at loading</small><span class="big ok">${pct(atMint)}</span></div><div><small>now, with later satellite evidence</small><span class="big ${over ? "over" : "ok"}">${pct(c.intensityPpm)}</span></div></div>
    <div class="gauge"><i class="${over ? "over" : ""}" style="width:${(c.intensityPpm / scale) * 100}%"></i><b style="left:${(limit / scale) * 100}%"></b></div>
    <div class="legend"><span>0</span><span>limit ${pct(limit)} (illustrative)</span><span>${pct(scale)}</span></div>
    <div class="two"><div><small>methane, as reported</small>${tCH4(c.reportedKg)} t</div><div><small>methane, reconciled now</small>${tCH4(c.reconciledKgNow)} t</div></div>
    <ul>${c.allocations.map((a) => `<li>${a.tonnes.toLocaleString()} t from ${state.sites[a.siteId - 1].name}, ${periodName(a.period)} 2026${state.sites[a.siteId - 1].months[a.period].discrepancy ? " · flagged" : ""}</li>`).join("")}</ul>
    <div class="meta" style="margin-top:8px">${over ? "Above the illustrative limit." : "Within the illustrative limit."} Open super-emitter cases at supplying sites: ${c.openCasesNow}.</div>
  </div>`;
}

// ---------------------------------------------------------------- ledger
let shown = 0;
function drawLedger() {
  const blocks = state.blocks;
  const rows = blocks.slice(-9).reverse();
  $("ledger").innerHTML = rows
    .map((b) => `<li class="${b.ok ? "" : "fail"} ${b.number > shown ? "fresh" : ""}"><span class="n">#${b.number}</span><span class="f">${b.ok ? "✓" : "✗"} ${b.fn}${b.ok ? "" : ` → ${b.error.name}`}</span><span class="w">${ROLES[b.fromLabel] || b.fromLabel}</span><span class="h">tx ${short(b.hash)} · gas ${b.gas.toLocaleString()}</span></li>`)
    .join("");
  shown = blocks.length;
  const fails = blocks.filter((b) => !b.ok).length;
  $("ledgerHint").textContent = `${blocks.length} transactions · ${fails} refused`;
}

function drawAll(step) {
  $("date").textContent = fmtDate(state.now);
  $("chainInfo").textContent = `in-browser EVM · block ${state.blocks.length} · contract ${short(sc.chain.addressHex)} · event ${sc.cursor}/${data.events.length}`;
  drawHead();
  drawMap(step);
  drawEvent(step);
  drawCases(step);
  drawRecon();
  drawCargo();
  drawLedger();
  $("next").disabled = sc.done;
}

// ---------------------------------------------------------------- attacks
const ATTACKS = [
  { label: "Alder Energy posts its own “clear” satellite overpass", run: (c) => c.send("alder", "postObservation", [1, sceneId("forged-scene"), BigInt(Number(c.now) - 3600), false, 0, 0]) },
  { label: "Coastline LNG sells Alder's August gas a second time", run: (c) => c.send("lng", "mintCargo", ["FORGED-1", [{ siteId: 1, period: 202608, tonnes: 111000n }]]) },
  { label: "The satellite oracle replays a scene it already posted", run: async (c) => {
      const o = data.events.find((e) => e.type === "observation" && e.site === 1 && unix(e.at) <= Number(c.now));
      if (!o) return c.send("satellite", "postObservation", [1, sceneId("x"), 1n, false, 0, 0]);
      return c.send("satellite", "postObservation", [1, sceneId(o.scene), BigInt(unix(o.t)), false, 0, 0]);
    } },
  { label: "Alder Energy signs off its own report", run: (c) => c.send("alder", "verifyReport", [1, 202606]) },
];

function drawAttacks() {
  const el = $("attacks");
  el.innerHTML = ATTACKS.map((a, i) => `<button data-i="${i}">${a.label}</button>`).join("") + `<div class="result" id="attackResult">Pick one. The contract decides.</div>`;
  el.querySelectorAll("button").forEach((b) => {
    b.onclick = async () => {
      if (busy) return;
      busy = true;
      try {
        const r = await ATTACKS[Number(b.dataset.i)].run(sc.chain);
        state = await sc.read();
        drawLedger();
        $("attackResult").innerHTML = r.ok ? `Accepted (tx ${short(r.hash)}).` : `<b>Refused: ${r.error.name}</b> — ${ERROR_TEXT[r.error.name] || "reverted"}. tx ${short(r.hash)}, gas ${r.gas.toLocaleString()}.`;
      } finally {
        busy = false;
      }
    };
  });
}

// ---------------------------------------------------------------- verify
async function drawVerify() {
  const buf = await (await fetch("./data/persistence_logit.json")).arrayBuffer();
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", buf))).map((b) => b.toString(16).padStart(2, "0")).join("");
  const onChain = state.modelHash.slice(2);
  const ok = digest === onChain;
  const code = await sc.chain.vm.stateManager.getCode(sc.chain.address);
  $("verify").innerHTML = `
    <p>Model file <code>data/persistence_logit.json</code>, hashed in your browser:<br/><code>${digest}</code><br/>Hash registered on chain:<br/><code>${onChain}</code><br/><span class="${ok ? "ok" : "bad"}">${ok ? "Match: the oracle's model is the published one." : "Mismatch"}</span></p>
    <p>Contract <code>${sc.chain.addressHex}</code>, ${code.length.toLocaleString()} bytes of runtime bytecode compiled from <code>contracts/Plumeline.sol</code>. Every table on this page is read back from it with <code>eth_call</code>-style calls after each transaction.</p>
    <p>Persistence model, held-out test (overpasses from 1 Mar 2026): AUC ${data.model.auc}. Details in <code>docs/MODEL_CARD.md</code>.</p>`;
}

window.plumeline = {
  ready: false,
  next,
  runUntil,
  reset,
  get state() {
    return state;
  },
  get cursor() {
    return sc.cursor;
  },
};
boot().catch((e) => {
  document.body.insertAdjacentHTML("afterbegin", `<pre style="color:#ff4d5e;padding:16px">${e.stack || e}</pre>`);
  throw e;
});
