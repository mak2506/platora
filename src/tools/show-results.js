import { getMatchingFlower } from "../scoring.js";

export function formatResults(answers) {
  const flower = getMatchingFlower(answers);
  if (!flower) {
    return "Unable to determine your flower match. Please ensure you've answered all questions via `submit_answers` and try again.";
  }
  return `Your flower match: **${flower.name}** 🌸

${flower.description}

Thank you for taking the Fluduro quiz! You can call \`end\` when you're done.`;
}
