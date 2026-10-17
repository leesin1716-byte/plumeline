// Plumeline 계약의 역할·관측·초대형 배출 사건·대사·화물 질량수지 규칙을 검증하는 Hardhat 테스트
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { anyValue } = require("@nomicfoundation/hardhat-chai-matchers/withArgs");

const DAY = 24 * 3600;
const H = (s) => ethers.encodeBytes32String(s);

async function deploy() {
  const [admin, opA, opB, verifier, satOracle, modelOracle, lng, importer, stranger] = await ethers.getSigners();
  const F = await ethers.getContractFactory("Plumeline");
  const c = await F.deploy(admin.address, 10 * DAY, 2000); // 10-day response window, 0.20 % illustrative limit
  await c.grantRole(await c.VERIFIER_ROLE(), verifier.address);
  await c.grantRole(await c.SATELLITE_ORACLE_ROLE(), satOracle.address);
  await c.grantRole(await c.MODEL_ORACLE_ROLE(), modelOracle.address);
  await c.grantRole(await c.LIQUEFIER_ROLE(), lng.address);
  await c.registerSite(opA.address, "Alder-1 gas plant", H("geo:A1"));
  await c.registerSite(opB.address, "Birch-2 compressor", H("geo:B2"));
  await c.registerModel(H("model-sha"), "data/model/persistence_logit.json");
  const now = await time.latest();
  return { c, admin, opA, opB, verifier, satOracle, modelOracle, lng, importer, stranger, now };
}

describe("Plumeline: sites and reports", function () {
  it("only the admin registers sites", async function () {
    const { c, stranger } = await deploy();
    await expect(c.connect(stranger).registerSite(stranger.address, "x", H("x"))).to.be.revertedWithCustomError(c, "AccessControlUnauthorizedAccount");
  });

  it("only the site operator reports, once per month, with a valid period", async function () {
    const { c, opA, opB } = await deploy();
    await expect(c.connect(opB).submitReport(1, 202607, 1000, 50, H("r"))).to.be.revertedWithCustomError(c, "NotSiteOperator");
    await expect(c.connect(opA).submitReport(1, 202613, 1000, 50, H("r"))).to.be.revertedWithCustomError(c, "BadPeriod");
    await expect(c.connect(opA).submitReport(1, 202607, 0, 50, H("r"))).to.be.revertedWithCustomError(c, "ZeroAmount");
    await expect(c.connect(opA).submitReport(9, 202607, 1000, 50, H("r"))).to.be.revertedWithCustomError(c, "UnknownSite");
    await expect(c.connect(opA).submitReport(1, 202607, 1000, 50, H("r"))).to.emit(c, "ReportSubmitted").withArgs(1, 202607, 1000, 50, H("r"));
    await expect(c.connect(opA).submitReport(1, 202607, 1000, 50, H("r"))).to.be.revertedWithCustomError(c, "ReportExists");
  });

  it("verification needs the verifier role, happens once and never by the operator", async function () {
    const { c, admin, opA, verifier } = await deploy();
    await c.connect(opA).submitReport(1, 202607, 1000, 50, H("r"));
    await expect(c.connect(opA).verifyReport(1, 202607)).to.be.revertedWithCustomError(c, "AccessControlUnauthorizedAccount");
    await c.grantRole(await c.VERIFIER_ROLE(), opA.address);
    await expect(c.connect(opA).verifyReport(1, 202607)).to.be.revertedWithCustomError(c, "SelfVerification");
    await expect(c.connect(verifier).verifyReport(1, 202606)).to.be.revertedWithCustomError(c, "NoReport");
    await expect(c.connect(verifier).verifyReport(1, 202607)).to.emit(c, "ReportVerified");
    await expect(c.connect(verifier).verifyReport(1, 202607)).to.be.revertedWithCustomError(c, "AlreadyVerified");
    void admin;
  });
});

