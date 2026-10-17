// 시나리오 사건 목록을 Plumeline 계약 거래로 바꿔 날짜순으로 실행하고 화면용 상태를 읽어 오는 모듈
import { keccak256, toHex } from "viem";
import { Chain } from "./chain.js";

export const ROLES = {
  regulator: "Registry admin",
  alder: "Alder Energy",
  birch: "Birch Petroleum",
  cedar: "Cedar Midstream",
  verifier: "Accredited verifier",
  satellite: "Satellite oracle",
  model: "Model oracle",
  lng: "Coastline LNG",
  importer: "EU importer",
};
const OPERATOR_LABEL = { "Alder Energy": "alder", "Birch Petroleum": "birch", "Cedar Midstream": "cedar" };
const PERIOD_NAMES = { 202606: "Jun", 202607: "Jul", 202608: "Aug" };

export const unix = (iso) => Math.floor(Date.parse(iso) / 1000);
export const sceneId = (name) => keccak256(toHex(name));
export const textHash = (s) => keccak256(toHex(s));
export const periodName = (p) => PERIOD_NAMES[p] || String(p);

export class Scenario {
  constructor(artifact, scenario, model) {
    this.artifact = artifact;
    this.s = scenario;
    this.model = model;
    this.cursor = 0;
    this.cargoIds = {}; // ref -> token id
    this.narration = [];
  }

  get events() {
    return this.s.events;
  }

  get done() {
    return this.cursor >= this.s.events.length;
  }

  operatorOf(siteId) {
    return OPERATOR_LABEL[this.s.sites[siteId - 1].operator];
  }

  async setup() {
    const chain = new Chain(this.artifact.abi, this.artifact.bytecode);
    await chain.init(Object.keys(ROLES).concat(["intruder"]), unix(this.s.start));
    this.chain = chain;
    await chain.deploy("regulator", [chain.accounts.regulator.hex, BigInt(this.s.responseWindowDays * 86400), this.s.maxIntensityPpm]);
    const role = async (name) => chain.call(name);
    const grants = [
      ["VERIFIER_ROLE", "verifier"],
      ["SATELLITE_ORACLE_ROLE", "satellite"],
      ["MODEL_ORACLE_ROLE", "model"],
      ["LIQUEFIER_ROLE", "lng"],
    ];
    for (const [r, who] of grants) await chain.send("regulator", "grantRole", [await role(r), chain.accounts[who].hex]);
    for (const site of this.s.sites) {
      await chain.send("regulator", "registerSite", [chain.accounts[OPERATOR_LABEL[site.operator]].hex, site.name, textHash(`polygon:${site.key}`)]);
    }
    await chain.send("regulator", "registerModel", [`0x${this.s.model.sha256}`, this.s.model.uri]);
    this.setupBlocks = chain.blocks.length;
    return chain;
  }

  /** Run the next scenario event as one or more transactions. Returns {event, records}. */
  async step() {
    const e = this.s.events[this.cursor++];
    const c = this.chain;
    c.setTime(unix(e.at));
    const recs = [];
    const site = e.site ? this.s.sites[e.site - 1] : null;
    switch (e.type) {
      case "observation": {
        const before = (await c.call("sites", [e.site]))[3];
        recs.push(await c.send("satellite", "postObservation", [e.site, sceneId(e.scene), BigInt(unix(e.t)), e.detected, e.rateKgH, e.sigmaKgH]));
        const after = (await c.call("sites", [e.site]))[3];
        const caseId = after || before;
        if (e.detected && caseId && e.riskNext != null) {
          recs.push(await c.send("model", "scoreCase", [caseId, Math.round(e.riskNext * 10000), 1]));
        }
        break;
      }
      case "estimate":
        recs.push(await c.send("model", "postSatelliteEstimate", [e.site, e.period, BigInt(e.estimateKg), BigInt(e.lowKg), 1]));
        break;
      case "report":
        recs.push(await c.send(this.operatorOf(e.site), "submitReport", [e.site, e.period, BigInt(e.gasTonnes), BigInt(e.reportedKg), textHash(`report:${site.key}:${e.period}`)]));
        break;
      case "verify":
        recs.push(await c.send("verifier", "verifyReport", [e.site, e.period]));
        break;
      case "remediation":
        recs.push(await c.send(this.operatorOf(e.site), "claimRemediation", [e.site, textHash(e.note), BigInt(unix(e.repairedAt))]));
        break;
      case "cargo": {
        const allocs = e.allocations.map((a) => ({ siteId: a.site, period: a.period, tonnes: BigInt(a.tonnes) }));
        const r = await c.send("lng", "mintCargo", [e.ref, allocs]);
        recs.push(r);
        if (r.ok) this.cargoIds[e.ref] = Number(await c.call("cargoCount"));
        break;
      }
      case "transfer": {
        const id = this.cargoIds[e.ref];
        recs.push(await c.send("lng", "transferFrom", [c.accounts.lng.hex, c.accounts.importer.hex, BigInt(id)]));
        break;
      }
      default:
        throw new Error(`unknown event type ${e.type}`);
    }
    return { event: e, records: recs };
  }

