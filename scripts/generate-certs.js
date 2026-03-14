import { mkdirSync, writeFileSync, existsSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import selfsigned from "selfsigned";

const __dirname = dirname(fileURLToPath(import.meta.url));
const certsDir = join(__dirname, "..", "certs");

if (!existsSync(certsDir)) {
  mkdirSync(certsDir, { recursive: true });
}

const attrs = [{ name: "commonName", value: "localhost" }];
const pems = selfsigned.generate(attrs, {
  keySize: 2048,
  days: 365,
  algorithm: "sha256",
});

writeFileSync(join(certsDir, "key.pem"), pems.private);
writeFileSync(join(certsDir, "cert.pem"), pems.cert);

console.log("Self-signed certificates created in ./certs/");
console.log("  - key.pem");
console.log("  - cert.pem");
console.log("Run: npm start");