describe("Plumeline: satellite observations and super-emitter cases", function () {
  it("only the satellite oracle posts, in time order, once per scene, never in the future", async function () {
    const { c, satOracle, stranger, now } = await deploy();
    await expect(c.connect(stranger).postObservation(1, H("s1"), now - 100, false, 0, 0)).to.be.revertedWithCustomError(c, "AccessControlUnauthorizedAccount");
    await c.connect(satOracle).postObservation(1, H("s1"), now - 100, false, 0, 0);
    await expect(c.connect(satOracle).postObservation(1, H("s1"), now - 50, false, 0, 0)).to.be.revertedWithCustomError(c, "SceneAlreadyPosted");
    await expect(c.connect(satOracle).postObservation(1, H("s2"), now - 200, false, 0, 0)).to.be.revertedWithCustomError(c, "ObservationOutOfOrder");
    await expect(c.connect(satOracle).postObservation(1, H("s3"), now + 10 * DAY, false, 0, 0)).to.be.revertedWithCustomError(c, "ObservationInFuture");
    // the same scene can cover two sites
    await c.connect(satOracle).postObservation(2, H("s1"), now - 100, false, 0, 0);
    expect(await c.observationCount(1)).to.equal(1n);
  });

  it("a clear overpass stores no rate", async function () {
    const { c, satOracle, now } = await deploy();
    await c.connect(satOracle).postObservation(1, H("s1"), now - 100, false, 555, 9);
    const o = await c.observation(1, 0);
    expect(o.rateKgH).to.equal(0n);
    expect(o.sigmaKgH).to.equal(0n);
  });

  it("100 kg/h is not a super-emitter, 101 kg/h opens a case", async function () {
    const { c, satOracle, now } = await deploy();
    await c.connect(satOracle).postObservation(1, H("s1"), now - 300, true, 100, 20);
    expect(await c.caseCount()).to.equal(0n);
    const tx = c.connect(satOracle).postObservation(1, H("s2"), now - 200, true, 101, 20);
    await expect(tx).to.emit(c, "CaseOpened").withArgs(1, 1, 101, anyValue);
    const mined = await ethers.provider.getBlock((await (await tx).wait()).blockNumber);
    // the response clock starts when the detection reaches the ledger, not at the (earlier) overpass time
    expect((await c.cases(1)).respondBy).to.equal(BigInt(mined.timestamp + 10 * DAY));
    expect((await c.cases(1)).openedAt).to.equal(BigInt(now - 200));
    expect((await c.sites(1)).openCaseId).to.equal(1n);
  });

  it("a case closes only after a remediation claim and a later clear overpass", async function () {
    const { c, opA, opB, satOracle, now } = await deploy();
    const t0 = now - 40 * DAY;
    await c.connect(satOracle).postObservation(1, H("s1"), t0, true, 1500, 200);
    await c.connect(satOracle).postObservation(1, H("s2"), t0 + 5 * DAY, false, 0, 0); // clear but no claim: stays open
    expect((await c.cases(1)).status).to.equal(1n);
    await expect(c.connect(opB).claimRemediation(1, H("fix"), t0 + 6 * DAY)).to.be.revertedWithCustomError(c, "NotSiteOperator");
    await expect(c.connect(opA).claimRemediation(1, H("fix"), t0 - DAY)).to.be.revertedWithCustomError(c, "RemediationBeforeDetection");
    await expect(c.connect(opB).claimRemediation(2, H("fix"), t0 + 6 * DAY)).to.be.revertedWithCustomError(c, "NoOpenCase");
    await c.connect(opA).claimRemediation(1, H("fix"), t0 + 6 * DAY);
    expect((await c.cases(1)).status).to.equal(2n);
    // the satellite still sees the plume: the claim is undone
    await expect(c.connect(satOracle).postObservation(1, H("s3"), t0 + 10 * DAY, true, 900, 150)).to.emit(c, "CaseDetection").withArgs(1, 900, 1);
    const c1 = await c.cases(1);
    expect(c1.status).to.equal(1n);
    expect(c1.detections).to.equal(2n);
    expect(c1.peakKgH).to.equal(1500n);
    await c.connect(opA).claimRemediation(1, H("fix2"), t0 + 12 * DAY);
    await expect(c.connect(satOracle).postObservation(1, H("s4"), t0 + 20 * DAY, false, 0, 0)).to.emit(c, "CaseClosed").withArgs(1, H("s4"), t0 + 20 * DAY);
    expect((await c.sites(1)).openCaseId).to.equal(0n);
    // a new detection opens a new case
    await c.connect(satOracle).postObservation(1, H("s5"), t0 + 30 * DAY, true, 300, 60);
    expect((await c.sites(1)).openCaseId).to.equal(2n);
    expect((await c.sites(1)).casesOpened).to.equal(2n);
  });

  it("an unanswered case becomes overdue after the response window", async function () {
    const { c, satOracle } = await deploy();
    const t = await time.latest();
    await c.connect(satOracle).postObservation(1, H("s1"), t, true, 700, 90);
    expect(await c.isOverdue(1)).to.equal(false);
    await time.increase(11 * DAY);
    expect(await c.isOverdue(1)).to.equal(true);
  });
});

