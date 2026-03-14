import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export function getQuestions() {
  const dataPath = join(__dirname, "..", "..", "data", "questions.json");
  return JSON.parse(readFileSync(dataPath, "utf-8"));
}
