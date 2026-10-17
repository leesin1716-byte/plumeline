// 컴파일된 Plumeline ABI·바이트코드와 데이터 파일을 웹 데모 폴더로 복사한다
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const art = JSON.parse(fs.readFileSync(path.join(root, "artifacts/contracts/Plumeline.sol/Plumeline.json"), "utf8"));
const outDir = path.join(root, "web/src/generated");
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, "Plumeline.json"), JSON.stringify({ abi: art.abi, bytecode: art.bytecode }));

const dataDir = path.join(root, "web/public/data");
fs.mkdirSync(dataDir, { recursive: true });
for (const [from, to] of [
  ["data/scenario.json", "scenario.json"],
  ["data/model/persistence_logit.json", "persistence_logit.json"],
  ["data/model/metrics.json", "metrics.json"],
]) {
  fs.copyFileSync(path.join(root, from), path.join(dataDir, to)); // byte-for-byte: the page re-hashes the model file
}
const runtime = (art.deployedBytecode.length - 2) / 2;
console.log(`exported ABI (${art.abi.length} entries), runtime bytecode ${runtime} bytes (EIP-170 limit 24576)`);
if (runtime > 24576) process.exit(1);