describe("Plumeline: model oracle and monthly reconciliation", function () {
  it("risk scores are capped, need a registered model and an existing case", async function () {
    const { c, satOracle, modelOracle, now } = await deploy();
    await expect(c.connect(modelOracle).scoreCase(1, 5000, 1)).to.be.revertedWithCustomError(c, "UnknownCase");
    await c.connect(satOracle).postObservation(1, H("s1"), now - 10, true, 700, 90);
    await expect(c.connect(modelOracle).scoreCase(1, 5000, 2)).to.be.revertedWithCustomError(c, "UnknownModel");
    await c.connect(modelOracle).scoreCase(1, 65000, 1);
    expect((await c.cases(1)).riskBps).to.equal(10000n);
  });

  it("flags a month when even the satellite lower bound is above the report, and uses the estimate", async function () {
    const { c, opA, verifier, modelOracle } = await deploy();
    await c.connect(opA).submitReport(1, 202608, 180000, 40000, H("r"));
    await expect(c.connect(modelOracle).postSatelliteEstimate(1, 202608, 900000, 30000, 1)).to.emit(c, "SatelliteEstimatePosted").withArgs(1, 202608, 900000, 30000, 1, false);
    expect(await c.reconciledKg(1, 202608)).to.equal(40000n); // lower bound below the report: report stands
    await c.connect(modelOracle).postSatelliteEstimate(1, 202608, 900000, 410000, 1);
    expect((await c.reports(1, 202608)).discrepancy).to.equal(true);
    expect(await c.reconciledKg(1, 202608)).to.equal(900000n);
    await expect(c.connect(opA).resolveDiscrepancy(1, 202608, H("why"))).to.be.revertedWithCustomError(c, "AccessControlUnauthorizedAccount");
    await c.connect(verifier).resolveDiscrepancy(1, 202608, H("why"));
    expect(await c.reconciledKg(1, 202608)).to.equal(40000n);
    await expect(c.connect(verifier).resolveDiscrepancy(1, 202608, H("why"))).to.be.revertedWithCustomError(c, "NoDiscrepancy");
  });

  it("an estimate posted before the report is applied when the report arrives", async function () {
    const { c, opA, modelOracle } = await deploy();
    await c.connect(modelOracle).postSatelliteEstimate(1, 202609, 500000, 200000, 1);
    await c.connect(opA).submitReport(1, 202609, 100000, 10000, H("r"));
    expect((await c.reports(1, 202609)).discrepancy).to.equal(true);
  });

  it("a lower bound above the estimate is clamped", async function () {
    const { c, modelOracle } = await deploy();
    await c.connect(modelOracle).postSatelliteEstimate(1, 202609, 1000, 5000, 1);
    expect((await c.reports(1, 202609)).satLowKg).to.equal(1000n);
  });
});

