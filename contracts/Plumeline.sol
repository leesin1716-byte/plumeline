// SPDX-License-Identifier: MIT
// 위성 메탄 관측·초대형 배출 사건·월간 보고 대사·LNG 화물 메탄 여권을 한 원장에서 관리하는 Plumeline 핵심 계약
pragma solidity ^0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

/// @title Plumeline: a methane passport for every LNG cargo
/// @notice Producers post verified monthly methane reports per site. Independent satellite oracles post every
///         overpass over a site, detection or not. A detection above 100 kg/h opens a super-emitter case that only
///         a later clear overpass can close. A model oracle posts a satellite-based monthly estimate; when even its
///         lower bound exceeds the report, the month is flagged for reconciliation and the higher figure is used.
///         An LNG plant mints a cargo passport (ERC-721) from verified site-months, with a mass balance that stops
///         the same tonne of gas from being sold into two cargoes. The cargo's methane intensity is read live, so
///         satellite evidence that arrives after loading still reaches the importer.
/// @dev    Prototype. Not audited. Thresholds that the EU has not set yet (maximum methane intensity) are
///         constructor parameters, not claims about the law.
contract Plumeline is ERC721, AccessControl {
    // ------------------------------------------------------------------ roles
    bytes32 public constant VERIFIER_ROLE = keccak256("VERIFIER_ROLE");
    bytes32 public constant SATELLITE_ORACLE_ROLE = keccak256("SATELLITE_ORACLE_ROLE");
    bytes32 public constant MODEL_ORACLE_ROLE = keccak256("MODEL_ORACLE_ROLE");
    bytes32 public constant LIQUEFIER_ROLE = keccak256("LIQUEFIER_ROLE");

    /// @notice Regulation (EU) 2024/1787, Art. 2(62): a super-emitting event emits above 100 kg of methane per hour.
    uint32 public constant SUPER_EMITTER_KG_PER_H = 100;

    // ------------------------------------------------------------------ types
    enum CaseStatus { None, Open, RemediationClaimed, Closed }

    struct Site {
        address operator;
        string name;
        bytes32 locationHash; // hash of the site polygon kept off chain
        uint32 openCaseId; // 0 when no case is open
        uint32 casesOpened;
        uint64 lastObservationAt;
        bool exists;
    }

    struct Report {
        uint64 gasTonnes; // marketed gas produced in the month (tonnes)
        uint64 reportedKg; // methane reported by the operator for the month (kg)
        uint64 allocatedTonnes; // gas already sold into cargo passports
        bytes32 evidenceHash; // hash of the OGMP 2.0 style report file
        address verifier; // zero until an accredited verifier signs
        // satellite reconciliation, posted by the model oracle
        uint64 satEstimateKg;
        uint64 satLowKg;
        uint16 modelId;
        bool hasEstimate;
        bool discrepancy; // satLowKg > reportedKg and not resolved
        bytes32 resolutionHash; // verifier-accepted explanation of a discrepancy
    }

    struct Observation {
        uint64 timestamp;
        bool detected;
        uint32 rateKgH;
        uint32 sigmaKgH;
        bytes32 sceneId; // satellite scene / plume identifier
    }

    struct Case {
        uint32 siteId;
        CaseStatus status;
        uint64 openedAt;
        uint64 respondBy;
        uint64 remediatedAt;
        uint64 closedAt;
        uint32 peakKgH;
        uint32 detections;
        uint16 riskBps; // model probability (basis points) that the source is still emitting at the next overpass
        bytes32 remediationHash;
        bytes32 closingSceneId;
    }

    struct Allocation {
        uint32 siteId;
        uint32 period; // YYYYMM
        uint64 tonnes;
    }

    struct Cargo {
        string ref;
        uint64 mintedAt;
        uint64 tonnes;
        uint64 reportedKgAtMint;
        uint64 reconciledKgAtMint;
        uint16 openCasesAtMint;
    }

    struct Model {
        bytes32 artifactHash; // sha256 of the trained model file
        string uri; // where the model card lives (repository path)
    }

    // ------------------------------------------------------------------ storage
    uint32 public siteCount;
    uint32 public caseCount;
    uint256 public cargoCount;
    uint64 public responseWindow; // seconds an operator has to answer a super-emitter case
    uint32 public maxIntensityPpm; // illustrative maximum methane intensity, kg CH4 per million kg of gas

    mapping(uint32 => Site) public sites;
    mapping(uint32 => mapping(uint32 => Report)) public reports; // siteId => YYYYMM => report
    mapping(uint32 => Observation[]) internal _observations;
    mapping(uint32 => Case) public cases;
    mapping(uint256 => Cargo) public cargoes;
    mapping(uint256 => Allocation[]) internal _allocations;
    mapping(bytes32 => bool) public sceneUsed; // (siteId, sceneId) pairs already posted
    Model[] public models;

    // ------------------------------------------------------------------ events
    event SiteRegistered(uint32 indexed siteId, address indexed operator, string name);
    event ReportSubmitted(uint32 indexed siteId, uint32 indexed period, uint64 gasTonnes, uint64 reportedKg, bytes32 evidenceHash);
    event ReportVerified(uint32 indexed siteId, uint32 indexed period, address indexed verifier);
    event ObservationPosted(uint32 indexed siteId, bytes32 indexed sceneId, uint64 timestamp, bool detected, uint32 rateKgH, uint32 sigmaKgH);
    event CaseOpened(uint32 indexed caseId, uint32 indexed siteId, uint32 rateKgH, uint64 respondBy);
    event CaseDetection(uint32 indexed caseId, uint32 rateKgH, CaseStatus status);
    event CaseRiskScored(uint32 indexed caseId, uint16 riskBps, uint16 modelId);
    event RemediationClaimed(uint32 indexed caseId, bytes32 remediationHash, uint64 remediatedAt);
    event CaseClosed(uint32 indexed caseId, bytes32 closingSceneId, uint64 closedAt);
    event ModelRegistered(uint16 indexed modelId, bytes32 artifactHash, string uri);
    event SatelliteEstimatePosted(uint32 indexed siteId, uint32 indexed period, uint64 estimateKg, uint64 lowKg, uint16 modelId, bool discrepancy);
    event DiscrepancyResolved(uint32 indexed siteId, uint32 indexed period, bytes32 resolutionHash, address indexed verifier);
    event CargoMinted(uint256 indexed cargoId, string ref, uint64 tonnes, uint64 reportedKg, uint64 reconciledKg, uint16 openCases);

    // ------------------------------------------------------------------ errors
    error UnknownSite(uint32 siteId);
    error NotSiteOperator(uint32 siteId, address caller);
    error BadPeriod(uint32 period);
    error ReportExists(uint32 siteId, uint32 period);
    error NoReport(uint32 siteId, uint32 period);
    error AlreadyVerified(uint32 siteId, uint32 period);
    error SelfVerification();
    error SceneAlreadyPosted(uint32 siteId, bytes32 sceneId);
    error ObservationOutOfOrder(uint64 last, uint64 got);
    error ObservationInFuture(uint64 got);
    error NoOpenCase(uint32 siteId);
    error UnknownCase(uint32 caseId);
    error RemediationBeforeDetection();
    error UnknownModel(uint16 modelId);
    error NoDiscrepancy(uint32 siteId, uint32 period);
    error NotVerified(uint32 siteId, uint32 period);
    error OverAllocated(uint32 siteId, uint32 period, uint64 available, uint64 requested);
    error EmptyCargo();
    error ZeroAmount();

    constructor(address admin, uint64 responseWindow_, uint32 maxIntensityPpm_) ERC721("Plumeline LNG Cargo Passport", "PLUME") {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        responseWindow = responseWindow_;
        maxIntensityPpm = maxIntensityPpm_;
    }

    // ================================================================== sites and reports

    function registerSite(address operator, string calldata name, bytes32 locationHash) external onlyRole(DEFAULT_ADMIN_ROLE) returns (uint32 siteId) {
        siteId = ++siteCount;
        sites[siteId] = Site({operator: operator, name: name, locationHash: locationHash, openCaseId: 0, casesOpened: 0, lastObservationAt: 0, exists: true});
        emit SiteRegistered(siteId, operator, name);
    }

    function submitReport(uint32 siteId, uint32 period, uint64 gasTonnes, uint64 reportedKg, bytes32 evidenceHash) external {
        Site storage s = _site(siteId);
        if (msg.sender != s.operator) revert NotSiteOperator(siteId, msg.sender);
        _checkPeriod(period);
        if (gasTonnes == 0) revert ZeroAmount();
        Report storage r = reports[siteId][period];
        if (r.gasTonnes != 0) revert ReportExists(siteId, period);
        r.gasTonnes = gasTonnes;
        r.reportedKg = reportedKg;
        r.evidenceHash = evidenceHash;
        if (r.hasEstimate) r.discrepancy = r.satLowKg > reportedKg; // estimate may arrive first
        emit ReportSubmitted(siteId, period, gasTonnes, reportedKg, evidenceHash);
    }

    function verifyReport(uint32 siteId, uint32 period) external onlyRole(VERIFIER_ROLE) {
        Report storage r = _report(siteId, period);
        if (r.verifier != address(0)) revert AlreadyVerified(siteId, period);
        if (msg.sender == sites[siteId].operator) revert SelfVerification();
        r.verifier = msg.sender;
        emit ReportVerified(siteId, period, msg.sender);
    }

    // ================================================================== satellite observations and super-emitter cases

    /// @notice Post one satellite overpass over a site. Clear overpasses matter as much as detections: they are the
    ///         only way a case can close.
    function postObservation(uint32 siteId, bytes32 sceneId, uint64 timestamp, bool detected, uint32 rateKgH, uint32 sigmaKgH)
        external
        onlyRole(SATELLITE_ORACLE_ROLE)
    {
        Site storage s = _site(siteId);
        bytes32 key = keccak256(abi.encode(siteId, sceneId));
        if (sceneUsed[key]) revert SceneAlreadyPosted(siteId, sceneId);
        if (timestamp <= s.lastObservationAt) revert ObservationOutOfOrder(s.lastObservationAt, timestamp);
        if (timestamp > block.timestamp) revert ObservationInFuture(timestamp);
        sceneUsed[key] = true;
        s.lastObservationAt = timestamp;
        if (!detected) {
            rateKgH = 0;
            sigmaKgH = 0;
        }
        _observations[siteId].push(Observation({timestamp: timestamp, detected: detected, rateKgH: rateKgH, sigmaKgH: sigmaKgH, sceneId: sceneId}));
        emit ObservationPosted(siteId, sceneId, timestamp, detected, rateKgH, sigmaKgH);

        uint32 cid = s.openCaseId;
        bool superEmitting = detected && rateKgH > SUPER_EMITTER_KG_PER_H;
        if (cid == 0) {
            if (superEmitting) {
                cid = ++caseCount;
                // the operator can only answer once the detection is published, so the clock starts now, on chain
                uint64 due = uint64(block.timestamp) + responseWindow;
                cases[cid] = Case({
                    siteId: siteId,
                    status: CaseStatus.Open,
                    openedAt: timestamp,
                    respondBy: due,
                    remediatedAt: 0,
                    closedAt: 0,
                    peakKgH: rateKgH,
                    detections: 1,
                    riskBps: 0,
                    remediationHash: bytes32(0),
                    closingSceneId: bytes32(0)
                });
                s.openCaseId = cid;
                s.casesOpened += 1;
                emit CaseOpened(cid, siteId, rateKgH, due);
            }
            return;
        }
        Case storage c = cases[cid];
        if (detected) {
            // Still emitting: count it, and a remediation claim that the satellite contradicts goes back to Open.
            c.detections += 1;
            if (rateKgH > c.peakKgH) c.peakKgH = rateKgH;
            if (c.status == CaseStatus.RemediationClaimed && timestamp > c.remediatedAt) {
                c.status = CaseStatus.Open;
                c.remediatedAt = 0;
                c.remediationHash = bytes32(0);
            }
            emit CaseDetection(cid, rateKgH, c.status);
        } else if (c.status == CaseStatus.RemediationClaimed && timestamp > c.remediatedAt) {
            c.status = CaseStatus.Closed;
            c.closedAt = timestamp;
            c.closingSceneId = sceneId;
            s.openCaseId = 0;
            emit CaseClosed(cid, sceneId, timestamp);
        }
    }

    /// @notice The operator states the repair. The case stays open until a later clear overpass confirms it.
    function claimRemediation(uint32 siteId, bytes32 remediationHash, uint64 remediatedAt) external {
        Site storage s = _site(siteId);
        if (msg.sender != s.operator) revert NotSiteOperator(siteId, msg.sender);
        uint32 cid = s.openCaseId;
        if (cid == 0) revert NoOpenCase(siteId);
        Case storage c = cases[cid];
        if (remediatedAt < c.openedAt || remediatedAt > block.timestamp) revert RemediationBeforeDetection();
        c.status = CaseStatus.RemediationClaimed;
        c.remediatedAt = remediatedAt;
        c.remediationHash = remediationHash;
        emit RemediationClaimed(cid, remediationHash, remediatedAt);
    }

    // ================================================================== model oracle: risk scores and monthly reconciliation

    function registerModel(bytes32 artifactHash, string calldata uri) external onlyRole(DEFAULT_ADMIN_ROLE) returns (uint16 modelId) {
        models.push(Model({artifactHash: artifactHash, uri: uri}));
        modelId = uint16(models.length);
        emit ModelRegistered(modelId, artifactHash, uri);
    }

    /// @notice The model's probability that the source is still emitting at the next overpass. Advisory: it ranks
    ///         cases, it never opens or closes one.
    function scoreCase(uint32 caseId, uint16 riskBps, uint16 modelId) external onlyRole(MODEL_ORACLE_ROLE) {
        _model(modelId);
        Case storage c = cases[caseId];
        if (c.status == CaseStatus.None) revert UnknownCase(caseId);
        c.riskBps = riskBps > 10_000 ? 10_000 : riskBps;
        emit CaseRiskScored(caseId, c.riskBps, modelId);
    }

    /// @notice Satellite-based estimate of the month's methane (kg) with a conservative lower bound. If even the
    ///         lower bound is above the operator's report, the month needs reconciliation (Regulation (EU) 2024/1787,
    ///         Art. 2(63)) and cargoes use the satellite estimate until a verifier accepts an explanation.
    function postSatelliteEstimate(uint32 siteId, uint32 period, uint64 estimateKg, uint64 lowKg, uint16 modelId) external onlyRole(MODEL_ORACLE_ROLE) {
        _site(siteId);
        _checkPeriod(period);
        _model(modelId);
        Report storage r = reports[siteId][period];
        if (lowKg > estimateKg) lowKg = estimateKg;
        r.satEstimateKg = estimateKg;
        r.satLowKg = lowKg;
        r.modelId = modelId;
        r.hasEstimate = true;
        r.resolutionHash = bytes32(0);
        r.discrepancy = r.gasTonnes != 0 && lowKg > r.reportedKg;
        emit SatelliteEstimatePosted(siteId, period, estimateKg, lowKg, modelId, r.discrepancy);
    }

    function resolveDiscrepancy(uint32 siteId, uint32 period, bytes32 resolutionHash) external onlyRole(VERIFIER_ROLE) {
        Report storage r = _report(siteId, period);
        if (!r.discrepancy) revert NoDiscrepancy(siteId, period);
        if (msg.sender == sites[siteId].operator) revert SelfVerification();
        r.discrepancy = false;
        r.resolutionHash = resolutionHash;
        emit DiscrepancyResolved(siteId, period, resolutionHash, msg.sender);
    }

    /// @notice Methane counted for the month: the report, or the satellite estimate while a discrepancy stands.
    function reconciledKg(uint32 siteId, uint32 period) public view returns (uint64) {
        Report storage r = reports[siteId][period];
        if (r.discrepancy && r.satEstimateKg > r.reportedKg) return r.satEstimateKg;
        return r.reportedKg;
    }

    // ================================================================== cargo passports

    /// @notice Mint a cargo passport from verified site-months. Each tonne can be allocated once.
    function mintCargo(string calldata ref, Allocation[] calldata allocs) external onlyRole(LIQUEFIER_ROLE) returns (uint256 cargoId) {
        if (allocs.length == 0) revert EmptyCargo();
        cargoId = ++cargoCount;
        uint64 tonnes;
        uint256 reported;
        uint256 reconciled;
        uint16 openCases;
        for (uint256 i = 0; i < allocs.length; i++) {
            Allocation calldata a = allocs[i];
            if (a.tonnes == 0) revert ZeroAmount();
            Report storage r = _report(a.siteId, a.period);
            if (r.verifier == address(0)) revert NotVerified(a.siteId, a.period);
            uint64 available = r.gasTonnes - r.allocatedTonnes;
            if (a.tonnes > available) revert OverAllocated(a.siteId, a.period, available, a.tonnes);
            r.allocatedTonnes += a.tonnes;
            tonnes += a.tonnes;
            reported += uint256(r.reportedKg) * a.tonnes / r.gasTonnes;
            reconciled += uint256(reconciledKg(a.siteId, a.period)) * a.tonnes / r.gasTonnes;
            if (sites[a.siteId].openCaseId != 0 && !_counted(allocs, i)) openCases += 1;
            _allocations[cargoId].push(a);
        }
        cargoes[cargoId] = Cargo({
            ref: ref,
            mintedAt: uint64(block.timestamp),
            tonnes: tonnes,
            reportedKgAtMint: uint64(reported),
            reconciledKgAtMint: uint64(reconciled),
            openCasesAtMint: openCases
        });
        _safeMint(msg.sender, cargoId);
        emit CargoMinted(cargoId, ref, tonnes, uint64(reported), uint64(reconciled), openCases);
    }

    /// @notice Live view of a cargo: methane as reported, as reconciled today, and the intensity in ppm of gas mass.
    function cargoMethane(uint256 cargoId)
        external
        view
        returns (uint64 tonnes, uint64 reportedKg, uint64 reconciledKgNow, uint32 intensityPpm, uint16 openCasesNow, bool withinLimit)
    {
        _requireOwned(cargoId);
        Allocation[] storage al = _allocations[cargoId];
        uint256 rep;
        uint256 rec;
        for (uint256 i = 0; i < al.length; i++) {
            Report storage r = reports[al[i].siteId][al[i].period];
            rep += uint256(r.reportedKg) * al[i].tonnes / r.gasTonnes;
            rec += uint256(reconciledKg(al[i].siteId, al[i].period)) * al[i].tonnes / r.gasTonnes;
            if (sites[al[i].siteId].openCaseId != 0 && !_countedStorage(al, i)) openCasesNow += 1;
        }
        tonnes = cargoes[cargoId].tonnes;
        reportedKg = uint64(rep);
        reconciledKgNow = uint64(rec);
        // kg CH4 per 1,000,000 kg of gas = kg per 1,000 t
        intensityPpm = uint32(rec * 1000 / tonnes);
        withinLimit = intensityPpm <= maxIntensityPpm;
    }

    // ================================================================== reads

    function observationCount(uint32 siteId) external view returns (uint256) {
        return _observations[siteId].length;
    }

    function observation(uint32 siteId, uint256 i) external view returns (Observation memory) {
        return _observations[siteId][i];
    }

    function allocations(uint256 cargoId) external view returns (Allocation[] memory) {
        return _allocations[cargoId];
    }

    function modelCount() external view returns (uint256) {
        return models.length;
    }

    /// @notice A case past its response deadline without a remediation claim.
    function isOverdue(uint32 caseId) external view returns (bool) {
        Case storage c = cases[caseId];
        return c.status == CaseStatus.Open && block.timestamp > c.respondBy;
    }

    function supportsInterface(bytes4 interfaceId) public view override(ERC721, AccessControl) returns (bool) {
        return super.supportsInterface(interfaceId);
    }

    // ================================================================== internals

    function _site(uint32 siteId) internal view returns (Site storage s) {
        s = sites[siteId];
        if (!s.exists) revert UnknownSite(siteId);
    }

    function _report(uint32 siteId, uint32 period) internal view returns (Report storage r) {
        r = reports[siteId][period];
        if (r.gasTonnes == 0) revert NoReport(siteId, period);
    }

    function _model(uint16 modelId) internal view {
        if (modelId == 0 || modelId > models.length) revert UnknownModel(modelId);
    }

    function _checkPeriod(uint32 period) internal pure {
        uint32 m = period % 100;
        if (period < 202001 || period > 209912 || m == 0 || m > 12) revert BadPeriod(period);
    }

    /// @dev True when allocs[i].siteId already appeared earlier in the list (count each site's open case once).
    function _counted(Allocation[] calldata allocs, uint256 i) internal pure returns (bool) {
        for (uint256 j = 0; j < i; j++) if (allocs[j].siteId == allocs[i].siteId) return true;
        return false;
    }

    function _countedStorage(Allocation[] storage al, uint256 i) internal view returns (bool) {
        for (uint256 j = 0; j < i; j++) if (al[j].siteId == al[i].siteId) return true;
        return false;
    }
}
