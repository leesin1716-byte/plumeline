// 웹 데모와 같은 코드(브라우저 EVM 래퍼·시나리오)를 Node 에서 끝까지 돌려 이야기의 핵심 결과를 검사한다
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";
import { Scenario } from "../web/src/scenario.js";

const root = join(import.meta.dirname, "..");
const artifact = JSON.parse(readFileSync(join(root, "web/src/generated/Plumeline.json"), "utf8"));
const scenario = JSON.parse(readFileSync(join(root, "data/scenario.json"), "utf8"));

const sc = new Scenario(artifact, scenario);
await sc.setup();
const snapshots = {};
while (!sc.done) {
  const { event, records } = await sc.step();
  for (const r of records) {
    const expected = event.expectRevert;
    if (expected) assert.equal(r.error?.name, expected, `${event.type} at ${event.at} should revert with ${expected}`);
    else assert.ok(r.ok, `${event.type} at ${event.at} failed: ${r.error?.name}`);
  }
  if (event.type === "cargo" && !event.expectRevert) snapshots.atMint = (await sc.read()).cargoes[0];
}
sc.chain.setTime(Date.parse(scenario.end) / 1000);
const s = await sc.read();
const cargo = s.cargoes[0];
const status = (id) => s.cases.find((c) => c.siteId === id)?.status;

assert.equal(s.cases.length, 3, "three super-emitter cases");
assert.equal(status(1), "Open", "Alder Gas Plant: no repair, case stays open");
assert.equal(status(2), "Closed", "Alder Compressor 7: closed by a clear overpass after the repair claim");
assert.equal(status(3), "Closed", "Birch Wellpad Hub: closed by a clear overpass after the repair claim");
assert.ok(s.cases.find((c) => c.siteId === 1).overdue, "Alder Gas Plant case is overdue");
assert.ok(s.sites[0].months[202608].discrepancy, "Alder Gas Plant August flagged");
assert.ok(snapshots.atMint.withinLimit, "cargo looked fine at loading");
assert.ok(!cargo.withinLimit, "cargo is above the illustrative limit once August evidence arrives");
assert.equal(cargo.owner, "importer");
const gas = s.blocks.reduce((a, b) => a + b.gas, 0);
const summary = {
  transactions: s.blocks.length,
  refused: s.blocks.filter((b) => !b.ok).map((b) => `${b.fn}:${b.error.name}`),
  gasTotal: gas,
  cases: s.cases.map((c) => ({ id: c.id, site: c.siteId, status: c.status, peakKgH: c.peakKgH, detections: c.detections, riskBps: c.riskBps, overdue: c.overdue })),
  flagged: s.sites.flatMap((x) => scenario.periods.filter((p) => x.months[p].discrepancy).map((p) => `${x.name} ${p}: reported ${x.months[p].reportedKg} kg, reconciled ${x.months[p].reconciledKg} kg`)),
  cargoAtMint: { intensityPpm: snapshots.atMint.intensityPpm, reconciledKg: snapshots.atMint.reconciledKgNow },
  cargoNow: { intensityPpm: cargo.intensityPpm, reconciledKg: cargo.reconciledKgNow, reportedKg: cargo.reportedKg, openCasesNow: cargo.openCasesNow },
  gasByFunction: Object.fromEntries(
    Object.entries(s.blocks.reduce((m, b) => ((m[b.fn] ??= []).push(b.gas), m), {})).map(([k, v]) => [k, { calls: v.length, max: Math.max(...v), mean: Math.round(v.reduce((a, b) => a + b, 0) / v.length) }]),
  ),
};
writeFileSync(join(root, "data/replay_summary.json"), JSON.stringify(summary, null, 1));
console.log(JSON.stringify(summary, null, 1));
console.log("replay OK");