describe("Plumeline: cargo passports", function () {
  async function withReports() {
    const ctx = await deploy();
    const { c, opA, opB, verifier } = ctx;
    await c.connect(opA).submitReport(1, 202608, 100000, 20000, H("a")); // 0.02 %
    await c.connect(opB).submitReport(2, 202608, 50000, 5000, H("b")); // 0.01 %
    await c.connect(verifier).verifyReport(1, 202608);
    return ctx;
  }

  it("needs the liquefier role and verified site-months", async function () {
    const { c, lng, stranger } = await withReports();
    await expect(c.connect(stranger).mintCargo("C1", [{ siteId: 1, period: 202608, tonnes: 10 }])).to.be.revertedWithCustomError(c, "AccessControlUnauthorizedAccount");
    await expect(c.connect(lng).mintCargo("C1", [{ siteId: 2, period: 202608, tonnes: 10 }])).to.be.revertedWithCustomError(c, "NotVerified");
    await expect(c.connect(lng).mintCargo("C1", [])).to.be.revertedWithCustomError(c, "EmptyCargo");
    await expect(c.connect(lng).mintCargo("C1", [{ siteId: 1, period: 202608, tonnes: 0 }])).to.be.revertedWithCustomError(c, "ZeroAmount");
  });

  it("stops the same tonne of gas from going into two cargoes", async function () {
    const { c, lng } = await withReports();
    await c.connect(lng).mintCargo("C1", [{ siteId: 1, period: 202608, tonnes: 70000 }]);
    await expect(c.connect(lng).mintCargo("C2", [{ siteId: 1, period: 202608, tonnes: 30001 }]))
      .to.be.revertedWithCustomError(c, "OverAllocated")
      .withArgs(1, 202608, 30000, 30001);
    // and within one cargo too
    await expect(c.connect(lng).mintCargo("C2", [{ siteId: 1, period: 202608, tonnes: 20000 }, { siteId: 1, period: 202608, tonnes: 10001 }])).to.be.revertedWithCustomError(c, "OverAllocated");
    await c.connect(lng).mintCargo("C2", [{ siteId: 1, period: 202608, tonnes: 30000 }]);
    expect((await c.reports(1, 202608)).allocatedTonnes).to.equal(100000n);
  });

  it("computes the cargo intensity, keeps the snapshot, and updates live when satellite evidence arrives", async function () {
    const { c, opB, verifier, modelOracle, satOracle, lng, importer, now } = await withReports();
    await c.connect(verifier).verifyReport(2, 202608);
    await c.connect(satOracle).postObservation(2, H("s1"), now - 10, true, 400, 50); // open case at site 2
    await expect(c.connect(lng).mintCargo("NL-2026-0917", [
      { siteId: 1, period: 202608, tonnes: 50000 },
      { siteId: 2, period: 202608, tonnes: 20000 },
      { siteId: 2, period: 202608, tonnes: 10000 },
    ])).to.emit(c, "CargoMinted").withArgs(1, "NL-2026-0917", 80000, 13000, 13000, 1);
    let m = await c.cargoMethane(1);
    expect(m.intensityPpm).to.equal(162n); // 13,000 kg / 80,000 t = 162.5 kg per 1,000 t
    expect(m.openCasesNow).to.equal(1n);
    expect(m.withinLimit).to.equal(true);
    // after loading, the model oracle shows site 2 was far above its report in August
    await c.connect(modelOracle).postSatelliteEstimate(2, 202608, 600000, 250000, 1);
    m = await c.cargoMethane(1);
    expect(m.reconciledKgNow).to.equal(10000n + 600000n * 30000n / 50000n); // site 1: 10,000 kg; site 2: 360,000 kg
    expect(m.intensityPpm).to.equal(4625n);
    expect(m.withinLimit).to.equal(false);
    const snap = await c.cargoes(1);
    expect(snap.reconciledKgAtMint).to.equal(13000n);
    // the passport is an ERC-721 the importer can hold
    await c.connect(lng).transferFrom(lng.address, importer.address, 1);
    expect(await c.ownerOf(1)).to.equal(importer.address);
    expect((await c.allocations(1)).length).to.equal(3);
    void opB;
  });
});
