import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Load flower mapping from JSON and compute the best-matching flower
 * based on the user's answers. Uses weighted scoring.
 */
export function getMatchingFlower(answers) {
  const dataPath = join(__dirname, "..", "data", "flower-mapping.json");
  const data = JSON.parse(readFileSync(dataPath, "utf-8"));

  let bestFlower = null;
  let bestScore = 0;

  for (const flower of data.flowers) {
    let score = 0;
    for (const [questionId, answer] of Object.entries(answers)) {
      const weights = flower.option_weights?.[questionId];
      if (weights && typeof weights[answer] === "number") {
        score += weights[answer];
      }
    }
    if (score > bestScore) {
      bestScore = score;
      bestFlower = {
        id: flower.id,
        name: flower.name,
        description: flower.description,
        score,
      };
    }
  }

  return bestFlower;
}