  async runUntil(iso) {
    const out = [];
    while (!this.done && unix(this.s.events[this.cursor].at) <= unix(iso)) out.push(await this.step());
    return out;
  }

  /** Everything the screen shows, read back from the contract. */
  async read() {
    const c = this.chain;
    const sites = [];
    for (const meta of this.s.sites) {
      const r = await c.call("sites", [meta.id]);
      const months = {};
      for (const p of this.s.periods) {
        const rep = await c.call("reports", [meta.id, p]);
        months[p] = {
          gasTonnes: Number(rep[0]),
          reportedKg: Number(rep[1]),
          allocatedTonnes: Number(rep[2]),
          verified: rep[4] !== "0x0000000000000000000000000000000000000000",
          satEstimateKg: Number(rep[5]),
          satLowKg: Number(rep[6]),
          hasEstimate: rep[8],
          discrepancy: rep[9],
          reconciledKg: Number(await c.call("reconciledKg", [meta.id, p])),
        };
      }
      const nObs = Number(await c.call("observationCount", [meta.id]));
      const obs = [];
      for (let i = 0; i < nObs; i++) {
        const o = await c.call("observation", [meta.id, BigInt(i)]);
        obs.push({ t: Number(o.timestamp), detected: o.detected, rate: Number(o.rateKgH), sigma: Number(o.sigmaKgH) });
      }
      sites.push({ ...meta, openCaseId: Number(r[3]), casesOpened: Number(r[4]), lastObservationAt: Number(r[5]), months, obs });
    }
    const caseCount = Number(await c.call("caseCount"));
    const cases = [];
    for (let i = 1; i <= caseCount; i++) {
      const k = await c.call("cases", [i]);
      cases.push({
        id: i,
        siteId: Number(k[0]),
        status: ["None", "Open", "Remediation claimed", "Closed"][Number(k[1])],
        openedAt: Number(k[2]),
        respondBy: Number(k[3]),
        remediatedAt: Number(k[4]),
        closedAt: Number(k[5]),
        peakKgH: Number(k[6]),
        detections: Number(k[7]),
        riskBps: Number(k[8]),
        overdue: await c.call("isOverdue", [i]),
      });
    }
    const cargoCount = Number(await c.call("cargoCount"));
    const cargoes = [];
    for (let i = 1; i <= cargoCount; i++) {
      const k = await c.call("cargoes", [BigInt(i)]);
      const m = await c.call("cargoMethane", [BigInt(i)]);
      const owner = await c.call("ownerOf", [BigInt(i)]);
      const allocs = await c.call("allocations", [BigInt(i)]);
      cargoes.push({
        id: i,
        ref: k[0],
        mintedAt: Number(k[1]),
        tonnes: Number(k[2]),
        reportedKgAtMint: Number(k[3]),
        reconciledKgAtMint: Number(k[4]),
        openCasesAtMint: Number(k[5]),
        reportedKg: Number(m[1]),
        reconciledKgNow: Number(m[2]),
        intensityPpm: Number(m[3]),
        openCasesNow: Number(m[4]),
        withinLimit: m[5],
        owner: Object.entries(c.accounts).find(([, a]) => a.hex.toLowerCase() === owner.toLowerCase())?.[0] ?? owner,
        allocations: allocs.map((a) => ({ siteId: Number(a.siteId), period: Number(a.period), tonnes: Number(a.tonnes) })),
      });
    }
    const model = await c.call("models", [0n]);
    return { now: Number(c.now), sites, cases, cargoes, modelHash: model[0], modelUri: model[1], blocks: c.blocks };
  }
}
