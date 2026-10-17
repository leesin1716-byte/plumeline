// 브라우저 안 EVM(ethereumjs)으로 Plumeline 계약을 배포·호출하고 거래 기록을 남기는 얇은 체인 래퍼
import { createVM, runTx } from "@ethereumjs/vm";
import { createLegacyTx } from "@ethereumjs/tx";
import { createBlock } from "@ethereumjs/block";
import { Common, Mainnet, Hardfork } from "@ethereumjs/common";
import { createAccount, createAddressFromPrivateKey, createAddressFromString, bytesToHex, hexToBytes } from "@ethereumjs/util";
import { encodeFunctionData, decodeFunctionResult, decodeEventLog, decodeErrorResult, encodeDeployData, keccak256, toHex } from "viem";

/** Demo keys derived from public strings. They hold value only inside this page's EVM. Never use them anywhere else. */
export function demoKey(label) {
  return hexToBytes(keccak256(toHex(`plumeline-demo-key:${label}`)));
}

export class Chain {
  constructor(abi, bytecode) {
    this.abi = abi;
    this.bytecode = bytecode;
    this.common = new Common({ chain: Mainnet, hardfork: Hardfork.Cancun });
    this.blocks = []; // one transaction per block: {number, timestamp, hash, tx}
    this.accounts = {}; // label -> {key, address}
    this.reader = createAddressFromString("0x000000000000000000000000000000000000dEaD");
  }

  async init(labels, genesisTime) {
    this.vm = await createVM({ common: this.common });
    for (const label of labels) {
      const key = demoKey(label);
      const address = createAddressFromPrivateKey(key);
      await this.vm.stateManager.putAccount(address, createAccount({ nonce: 0n, balance: 10n ** 24n }));
      this.accounts[label] = { key, address, hex: address.toString() };
    }
    this.now = BigInt(genesisTime);
  }

  setTime(unixSeconds) {
    const t = BigInt(unixSeconds);
    if (t > this.now) this.now = t;
  }

  block() {
    return createBlock(
      { header: { number: BigInt(this.blocks.length + 1), timestamp: this.now, gasLimit: 60_000_000n, baseFeePerGas: 7n, coinbase: this.reader } },
      { common: this.common, setHardfork: false },
    );
  }

  async _send(label, to, data, meta) {
    const acct = this.accounts[label];
    const nonce = (await this.vm.stateManager.getAccount(acct.address)).nonce;
    const tx = createLegacyTx({ nonce, gasPrice: 1_000_000_000n, gasLimit: 15_000_000n, to, data }, { common: this.common }).sign(acct.key);
    const block = this.block();
    const res = await runTx(this.vm, { tx, block, skipBlockGasLimitValidation: true });
    const failed = !!res.execResult.exceptionError;
    let error = null;
    if (failed) {
      const ret = bytesToHex(res.execResult.returnValue);
      try {
        const e = decodeErrorResult({ abi: this.abi, data: ret });
        error = { name: e.errorName, args: e.args };
      } catch {
        error = { name: res.execResult.exceptionError.error || "reverted", args: [] };
      }
    }
    const logs = failed
      ? []
      : res.receipt.logs.map(([, topics, d]) => {
          try {
            return decodeEventLog({ abi: this.abi, topics: topics.map(bytesToHex), data: bytesToHex(d) });
          } catch {
            return { eventName: "unknown", args: {} };
          }
        });
    const record = {
      number: this.blocks.length + 1,
      timestamp: Number(this.now),
      blockHash: bytesToHex(block.hash()),
      hash: bytesToHex(tx.hash()),
      from: acct.hex,
      fromLabel: label,
      gas: Number(res.totalGasSpent),
      ok: !failed,
      error,
      logs,
      createdAddress: res.createdAddress ? res.createdAddress.toString() : null,
      ...meta,
    };
    this.blocks.push(record);
    return record;
  }

  async deploy(label, args) {
    const data = encodeDeployData({ abi: this.abi, bytecode: this.bytecode, args });
    const r = await this._send(label, undefined, hexToBytes(data), { fn: "deploy", args });
    if (!r.ok) throw new Error(`deploy failed: ${r.error?.name}`);
    this.address = createAddressFromString(r.createdAddress);
    this.addressHex = r.createdAddress;
    return r;
  }

  async send(label, fn, args = []) {
    const data = encodeFunctionData({ abi: this.abi, functionName: fn, args });
    return this._send(label, this.address, hexToBytes(data), { fn, args });
  }

  /** Read-only call against the current state; any state change is rolled back. */
  async call(fn, args = []) {
    const data = encodeFunctionData({ abi: this.abi, functionName: fn, args });
    await this.vm.stateManager.checkpoint();
    try {
      const res = await this.vm.evm.runCall({ to: this.address, caller: this.reader, origin: this.reader, data: hexToBytes(data), block: this.block(), gasLimit: 30_000_000n });
      if (res.execResult.exceptionError) throw new Error(`${fn} reverted`);
      return decodeFunctionResult({ abi: this.abi, functionName: fn, data: bytesToHex(res.execResult.returnValue) });
    } finally {
      await this.vm.stateManager.revert();
    }
  }
}
