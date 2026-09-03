const nodeCrypto = require("node:crypto");

const CryptoDigestAlgorithm = { SHA256: "SHA-256" };

async function digest(_algorithm, data) {
  const hash = nodeCrypto.createHash("sha256").update(Buffer.from(data)).digest();
  return hash.buffer.slice(hash.byteOffset, hash.byteOffset + hash.byteLength);
}

module.exports = {
  CryptoDigestAlgorithm,
  CryptoEncoding: { HEX: "hex", BASE64: "base64" },
  digest,
};